/**
 * Storage for the shared reference data in .cache/ — the Confluence spec, the
 * project metadata, the board snapshot and the participant roster.
 *
 * Unlike drafts, this data is identical for everybody, so the S3 backend keeps
 * one copy under a flat prefix rather than a folder per user. That is the whole
 * point: every instance reads the same objects, so a container starts serving
 * immediately instead of spending ~40s re-pulling from Atlassian, and 「更新
 * config」 done by one admin is visible to everyone.
 *
 * S3 reads go through a short in-process TTL memo. Without it every /api/meta
 * would drag issues.json (~156KB) and spec.md (~143KB) across the network. A
 * write refreshes the memo, so the admin who just refreshed never sees stale
 * data; other instances catch up within the TTL.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { atomicWrite } from "../utils/fs.js";
import { isNoSuchKey, s3Error } from "./s3-errors.js";

export interface CacheStore {
  /** Null when the entry doesn't exist yet (fresh deployment). */
  read(name: string): Promise<string | null>;
  write(name: string, body: string): Promise<void>;
}

/**
 * Entry names are code-supplied, never user input — but they end up in a path
 * and an S3 key, so a stray "../" would be a real escape. Cheap to forbid.
 */
function assertName(name: string): void {
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".") || name.includes("..")) {
    throw new Error(`invalid cache entry name: ${name}`);
  }
}

export class FsCacheStore implements CacheStore {
  constructor(private readonly dir: string) {}

  async read(name: string): Promise<string | null> {
    assertName(name);
    try {
      return await readFile(join(this.dir, name), "utf-8");
    } catch {
      return null;
    }
  }

  async write(name: string, body: string): Promise<void> {
    assertName(name);
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(join(this.dir, name), body);
  }
}

const DEFAULT_TTL_MS = 60_000;

export class S3CacheStore implements CacheStore {
  private readonly s3: S3Client;
  /** value === null 表示「确认不存在」,同样值得缓存,免得每次都去撞一个 404。 */
  private readonly memo = new Map<string, { value: string | null; at: number }>();

  constructor(
    private readonly bucket: string,
    private readonly prefix = "cache/",
    s3?: S3Client,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    this.s3 = s3 ?? new S3Client({});
  }

  private key(name: string): string {
    assertName(name);
    return `${this.prefix}${name}`;
  }

  async read(name: string): Promise<string | null> {
    const key = this.key(name);
    const hit = this.memo.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    let value: string | null;
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      value = (await r.Body?.transformToString()) ?? null;
    } catch (err) {
      if (!isNoSuchKey(err)) throw s3Error(err, `GetObject ${key}`);
      value = null;
    }
    this.memo.set(key, { value, at: Date.now() });
    return value;
  }

  async write(name: string, body: string): Promise<void> {
    const key = this.key(name);
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: name.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        }),
      );
    } catch (err) {
      throw s3Error(err, `PutObject ${key}`);
    }
    this.memo.set(key, { value: body, at: Date.now() });
  }
}
