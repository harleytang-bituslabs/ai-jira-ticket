import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DraftFileSchema, type DraftFile } from "../src/core/schema.js";
import { FsDraftStore, assertOwner } from "../src/stores/draft-store.js";
import { FsUserStore, type UserRecord } from "../src/stores/user-store.js";

const mkDraft = (createdAt: string, summary = "[E] Work"): DraftFile =>
  DraftFileSchema.parse({
    meta: {
      version: 1,
      createdAt,
      input: "输入",
      projectKey: "AIP",
      specSyncedAt: null,
      specVersions: [],
      model: "m",
    },
    tickets: [
      {
        localId: "t1",
        summary,
        description: "d",
        issueType: "Task",
        priority: "P2",
        labels: [],
        parent: "AIP-1",
        assignee: null,
        dueDate: null,
        estimate: null,
      },
    ],
    links: [],
  });

describe("FsDraftStore", () => {
  let store: FsDraftStore;
  let root: string;
  const A = "alice@example.com";
  const B = "bob@example.com";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ajt-store-"));
    store = new FsDraftStore(root);
  });

  it("write/read roundtrip within an owner folder", async () => {
    const draft = mkDraft("2026-07-01T08:00:00.000Z");
    const { id } = await store.write(A, draft);
    const back = await store.read(A, id);
    expect(back.meta.input).toBe("输入");
  });

  it("list is scoped per owner; listAll spans owners with owner tags", async () => {
    await store.write(A, mkDraft("2026-07-01T08:00:00.000Z", "[E] A one"));
    await store.write(A, mkDraft("2026-07-02T08:00:00.000Z", "[E] A two"));
    await store.write(B, mkDraft("2026-07-03T08:00:00.000Z", "[E] B one"));

    expect((await store.list(A)).length).toBe(2);
    expect((await store.list(B)).length).toBe(1);

    const all = await store.listAll();
    expect(all.length).toBe(3);
    expect(all[0].owner).toBe(B); // newest first
    expect(all.map((e) => e.owner).sort()).toEqual([A, A, B].sort());
  });

  it("cannot read another owner's draft by id", async () => {
    const { id } = await store.write(A, mkDraft("2026-07-01T08:00:00.000Z"));
    await expect(store.read(B, id)).rejects.toThrow(/不存在/);
  });

  it("delete removes only the target record", async () => {
    const a = await store.write(A, mkDraft("2026-07-01T08:00:00.000Z", "[E] one"));
    await store.write(A, mkDraft("2026-07-02T08:00:00.000Z", "[E] two"));
    await store.delete(A, a.id);
    const left = await store.list(A);
    expect(left.length).toBe(1);
  });

  it("skips corrupt files instead of failing the whole listing", async () => {
    await store.write(A, mkDraft("2026-07-01T08:00:00.000Z"));
    await writeFile(join(root, A, "broken.json"), "{oops");
    const list = await store.list(A);
    expect(list.length).toBe(1);
  });

  it("rejects path-traversal owners and ids", async () => {
    expect(() => assertOwner("../../etc")).toThrow(/非法/);
    await expect(store.read(A, "../secrets")).rejects.toThrow(/非法/);
    await expect(store.list("no-at-sign")).resolves.toEqual([]); // dir() throws → 由调用方守卫;list 对不存在目录返回空
  });
});

describe("FsUserStore", () => {
  let store: FsUserStore;

  const user = (email: string, over: Partial<UserRecord> = {}): UserRecord => ({
    email,
    name: "Some One",
    level: "l1",
    scrypt: { salt: "abc", hash: "def" },
    active: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  });

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajt-users-"));
    store = new FsUserStore(join(dir, "users.json"));
  });

  it("starts empty and upserts new users", async () => {
    expect(await store.all()).toEqual([]);
    await store.upsert(user("a@x.com"));
    await store.upsert(user("b@x.com", { level: "admin" }));
    expect((await store.all()).length).toBe(2);
  });

  it("get is case-insensitive; upsert overwrites by email", async () => {
    await store.upsert(user("Mixed.Case@X.com", { name: "Before" }));
    expect((await store.get("mixed.case@x.com"))?.name).toBe("Before");

    await store.upsert(user("MIXED.CASE@x.com", { name: "After", level: "l2" }));
    const all = await store.all();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe("After");
    expect(all[0].level).toBe("l2");
  });

  it("returns null for unknown users", async () => {
    expect(await store.get("nobody@x.com")).toBeNull();
  });
});
