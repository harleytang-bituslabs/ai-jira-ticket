/**
 * User directory for the web service — one JSON document behind the same
 * storage choice as drafts (fs for dev, S3 in deployment).
 *
 * Reads go through a short TTL cache so per-request checks (active? level?)
 * stay cheap even on S3; writes go straight through and refresh the cache.
 * Single-instance assumption (last-write-wins) — revisit when scaling out.
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { atomicWrite } from "../utils/fs.js";

export const USER_LEVELS = ["l1", "l2", "admin"] as const;
export type UserLevel = (typeof USER_LEVELS)[number];

/**
 * 账号标识:工作邮箱,或纯用户名(如内建的 admin)。必须以字母数字开头 ——
 * 既排除 ".."/"." 这类路径穿越,也排除 S3 key 里的怪字符(草稿目录名就是它)。
 */
export const ACCOUNT_ID_RE = /^[a-z0-9][\w.+-]*(@[\w.-]+)?$/i;

const UserRecordSchema = z.object({
  /** 登录标识:邮箱或用户名,唯一(大小写不敏感)。 */
  email: z.string().min(3),
  name: z.string().min(1),
  /** Jira 账号邮箱与登录邮箱不一致时由管理员配置;缺省即用 email。 */
  jiraEmail: z.string().optional(),
  level: z.enum(USER_LEVELS),
  /** scrypt 参数由 server/session.ts 生成;此处只负责存取。 */
  scrypt: z.object({ salt: z.string(), hash: z.string() }),
  active: z.boolean().default(true),
  createdAt: z.string(),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

const UsersDocSchema = z.object({ users: z.array(UserRecordSchema).default([]) });

export interface UserStore {
  all(): Promise<UserRecord[]>;
  get(email: string): Promise<UserRecord | null>;
  upsert(user: UserRecord): Promise<void>;
}

const CACHE_TTL_MS = 30_000;

abstract class JsonDocUserStore implements UserStore {
  private cache: { users: UserRecord[]; at: number } | null = null;

  protected abstract loadDoc(): Promise<string | null>;
  protected abstract saveDoc(json: string): Promise<void>;

  async all(): Promise<UserRecord[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.users;
    const raw = await this.loadDoc();
    const users = raw ? UsersDocSchema.parse(JSON.parse(raw)).users : [];
    this.cache = { users, at: Date.now() };
    return users;
  }

  async get(email: string): Promise<UserRecord | null> {
    const norm = email.trim().toLowerCase();
    return (await this.all()).find((u) => u.email.toLowerCase() === norm) ?? null;
  }

  async upsert(user: UserRecord): Promise<void> {
    const users = [...(await this.all())];
    const i = users.findIndex((u) => u.email.toLowerCase() === user.email.toLowerCase());
    if (i >= 0) users[i] = user;
    else users.push(user);
    await this.saveDoc(JSON.stringify({ users }, null, 2) + "\n");
    this.cache = { users, at: Date.now() };
  }
}

export class FsUserStore extends JsonDocUserStore {
  constructor(private readonly path: string) {
    super();
  }

  protected async loadDoc(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf-8");
    } catch {
      return null;
    }
  }

  protected async saveDoc(json: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await atomicWrite(this.path, json);
  }
}

export class S3UserStore extends JsonDocUserStore {
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly key = "users.json",
    s3?: S3Client,
  ) {
    super();
    this.s3 = s3 ?? new S3Client({});
  }

  protected async loadDoc(): Promise<string | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }));
      return (await r.Body?.transformToString()) ?? null;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  protected async saveDoc(json: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: json,
        ContentType: "application/json; charset=utf-8",
      }),
    );
  }
}
