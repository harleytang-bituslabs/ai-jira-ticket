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
    expect(() => assertOwner("..")).toThrow(/非法/); // 必须字母数字开头,纯点号进不来
    expect(() => assertOwner(".hidden")).toThrow(/非法/);
    await expect(store.read(A, "../secrets")).rejects.toThrow(/非法/);
  });

  it("updates in place when an id is passed, even if the summary changed", async () => {
    const first = await store.write(A, mkDraft("2026-07-01T08:00:00.000Z", "[E] 原标题"));
    const renamed = mkDraft("2026-07-01T08:00:00.000Z", "[E] 改过的标题");

    const again = await store.write(A, renamed, first.id); // 沿用 id
    expect(again.id).toBe(first.id);
    expect((await store.list(A)).length).toBe(1); // 关键:没有多出一条
    expect((await store.read(A, first.id)).tickets[0]!.summary).toBe("[E] 改过的标题");

    const derived = await store.write(A, renamed); // 不传 id = 新建,才允许换名
    expect(derived.id).not.toBe(first.id);
    expect((await store.list(A)).length).toBe(2);
  });

  it("accepts a plain username as owner (内建 admin 账号不用邮箱)", async () => {
    expect(() => assertOwner("admin")).not.toThrow();
    const saved = await store.write("admin", mkDraft("2026-08-01T00:00:00.000Z"));
    expect((await store.list("admin")).map((e) => e.id)).toEqual([saved.id]);
    expect((await store.listAll()).some((e) => e.owner === "admin")).toBe(true);
  });
});

describe("FsUserStore", () => {
  let store: FsUserStore;
  let usersPath: string;

  const user = (email: string, over: Partial<UserRecord> = {}): UserRecord => ({
    email,
    name: "Some One",
    level: "l1",
    scrypt: { salt: "abc", hash: "def" },
    active: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    boards: [],
    ...over,
  });

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ajt-users-"));
    usersPath = join(dir, "users.json");
    store = new FsUserStore(usersPath);
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

  it("legacy records without boards read back as seeing no board at all", async () => {
    // 多 board 之前写下的记录没有 boards/team;解析后必须落到「什么都看不到」,
    // 而不是静默全开 —— 新接入的 board 不该对老账号自动可见。
    await writeFile(
      usersPath,
      JSON.stringify({
        users: [
          {
            email: "legacy@x.com",
            name: "Legacy User",
            level: "l1",
            scrypt: { salt: "abc", hash: "def" },
            active: true,
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const u = await store.get("legacy@x.com");
    expect(u?.boards).toEqual([]);
    expect(u?.team).toBeUndefined();
  });

  it("keeps boards and team through a write/read roundtrip", async () => {
    await store.upsert(user("dev@x.com", { boards: ["AIP", "PLAT"], team: "MLE" }));
    // 换一个 store 实例读同一个文件 —— 绕开内存缓存,真正走一遍磁盘 + schema
    const u = await new FsUserStore(usersPath).get("dev@x.com");
    expect(u?.boards).toEqual(["AIP", "PLAT"]);
    expect(u?.team).toBe("MLE");
  });

  it("手改出来的陌生团队值只丢该字段,不会让整份用户表解析失败", async () => {
    await writeFile(
      usersPath,
      JSON.stringify({
        users: [
          { email: "a@x.com", name: "A", level: "l1", team: "研发一部", scrypt: { salt: "s", hash: "h" }, active: true, createdAt: "2026-06-01T00:00:00.000Z" },
          { email: "b@x.com", name: "B", level: "l2", team: "Art", scrypt: { salt: "s", hash: "h" }, active: true, createdAt: "2026-06-01T00:00:00.000Z" },
        ],
      }),
    );
    const all = await store.all();
    expect(all.length).toBe(2); // 两个人都还在 —— 没有因为一个坏值把所有人挡在门外
    expect(all[0].team).toBeUndefined();
    expect(all[1].team).toBe("Art");
  });
});
