import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/core/config.js";
import { DraftFileSchema, type DraftFile, type Ticket } from "../src/core/schema.js";
import { FsCacheStore } from "../src/stores/cache-store.js";
import { FsDraftStore } from "../src/stores/draft-store.js";
import { FsUserStore } from "../src/stores/user-store.js";
import { buildApp } from "../src/server/app.js";
import { hashPassword } from "../src/server/session.js";

const ALICE = "alice@example.com"; // l1
const BOB = "bob@example.com"; // l2
const CAROL = "carol@example.com"; // admin
const NOBOARD = "noboard@example.com"; // l2,但没有任何可见 board
const OTHER = "other@example.com"; // l1,Art 团队 —— 不在 Bob(MLE) 的派活范围
const TEAMLESS = "teamless@example.com"; // l2,没设团队
const PASSWORD = "hunter2hunter2";

let app: ReturnType<typeof buildApp>;
let config: ResolvedConfig;
let drafts: FsDraftStore;

const ticket = (localId: string, over: Partial<Ticket> = {}): Record<string, unknown> => ({
  localId,
  summary: `[Some Epic] Work item ${localId}`,
  description: "正文",
  issueType: "Task",
  priority: "P2",
  labels: [],
  parent: "AIP-1",
  assignee: null,
  dueDate: null,
  estimate: null,
  ...over,
});

const mkDraft = (tickets: Record<string, unknown>[], createdAt: string): DraftFile =>
  DraftFileSchema.parse({
    meta: {
      version: 1,
      createdAt,
      input: "测试输入",
      projectKey: "AIP",
      specSyncedAt: null,
      specVersions: [],
      model: "test-model",
    },
    tickets,
    links: [],
  });

/** 登录拿 token,返回一个每个请求都带 Authorization 头的小代理 —— 身份只在头里,没有共享状态。 */
async function login(email: string, password = PASSWORD) {
  const r = await request(app).post("/api/login").send({ email, password });
  expect(r.status).toBe(200);
  const auth = `Bearer ${r.body.token as string}`;
  const wrap = (m: "get" | "post" | "put" | "patch" | "delete") => (url: string) => request(app)[m](url).set("Authorization", auth);
  return { get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

beforeAll(async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ajt-cache-"));
  const draftsDir = await mkdtemp(join(tmpdir(), "ajt-drafts-"));
  const dataDir = await mkdtemp(join(tmpdir(), "ajt-data-"));

  await writeFile(
    join(cacheDir, "project-meta.json"),
    JSON.stringify({
      projectKey: "AIP",
      issueTypes: [
        { id: "1", name: "Epic", subtask: false },
        { id: "2", name: "Task", subtask: false },
        { id: "3", name: "Sub-task", subtask: true },
      ],
      priorities: ["P0", "P1", "P2"],
      linkTypes: [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }],
      fetchedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
  await writeFile(
    join(cacheDir, "issues.json"),
    JSON.stringify({
      projectKey: "AIP",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      issues: [
        { key: "AIP-1", summary: "Some Epic", issueType: "Epic", status: "In Progress", priority: null, assignee: null, parent: null, labels: [], dueDate: null, created: "", updated: "" },
        { key: "AIP-2", summary: "Some Task", issueType: "Task", status: "In Progress", priority: "P2", assignee: null, parent: "AIP-1", labels: [], dueDate: null, created: "", updated: "" },
      ],
    }),
  );

  // 全公司 board 清单缓存(「更新config」写的那份):已接入 AIP,还有个没接入的 CG
  await writeFile(
    join(cacheDir, "projects.json"),
    JSON.stringify({
      fetchedAt: "2026-07-01T00:00:00.000Z",
      projects: [
        { key: "CG", name: "Casual Games" },
        { key: "AIP", name: "AI Pipeline" },
      ],
    }),
  );

  // 参与者名册缓存(「更新config」写的那份):Bob 干过活,Alice 还没有
  await writeFile(
    join(cacheDir, "users.json"),
    JSON.stringify({
      fetchedAt: "2026-07-01T00:00:00.000Z",
      total: 2,
      users: [
        { accountId: "acc-bob", displayName: "Bob", email: BOB },
        { accountId: "acc-zoe", displayName: "Zoe Last", email: "zoe@example.com" },
      ],
    }),
  );

  config = {
    projectKey: "AIP",
    specPageUrls: ["https://example.atlassian.net/wiki/spaces/X/pages/1/Spec"],
    defaultPriority: "P2",
    staticFields: {},
    startDateField: "customfield_10015",
    language: "auto",
    cacheDir,
    draftsDir,
    teamMembers: [{ name: "T One", email: "t1@example.com" }],
    model: "test-model",
  };

  drafts = new FsDraftStore(draftsDir);
  const cache = new FsCacheStore(cacheDir);
  const users = new FsUserStore(join(dataDir, "users.json"));
  const scrypt = await hashPassword(PASSWORD);
  const base = { scrypt, active: true, createdAt: "2026-07-01T00:00:00.000Z", boards: ["AIP"] };
  await users.upsert({ email: ALICE, name: "Alice", level: "l1", ...base, team: "MLE" });
  await users.upsert({ email: BOB, name: "Bob", level: "l2", ...base, team: "MLE" });
  await users.upsert({ email: OTHER, name: "Olga", level: "l1", ...base, team: "Art" });
  await users.upsert({ email: TEAMLESS, name: "Tess", level: "l2", ...base });
  await users.upsert({ email: "gone@example.com", name: "Gone", level: "l1", ...base, active: false });
  // admin 恒定可见全部 board —— 故意给空 boards,验证它不受该字段约束
  await users.upsert({ email: CAROL, name: "Carol", level: "admin", ...base, boards: [] });
  // 已建号但还没被授权任何 board 的人(升级后的默认状态)
  await users.upsert({ email: NOBOARD, name: "Dave", level: "l2", ...base, boards: [] });

  app = buildApp(config, { drafts, users, cache, sessionSecret: "test-secret" });
});

describe("open endpoints", () => {
  it("GET /healthz needs no auth", async () => {
    const r = await request(app).get("/healthz");
    expect(r.body).toEqual({ ok: true });
  });

  it("GET / serves the app shell (or a clear not-built hint before build:web)", async () => {
    const r = await request(app).get("/");
    expect([200, 503]).toContain(r.status);
  });

  it("unknown /api route: 401 when anonymous, 404 when authed (no route disclosure)", async () => {
    expect((await request(app).get("/api/nope")).status).toBe(401);
    const agent = await login(ALICE);
    expect((await agent.get("/api/nope")).status).toBe(404);
  });
});

describe("auth", () => {
  it("API is gated: no cookie → 401", async () => {
    for (const probe of [request(app).get("/api/meta"), request(app).get("/api/drafts")]) {
      const r = await probe;
      expect(r.status).toBe(401);
      // 分类字段:前端据此才敢弹回登录页,而不是见 401 就登出
      expect(r.body.category).toBe("session");
    }
  });

  it("wrong password → 401 with a uniform message", async () => {
    const r = await request(app).post("/api/login").send({ email: ALICE, password: "nope" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("邮箱或密码不正确");
  });

  it("disabled accounts cannot log in (same uniform message)", async () => {
    const r = await request(app).post("/api/login").send({ email: "gone@example.com", password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("邮箱或密码不正确");
  });

  it("login → /api/me;丢掉 token 即登出", async () => {
    const agent = await login(ALICE);
    const me = await agent.get("/api/me");
    expect(me.body.user).toMatchObject({ email: ALICE, name: "Alice", level: "l1" });
    expect(me.body.user.scrypt).toBeUndefined();
    // 每个人都用工作邮箱登录,不再有独立的 Jira 邮箱概念
    expect(me.body.user.jiraEmail).toBeUndefined();

    // 没有头就是匿名 —— 登出 = 前端清掉本标签页的 token,服务端无状态
    expect((await request(app).get("/api/me")).status).toBe(401);
  });

  it("登录不再种 cookie —— 身份只住在各标签页的 token 里,谁也污染不了谁", async () => {
    const r = await request(app).post("/api/login").send({ email: ALICE, password: PASSWORD });
    expect(r.headers["set-cookie"]).toBeUndefined();

    // 就算手工带上旧 cookie 也不认
    const spoof = await request(app).get("/api/me").set("Cookie", `ajt_session=${r.body.token as string}`);
    expect(spoof.status).toBe(401);
  });

  it("登录同时发 token,凭 Authorization 头即可用(一台电脑多账号:每个标签页各自的 token)", async () => {
    const r1 = await request(app).post("/api/login").send({ email: ALICE, password: PASSWORD });
    const r2 = await request(app).post("/api/login").send({ email: BOB, password: PASSWORD });
    expect(typeof r1.body.token).toBe("string");

    // 不带 cookie,只带各自的头 —— 两个账号并行,互不干扰
    const meA = await request(app).get("/api/me").set("Authorization", `Bearer ${r1.body.token}`);
    const meB = await request(app).get("/api/me").set("Authorization", `Bearer ${r2.body.token}`);
    expect(meA.body.user.email).toBe(ALICE);
    expect(meB.body.user.email).toBe(BOB);
  });

  it("坏 token 的 Authorization 头 → 401,不会退回匿名放行", async () => {
    const r = await request(app).get("/api/me").set("Authorization", "Bearer nonsense");
    expect(r.status).toBe(401);
  });

  it("10 failures rate-limit that (ip,email) pair only", async () => {
    const email = "victim@example.com"; // 不存在的账号,失败也计数
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/login").send({ email, password: "x" });
    }
    const blocked = await request(app).post("/api/login").send({ email, password: "x" });
    expect(blocked.status).toBe(429);

    // 其他账号不受影响
    const ok = await request(app).post("/api/login").send({ email: ALICE, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it("password change: wrong old → 401; correct → new password works", async () => {
    const agent = await login(BOB);
    const bad = await agent.post("/api/me/password").send({ oldPassword: "nope", newPassword: "longenough1" });
    expect(bad.status).toBe(401);
    // credentials 而非 session —— 打错一个字不该把本标签页的会话清掉
    expect(bad.body.category).toBe("credentials");

    const ok = await agent.post("/api/me/password").send({ oldPassword: PASSWORD, newPassword: "longenough1" });
    expect(ok.status).toBe(200);

    await login(BOB, "longenough1");
    // 还原,避免影响后续用例
    const agent2 = await login(BOB, "longenough1");
    await agent2.post("/api/me/password").send({ oldPassword: "longenough1", newPassword: PASSWORD });
  });
});

describe("/api/meta 的指派名册", () => {
  it("名册里没有本人时也把本人补进去(新人还没被派过票)", async () => {
    const agent = await login(ALICE); // Alice 不在参与者名册里
    const r = await agent.get("/api/meta");
    const emails = (r.body.roster as Array<{ email: string }>).map((m) => m.email);
    expect(emails).toContain(ALICE);
  });

  it("本人已经在名册里就不重复添加", async () => {
    const agent = await login(BOB); // Bob 在参与者名册里
    const r = await agent.get("/api/meta");
    const mine = (r.body.roster as Array<{ email: string }>).filter((m) => m.email === BOB);
    expect(mine.length).toBe(1);
  });

  it("L2 的名册就是本团队的活跃账号,不再是全项目参与者", async () => {
    const agent = await login(BOB);
    const r = await agent.get("/api/meta");
    const emails = (r.body.roster as Array<{ email: string }>).map((m) => m.email).sort();
    expect(emails).toEqual([ALICE, BOB].sort()); // 同团队;zoe 是参与者但没账号,不在其中
  });

  it("L2 的名册把本人排在第一个,其余按姓名", async () => {
    const agent = await login(BOB);
    const r = await agent.get("/api/meta");
    const emails = (r.body.roster as Array<{ email: string }>).map((m) => m.email);
    expect(emails[0]).toBe(BOB); // Bob 名字排 Alice 之后,但本人置顶
    expect(emails.slice(1)).toEqual([ALICE]);
  });

  it("admin 的名册仍是全项目参与者(+本人)", async () => {
    const agent = await login(CAROL);
    const r = await agent.get("/api/meta");
    const emails = (r.body.roster as Array<{ email: string }>).map((m) => m.email);
    expect(emails).toContain("zoe@example.com");
    expect(emails).toContain(CAROL);
  });

  it("名册按姓名排序,本人也参与排序而不是被硬塞到末尾", async () => {
    const agent = await login(ALICE);
    const r = await agent.get("/api/meta");
    const names = (r.body.roster as Array<{ name: string }>).map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("draft APIs are user-scoped", () => {
  it("draft validation still rejects before any LLM call", async () => {
    const agent = await login(ALICE);
    const missing = await agent.post("/api/draft").send({});
    expect(missing.status).toBe(400);
    const badSplit = await agent.post("/api/draft").send({ input: "做个东西", splitCount: 99 });
    expect(badSplit.status).toBe(400);
  });

  it("users only see their own history; ids don't cross owners", async () => {
    const a = await drafts.write(ALICE, mkDraft([ticket("t1")], "2026-07-01T08:00:00.000Z"));
    await drafts.write(BOB, mkDraft([ticket("t1", { summary: "[Some Epic] Bob's" })], "2026-07-02T08:00:00.000Z"));

    const alice = await login(ALICE);
    const bob = await login(BOB);

    const aliceList = await alice.get("/api/drafts");
    expect(aliceList.body.drafts.length).toBe(1);
    expect(aliceList.body.drafts[0].owner).toBe(ALICE);

    const bobList = await bob.get("/api/drafts");
    expect(bobList.body.drafts.length).toBe(1);

    // Bob 拿 Alice 的 id 读/删都无效
    const stolenRead = await bob.put(`/api/drafts/${a.id}`).send({ draft: mkDraft([ticket("t1")], "2026-07-01T08:00:00.000Z") });
    expect(stolenRead.status).toBe(400);
    await bob.delete(`/api/drafts/${a.id}`);
    expect((await alice.get("/api/drafts")).body.drafts.length).toBe(1); // Alice 的还在
  });

  it("PUT enforces merge protection within the owner's folder", async () => {
    const draft = mkDraft(
      [ticket("t1", { jiraKey: "AIP-100", jiraUrl: "https://x/browse/AIP-100" }), ticket("t2")],
      "2026-07-03T08:00:00.000Z",
    );
    const saved = await drafts.write(ALICE, draft);
    const agent = await login(ALICE);

    const edited = structuredClone(draft);
    edited.tickets = [{ ...edited.tickets[1], summary: "[Some Epic] Edited", jiraKey: "AIP-999" }];
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft: edited });
    expect(r.status).toBe(200);

    const tickets = r.body.draft.tickets as Array<Record<string, unknown>>;
    expect(tickets.find((t) => t.localId === "t1")?.jiraKey).toBe("AIP-100"); // 已提交票找回
    expect(tickets.find((t) => t.localId === "t2")?.jiraKey).toBeUndefined(); // 伪造 key 剥除
  });

  it("PUT keeps the record's id when the title changes (no duplicate history entry)", async () => {
    const draft = mkDraft([ticket("t1", { summary: "[Some Epic] Before" })], "2026-07-03T09:00:00.000Z");
    const saved = await drafts.write(ALICE, draft);
    const agent = await login(ALICE);

    const before = (await agent.get("/api/drafts")).body.drafts.length as number;

    const renamed = structuredClone(draft);
    renamed.tickets[0]!.summary = "[Some Epic] After rename";
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft: renamed });

    expect(r.status).toBe(200);
    expect(r.body.id).toBe(saved.id);
    const after = (await agent.get("/api/drafts")).body.drafts as Array<{ id: string; draft: { tickets: Array<{ summary: string }> } }>;
    expect(after.length).toBe(before); // 改名没有凭空生成第二条
    expect(after.find((e) => e.id === saved.id)?.draft.tickets[0]?.summary).toBe("[Some Epic] After rename");
  });

  it("L1 cannot request Epic in compose defaults (rejected before any LLM call)", async () => {
    const agent = await login(ALICE);
    const r = await agent.post("/api/draft").send({ input: "建个大模块", defaults: { issueType: "Epic" } });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("Epic");
  });

  it("L1 saves are policy-corrected: Epic rejected, assignee forced to self", async () => {
    const draft = mkDraft([ticket("t1", { assignee: BOB })], "2026-07-06T08:00:00.000Z");
    const saved = await drafts.write(ALICE, draft);
    const agent = await login(ALICE);

    // 指派他人 → 被强制改回本人
    const r1 = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
    expect(r1.status).toBe(200);
    expect(r1.body.draft.tickets[0].assignee).toBe(ALICE);

    // 改成 Epic → 403
    const epicDraft = structuredClone(draft);
    epicDraft.tickets[0].issueType = "Epic";
    const r2 = await agent.put(`/api/drafts/${saved.id}`).send({ draft: epicDraft });
    expect(r2.status).toBe(403);
  });

  it("L2 可以把票派给本团队成员,指派原样保留", async () => {
    const draft = mkDraft([ticket("t1", { assignee: ALICE })], "2026-07-07T08:00:00.000Z"); // Alice 与 Bob 同为 MLE
    const saved = await drafts.write(BOB, draft);
    const agent = await login(BOB);
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
    expect(r.body.draft.tickets[0].assignee).toBe(ALICE);
  });

  it("L2 不能把票派给别的团队/没建号的人;admin 不受限", async () => {
    const agent = await login(BOB);
    for (const who of [OTHER, "stranger@example.com"]) {
      const draft = mkDraft([ticket("t1", { assignee: who })], "2026-07-07T09:00:00.000Z");
      const saved = await drafts.write(BOB, draft);
      const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
      expect(r.status).toBe(403);
      expect(r.body.error).toContain("MLE");
    }

    const carol = await login(CAROL);
    const draft = mkDraft([ticket("t1", { assignee: "stranger@example.com" })], "2026-07-07T10:00:00.000Z");
    const saved = await drafts.write(CAROL, draft);
    expect((await carol.put(`/api/drafts/${saved.id}`).send({ draft })).status).toBe(200);
  });

  it("没设团队的 L2 只能指派给自己", async () => {
    const agent = await login(TEAMLESS);
    const ok = mkDraft([ticket("t1", { assignee: TEAMLESS })], "2026-07-07T11:00:00.000Z");
    const s1 = await drafts.write(TEAMLESS, ok);
    expect((await agent.put(`/api/drafts/${s1.id}`).send({ draft: ok })).status).toBe(200);

    const bad = mkDraft([ticket("t1", { assignee: ALICE })], "2026-07-07T12:00:00.000Z");
    const s2 = await drafts.write(TEAMLESS, bad);
    const r = await agent.put(`/api/drafts/${s2.id}`).send({ draft: bad });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("团队");
  });

  it("L2 的生成请求里指派了团队外的人 → LLM 调用前就拒", async () => {
    const agent = await login(BOB);
    const r = await agent.post("/api/draft").send({ input: "随便", defaults: { assignee: OTHER } });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("MLE");
  });

  it("board 不在可见列表内的用户不能保存该 board 的草稿", async () => {
    const draft = mkDraft([ticket("t1")], "2026-07-20T08:00:00.000Z");
    const saved = await drafts.write(NOBOARD, draft);
    const agent = await login(NOBOARD);
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("AIP");
  });

  it("board 不在可见列表内的用户连生成都发不出去(LLM 调用前就拒)", async () => {
    const agent = await login(NOBOARD);
    const r = await agent.post("/api/draft").send({ input: "随便写点什么" });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("AIP");
  });

  it("board 在可见列表内的 L2 照常保存", async () => {
    const draft = mkDraft([ticket("t1")], "2026-07-20T09:00:00.000Z");
    const saved = await drafts.write(BOB, draft);
    const agent = await login(BOB);
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
    expect(r.status).toBe(200);
  });

  it("admin 的 boards 为空也照样能开票(恒定可见全部 board)", async () => {
    const draft = mkDraft([ticket("t1")], "2026-07-20T10:00:00.000Z");
    const saved = await drafts.write(CAROL, draft);
    const agent = await login(CAROL);
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
    expect(r.status).toBe(200);
  });

  it("scope=all: admin sees every owner's records; L2 gets 403", async () => {
    await drafts.write(ALICE, mkDraft([ticket("t1")], "2026-07-08T08:00:00.000Z"));
    await drafts.write(BOB, mkDraft([ticket("t1")], "2026-07-08T09:00:00.000Z"));

    const carol = await login(CAROL);
    const all = await carol.get("/api/drafts?scope=all");
    expect(all.status).toBe(200);
    const owners = new Set(all.body.drafts.map((d: { owner: string }) => d.owner));
    expect(owners.has(ALICE)).toBe(true);
    expect(owners.has(BOB)).toBe(true);

    const bob = await login(BOB);
    expect((await bob.get("/api/drafts?scope=all")).status).toBe(403);
  });

  it("admin can delete another user's record via ?owner=; L2 cannot", async () => {
    const target = await drafts.write(ALICE, mkDraft([ticket("t1")], "2026-07-09T08:00:00.000Z"));

    const bob = await login(BOB);
    expect((await bob.delete(`/api/drafts/${target.id}?owner=${ALICE}`)).status).toBe(403);
    expect((await drafts.list(ALICE)).some((e) => e.id === target.id)).toBe(true);

    const carol = await login(CAROL);
    expect((await carol.delete(`/api/drafts/${target.id}?owner=${ALICE}`)).status).toBe(200);
    expect((await drafts.list(ALICE)).some((e) => e.id === target.id)).toBe(false);
  });

  it("cleanup only touches the caller's fully-submitted records", async () => {
    const doneA = await drafts.write(ALICE, mkDraft([ticket("t1", { jiraKey: "AIP-101", jiraUrl: "https://x/AIP-101" })], "2026-07-04T08:00:00.000Z"));
    const doneB = await drafts.write(BOB, mkDraft([ticket("t1", { jiraKey: "AIP-102", jiraUrl: "https://x/AIP-102" })], "2026-07-05T08:00:00.000Z"));

    const alice = await login(ALICE);
    await alice.post("/api/drafts/cleanup");

    expect((await drafts.list(ALICE)).some((e) => e.id === doneA.id)).toBe(false);
    expect((await drafts.list(BOB)).some((e) => e.id === doneB.id)).toBe(true); // Bob 的没被动
  });
});

describe("admin user management", () => {
  it("is admin-gated: anonymous → 401, L2 → 403", async () => {
    expect((await request(app).get("/api/admin/users")).status).toBe(401);
    const bob = await login(BOB);
    const denied = await bob.get("/api/admin/users");
    expect(denied.status).toBe(403);
    expect(denied.body.category).toBe("forbidden");
  });

  it("lists users without leaking password hashes", async () => {
    const carol = await login(CAROL);
    const r = await carol.get("/api/admin/users");
    expect(r.status).toBe(200);
    expect(r.body.users.length).toBeGreaterThanOrEqual(4);
    for (const u of r.body.users) {
      expect(u.scrypt).toBeUndefined();
      expect(u.level).toMatch(/^(l1|l2|admin)$/);
    }
  });

  it("creates a user who can then log in; duplicates → 409; weak input → 400", async () => {
    const carol = await login(CAROL);
    const created = await carol.post("/api/admin/users").send({
      email: "dave@example.com",
      name: "Dave",
      password: "davedavedave",
      level: "l2",
    });
    expect(created.status).toBe(201);
    await login("dave@example.com", "davedavedave");

    expect((await carol.post("/api/admin/users").send({ email: "dave@example.com", name: "D", password: "davedavedave", level: "l1" })).status).toBe(409);
    expect((await carol.post("/api/admin/users").send({ email: "eve@example.com", name: "Eve", password: "short", level: "l1" })).status).toBe(400);
    expect((await carol.post("/api/admin/users").send({ email: "eve@example.com", name: "Eve", password: "longenough1", level: "boss" })).status).toBe(400);
  });

  it("建号时可以直接授权 board 和团队,新人当场就能开票", async () => {
    const carol = await login(CAROL);
    const created = await carol.post("/api/admin/users").send({
      email: "grace@example.com",
      name: "Grace",
      password: "gracegrace1",
      level: "l2",
      boards: ["AIP"],
      team: "BO",
    });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ boards: ["AIP"], team: "BO" });

    const grace = await login("grace@example.com", "gracegrace1");
    const draft = mkDraft([ticket("t1")], "2026-07-21T08:00:00.000Z");
    const saved = await drafts.write("grace@example.com", draft);
    expect((await grace.put(`/api/drafts/${saved.id}`).send({ draft })).status).toBe(200);
  });

  it("不给 boards 时新账号默认什么都看不到", async () => {
    const carol = await login(CAROL);
    const created = await carol.post("/api/admin/users").send({
      email: "heidi@example.com",
      name: "Heidi",
      password: "heidiheidi1",
      level: "l2",
    });
    expect(created.body.user.boards).toEqual([]);

    const heidi = await login("heidi@example.com", "heidiheidi1");
    const draft = mkDraft([ticket("t1")], "2026-07-21T09:00:00.000Z");
    const saved = await drafts.write("heidi@example.com", draft);
    expect((await heidi.put(`/api/drafts/${saved.id}`).send({ draft })).status).toBe(403);
  });

  it("拒绝没接入过的 board key", async () => {
    const carol = await login(CAROL);
    const r = await carol.post("/api/admin/users").send({
      email: "ivan@example.com",
      name: "Ivan",
      password: "ivanivanivan",
      level: "l2",
      boards: ["NOSUCH"],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("NOSUCH");
  });

  it("PATCH 能改 boards 和团队,改完立刻生效", async () => {
    const carol = await login(CAROL);
    await carol.post("/api/admin/users").send({ email: "judy@example.com", name: "Judy", password: "judyjudyjudy", level: "l2" });

    const draft = mkDraft([ticket("t1")], "2026-07-21T10:00:00.000Z");
    const saved = await drafts.write("judy@example.com", draft);
    const judy = await login("judy@example.com", "judyjudyjudy");
    expect((await judy.put(`/api/drafts/${saved.id}`).send({ draft })).status).toBe(403);

    const up = await carol.patch("/api/admin/users/judy@example.com").send({ boards: ["AIP"], team: "Devops" });
    expect(up.body.user).toMatchObject({ boards: ["AIP"], team: "Devops" });
    expect((await judy.put(`/api/drafts/${saved.id}`).send({ draft })).status).toBe(200);
  });

  it("/api/me 带上 boards 和团队,前端才知道自己能看什么", async () => {
    const agent = await login(BOB);
    const me = await agent.get("/api/me");
    expect(me.body.user).toMatchObject({ boards: ["AIP"], team: "MLE" });
  });

  it("团队只接受预设的几个,写错的拼法直接拒", async () => {
    const carol = await login(CAROL);
    const bad = await carol.post("/api/admin/users").send({
      email: "kate@example.com",
      name: "Kate",
      password: "katekatekate",
      level: "l1",
      team: "研发一部",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("研发一部");

    const ok = await carol.post("/api/admin/users").send({
      email: "kate@example.com",
      name: "Kate",
      password: "katekatekate",
      level: "l1",
      team: "Art",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.user.team).toBe("Art");
  });

  it("PATCH 传空字符串可以清掉团队", async () => {
    const carol = await login(CAROL);
    await carol.post("/api/admin/users").send({ email: "liam@example.com", name: "Liam", password: "liamliamliam", level: "l1", team: "Devops" });
    const cleared = await carol.patch("/api/admin/users/liam@example.com").send({ team: "" });
    expect(cleared.body.user.team).toBeNull();
  });

  it("board 候选清单是全公司的,接入的排最前", async () => {
    const carol = await login(CAROL);
    const r = await carol.get("/api/admin/boards");
    expect(r.status).toBe(200);
    expect(r.body.boards).toEqual([
      { key: "AIP", name: "AI Pipeline" },
      { key: "CG", name: "Casual Games" },
    ]);
  });

  it("可以授权还没接入的公司 board(前瞻记录,开票仍只在已接入的 board 上)", async () => {
    const carol = await login(CAROL);
    await carol.post("/api/admin/users").send({ email: "mona@example.com", name: "Mona", password: "monamonamona", level: "l2" });
    const up = await carol.patch("/api/admin/users/mona@example.com").send({ boards: ["AIP", "CG"] });
    expect(up.status).toBe(200);
    expect(up.body.user.boards).toEqual(["AIP", "CG"]);
  });

  it("按参与记录识别一个邮箱该开哪些 board", async () => {
    const carol = await login(CAROL);
    const hit = await carol.get(`/api/admin/participation?email=${encodeURIComponent(BOB)}`);
    expect(hit.status).toBe(200);
    expect(hit.body.boards).toEqual(["AIP"]);

    // 大小写不敏感 —— 管理员手输邮箱不该因为大写而识别不到
    const upper = await carol.get(`/api/admin/participation?email=${encodeURIComponent(BOB.toUpperCase())}`);
    expect(upper.body.boards).toEqual(["AIP"]);
  });

  it("没有参与记录的邮箱识别不出任何 board", async () => {
    const carol = await login(CAROL);
    const r = await carol.get("/api/admin/participation?email=stranger@example.com");
    expect(r.body.boards).toEqual([]);
  });

  it("识别接口也归管理员:L2 拿不到", async () => {
    const bob = await login(BOB);
    expect((await bob.get(`/api/admin/participation?email=${BOB}`)).status).toBe(403);
  });

  it("不给邮箱就 400", async () => {
    const carol = await login(CAROL);
    expect((await carol.get("/api/admin/participation")).status).toBe(400);
  });

  it("PATCH updates level / active / password; deactivation blocks login at once", async () => {
    const carol = await login(CAROL);
    await carol.post("/api/admin/users").send({ email: "frank@example.com", name: "Frank", password: "frankfrank1", level: "l1" });

    const up = await carol.patch("/api/admin/users/frank@example.com").send({ level: "l2", password: "newpassword9" });
    expect(up.status).toBe(200);
    expect(up.body.user.level).toBe("l2");

    expect((await request(app).post("/api/login").send({ email: "frank@example.com", password: "frankfrank1" })).status).toBe(401);
    const frank = await login("frank@example.com", "newpassword9");

    await carol.patch("/api/admin/users/frank@example.com").send({ active: false });
    expect((await frank.get("/api/me")).status).toBe(401); // 已有会话立刻失效
    expect((await request(app).post("/api/login").send({ email: "frank@example.com", password: "newpassword9" })).status).toBe(401);
  });

  it("refuses to demote or deactivate the last active admin", async () => {
    const carol = await login(CAROL);
    expect((await carol.patch(`/api/admin/users/${CAROL}`).send({ level: "l1" })).status).toBe(400);
    expect((await carol.patch(`/api/admin/users/${CAROL}`).send({ active: false })).status).toBe(400);
  });

  it("PATCH unknown user → 404", async () => {
    const carol = await login(CAROL);
    expect((await carol.patch("/api/admin/users/nobody@example.com").send({ level: "l1" })).status).toBe(404);
  });
});
