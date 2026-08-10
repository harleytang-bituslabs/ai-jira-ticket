/**
 * 参考数据缓存的存储后端。fs 走真实临时目录;S3 只替掉 send(),分页/TTL 逻辑是真代码。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FsCacheStore, S3CacheStore } from "../src/stores/cache-store.js";

describe("FsCacheStore", () => {
  let dir: string;
  let store: FsCacheStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ajt-cache-"));
    store = new FsCacheStore(dir);
  });

  it("write/read roundtrip", async () => {
    await store.write("spec.md", "# 规范\n");
    expect(await store.read("spec.md")).toBe("# 规范\n");
  });

  it("missing entries read as null rather than throwing", async () => {
    expect(await store.read("nope.json")).toBeNull();
  });

  it("creates the directory on first write", async () => {
    const fresh = new FsCacheStore(join(dir, "deep", "nested"));
    await fresh.write("a.json", "{}");
    expect(await fresh.read("a.json")).toBe("{}");
  });

  it("lands the bytes on disk under the given name", async () => {
    await store.write("issues.json", '{"issues":[]}');
    expect(await readFile(join(dir, "issues.json"), "utf-8")).toBe('{"issues":[]}');
  });

  it("rejects names that would escape the cache directory", async () => {
    await expect(store.write("../escaped.json", "x")).rejects.toThrow();
    await expect(store.read("../../etc/passwd")).rejects.toThrow();
  });
});

/** 只实现 send();记录收到的命令,便于断言 key 和调用次数。 */
class FakeS3 {
  readonly gets: string[] = [];
  readonly puts: Array<{ key: string; body: string }> = [];
  constructor(private readonly objects: Map<string, string> = new Map()) {}

  async send(cmd: { constructor: { name: string }; input: Record<string, string> }): Promise<unknown> {
    const name = cmd.constructor.name;
    if (name === "GetObjectCommand") {
      this.gets.push(cmd.input.Key!);
      const body = this.objects.get(cmd.input.Key!);
      if (body === undefined) {
        const err = new Error("no such key") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: { transformToString: async () => body } };
    }
    if (name === "PutObjectCommand") {
      this.puts.push({ key: cmd.input.Key!, body: cmd.input.Body! });
      this.objects.set(cmd.input.Key!, cmd.input.Body!);
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  }
}

describe("S3CacheStore", () => {
  const mk = (fake: FakeS3, ttlMs = 60_000) =>
    new S3CacheStore("bucket", "cache/", fake as unknown as ConstructorParameters<typeof S3CacheStore>[2], ttlMs);

  it("puts and gets under the shared prefix — no per-user folder", async () => {
    const fake = new FakeS3();
    const store = mk(fake);
    await store.write("spec.md", "# 规范");
    expect(fake.puts[0].key).toBe("cache/spec.md");
    expect(await store.read("spec.md")).toBe("# 规范");
  });

  it("a missing object reads as null", async () => {
    const store = mk(new FakeS3());
    expect(await store.read("issues.json")).toBeNull();
  });

  it("serves repeat reads from memory instead of hitting S3 again", async () => {
    const fake = new FakeS3(new Map([["cache/issues.json", "{}"]]));
    const store = mk(fake);
    await store.read("issues.json");
    await store.read("issues.json");
    await store.read("issues.json");
    expect(fake.gets.length).toBe(1); // 156KB 的 issues.json 不该每个请求都从 S3 拉
  });

  it("re-fetches once the TTL has passed", async () => {
    const fake = new FakeS3(new Map([["cache/issues.json", "{}"]]));
    const store = mk(fake, 0); // TTL=0:每次都算过期
    await store.read("issues.json");
    await store.read("issues.json");
    expect(fake.gets.length).toBe(2);
  });

  it("a write makes the next read see the new value immediately", async () => {
    const fake = new FakeS3(new Map([["cache/issues.json", "old"]]));
    const store = mk(fake);
    expect(await store.read("issues.json")).toBe("old");
    await store.write("issues.json", "new"); // 「更新config」之后不能还读到旧的
    expect(await store.read("issues.json")).toBe("new");
  });

  it("caches the absence of an object too", async () => {
    const fake = new FakeS3();
    const store = mk(fake);
    await store.read("gone.json");
    await store.read("gone.json");
    expect(fake.gets.length).toBe(1);
  });

  it("rejects names that would escape the prefix", async () => {
    const store = mk(new FakeS3());
    await expect(store.write("../users.json", "x")).rejects.toThrow();
  });
});
