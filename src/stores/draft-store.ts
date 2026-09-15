/**
 * Draft persistence for the multi-user web service. Each user owns a folder:
 *
 *   drafts/{owner}/{draftId}.json      (owner = 登录标识:邮箱或用户名)
 *
 * Two backends behind one interface — fs for local dev, S3 for deployment
 * (bootstrap picks by AJT_S3_BUCKET). The web UI itself is the preview, so
 * stores persist JSON only; the CLI keeps its own single-user fs+markdown
 * path in core/draft-files.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertDraftId, draftBaseName } from "../core/draft-files.js";
import { invalid, isAppError } from "../core/errors.js";
import { DraftFileSchema, type DraftFile } from "../core/schema.js";
import { atomicWrite } from "../utils/fs.js";
import { isNoSuchKey, s3Error } from "./s3-errors.js";
import { ACCOUNT_ID_RE } from "./user-store.js";

export interface DraftListEntry {
  id: string;
  /** 记录归属者(登录邮箱) — admin 全员视图靠它标识与筛选。 */
  owner: string;
  draft: DraftFile;
}

export interface DraftStore {
  list(owner: string): Promise<DraftListEntry[]>;
  /** Every user's drafts, newest first — the admin cross-user history view. */
  listAll(): Promise<DraftListEntry[]>;
  read(owner: string, id: string): Promise<DraftFile>;
  /**
   * 新建时省略 id（从内容推导一个可读的名字）；更新已有记录必须把原 id 传进来 ——
   * 推导名依赖首票标题，改标题再保存会算出新 id，等于凭空多一条记录、旧的还留着。
   */
  write(owner: string, draft: DraftFile, id?: string): Promise<{ id: string }>;
  delete(owner: string, id: string): Promise<void>;
}

/** Owner 就是账号标识(邮箱或用户名);该正则同时排除路径穿越。 */
export function assertOwner(owner: string): void {
  if (!ACCOUNT_ID_RE.test(owner)) throw new Error(`非法的用户标识: ${owner}`);
}

const byNewest = (a: DraftListEntry, b: DraftListEntry): number =>
  b.draft.meta.createdAt.localeCompare(a.draft.meta.createdAt);

// ─── Filesystem backend (local development) ─────────────────────────────────

export class FsDraftStore implements DraftStore {
  constructor(private readonly rootDir: string) {}

  private dir(owner: string): string {
    assertOwner(owner);
    return join(this.rootDir, owner);
  }

  async list(owner: string): Promise<DraftListEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.dir(owner));
    } catch {
      return [];
    }
    const entries: DraftListEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const draft = DraftFileSchema.parse(JSON.parse(await readFile(join(this.dir(owner), f), "utf-8")));
        entries.push({ id: f.slice(0, -".json".length), owner, draft });
      } catch {
        // corrupt or foreign file — history must still render
      }
    }
    return entries.sort(byNewest);
  }

  async listAll(): Promise<DraftListEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const perOwner = await Promise.all(names.filter((n) => ACCOUNT_ID_RE.test(n)).map((owner) => this.list(owner)));
    return perOwner.flat().sort(byNewest);
  }

  async read(owner: string, id: string): Promise<DraftFile> {
    assertDraftId(id);
    let raw: string;
    try {
      raw = await readFile(join(this.dir(owner), `${id}.json`), "utf-8");
    } catch {
      throw invalid("draft_not_found", `草稿 ${id} 不存在`);
    }
    return DraftFileSchema.parse(JSON.parse(raw));
  }

  async write(owner: string, draft: DraftFile, id = draftBaseName(draft)): Promise<{ id: string }> {
    assertDraftId(id);
    await mkdir(this.dir(owner), { recursive: true });
    await atomicWrite(join(this.dir(owner), `${id}.json`), JSON.stringify(draft, null, 2) + "\n");
    return { id };
  }

  async delete(owner: string, id: string): Promise<void> {
    assertDraftId(id);
    await rm(join(this.dir(owner), `${id}.json`), { force: true });
  }
}

// ─── S3 backend (deployment) ────────────────────────────────────────────────

export class S3DraftStore implements DraftStore {
  private readonly s3: S3Client;

  /** Region/credentials resolve from the environment (instance role or env vars). */
  constructor(
    private readonly bucket: string,
    s3?: S3Client,
  ) {
    this.s3 = s3 ?? new S3Client({});
  }

  private key(owner: string, id: string): string {
    assertOwner(owner);
    assertDraftId(id);
    return `drafts/${owner}/${id}.json`;
  }

  async list(owner: string): Promise<DraftListEntry[]> {
    assertOwner(owner);
    return this.listByPrefix(`drafts/${owner}/`);
  }

  async listAll(): Promise<DraftListEntry[]> {
    return this.listByPrefix("drafts/");
  }

  /**
   * List keys then fetch each object. N+1 reads by design: per-user volumes
   * are tens of small documents, which is far simpler and more reliable than
   * maintaining an index object.
   */
  private async listByPrefix(prefix: string): Promise<DraftListEntry[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      let page;
      try {
        page = await this.s3.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
        );
      } catch (err) {
        throw s3Error(err, `ListObjectsV2 ${prefix}`);
      }
      for (const o of page.Contents ?? []) if (o.Key?.endsWith(".json")) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    const entries = await Promise.all(
      keys.map(async (key): Promise<DraftListEntry | null> => {
        const m = /^drafts\/([^/]+)\/(.+)\.json$/.exec(key);
        if (!m) return null;
        try {
          return { id: m[2], owner: m[1], draft: await this.getObject(key) };
        } catch {
          return null; // corrupt object — history must still render
        }
      }),
    );
    return entries.filter((e): e is DraftListEntry => e !== null).sort(byNewest);
  }

  private async getObject(key: string): Promise<DraftFile> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = await r.Body?.transformToString();
    if (!body) throw new Error(`S3 对象为空: ${key}`);
    return DraftFileSchema.parse(JSON.parse(body));
  }

  async read(owner: string, id: string): Promise<DraftFile> {
    const key = this.key(owner, id);
    try {
      return await this.getObject(key);
    } catch (err) {
      if (isNoSuchKey(err)) throw invalid("draft_not_found", `草稿 ${id} 不存在`);
      if (isAppError(err)) throw err; // 已分类的(空对象/结构不合法)照原样上抛
      throw s3Error(err, `GetObject ${key}`);
    }
  }

  async write(owner: string, draft: DraftFile, id = draftBaseName(draft)): Promise<{ id: string }> {
    const key = this.key(owner, id);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: JSON.stringify(draft, null, 2) + "\n",
          ContentType: "application/json; charset=utf-8",
        }),
      );
    } catch (err) {
      throw s3Error(err, `PutObject ${key}`);
    }
    return { id };
  }

  async delete(owner: string, id: string): Promise<void> {
    const key = this.key(owner, id);
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      throw s3Error(err, `DeleteObject ${key}`);
    }
  }
}
