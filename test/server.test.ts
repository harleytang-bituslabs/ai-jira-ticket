import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/core/config.js";
import { DraftFileSchema, type DraftFile, type Ticket } from "../src/core/schema.js";
import { FsDraftStore } from "../src/stores/draft-store.js";
import { FsUserStore } from "../src/stores/user-store.js";
import { buildApp } from "../src/server/app.js";
import { hashPassword } from "../src/server/session.js";

const ALICE = "alice@example.com"; // l1
const BOB = "bob@example.com"; // l2
const CAROL = "carol@example.com"; // admin
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

async function login(email: string, password = PASSWORD): Promise<TestAgent> {
  const agent = request.agent(app);
  const r = await agent.post("/api/login").send({ email, password });
  expect(r.status).toBe(200);
  return agent;
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

  config = {
    projectKey: "AIP",
    specPageUrls: ["https://example.atlassian.net/wiki/spaces/X/pages/1/Spec"],
    defaultPriority: "P2",
    staticFields: {},
    language: "auto",
    cacheDir,
    draftsDir,
    teamMembers: [{ name: "T One", email: "t1@example.com" }],
    model: "test-model",
  };

  drafts = new FsDraftStore(draftsDir);
  const users = new FsUserStore(join(dataDir, "users.json"));
  const scrypt = await hashPassword(PASSWORD);
  await users.upsert({ email: ALICE, name: "Alice", level: "l1", scrypt, active: true, createdAt: "2026-07-01T00:00:00.000Z" });
  await users.upsert({ email: BOB, name: "Bob", level: "l2", scrypt, active: true, createdAt: "2026-07-01T00:00:00.000Z" });
  await users.upsert({ email: "gone@example.com", name: "Gone", level: "l1", scrypt, active: false, createdAt: "2026-07-01T00:00:00.000Z" });
  await users.upsert({ email: CAROL, name: "Carol", level: "admin", scrypt, active: true, createdAt: "2026-07-01T00:00:00.000Z" });

  app = buildApp(config, { drafts, users, sessionSecret: "test-secret" });
});

describe("open endpoints", () => {
  it("GET /healthz needs no auth", async () => {
    const r = await request(app).get("/healthz");
    expect(r.body).toEqual({ ok: true });
  });

  it("GET / serves the app shell", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
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

  it("login → /api/me → logout → 401", async () => {
    const agent = await login(ALICE);
    const me = await agent.get("/api/me");
    expect(me.body.user).toMatchObject({ email: ALICE, name: "Alice", level: "l1", jiraEmail: ALICE });
    expect(me.body.user.scrypt).toBeUndefined();

    await agent.post("/api/logout");
    const after = await agent.get("/api/me");
    expect(after.status).toBe(401);
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

    const ok = await agent.post("/api/me/password").send({ oldPassword: PASSWORD, newPassword: "longenough1" });
    expect(ok.status).toBe(200);

    await login(BOB, "longenough1");
    // 还原,避免影响后续用例
    const agent2 = await login(BOB, "longenough1");
    await agent2.post("/api/me/password").send({ oldPassword: "longenough1", newPassword: PASSWORD });
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

  it("L2 saves keep any assignee (no forcing)", async () => {
    const draft = mkDraft([ticket("t1", { assignee: ALICE })], "2026-07-07T08:00:00.000Z");
    const saved = await drafts.write(BOB, draft);
    const agent = await login(BOB);
    const r = await agent.put(`/api/drafts/${saved.id}`).send({ draft });
    expect(r.body.draft.tickets[0].assignee).toBe(ALICE);
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
    expect((await bob.get("/api/admin/users")).status).toBe(403);
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
