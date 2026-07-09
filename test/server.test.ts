import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/core/config.js";
import { writeDraftFiles } from "../src/core/draft-files.js";
import { DraftFileSchema, type DraftFile, type Ticket } from "../src/core/schema.js";
import { buildApp } from "../src/server/app.js";

let app: ReturnType<typeof buildApp>;
let config: ResolvedConfig;

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

beforeAll(async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ajt-cache-"));
  const draftsDir = await mkdtemp(join(tmpdir(), "ajt-drafts-"));
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
  app = buildApp(config);
});

describe("routing basics", () => {
  it("GET / serves the app page", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("AI 开票");
  });

  it("GET /healthz is open and OK", async () => {
    const r = await request(app).get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("unknown route → 404 {error}", async () => {
    const r = await request(app).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not found");
  });

  it("malformed JSON body → 400 with friendly message", async () => {
    const r = await request(app).post("/api/draft").set("Content-Type", "application/json").send("{oops");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("JSON");
  });
});

describe("GET /api/meta", () => {
  it("returns project facts from the cache", async () => {
    const r = await request(app).get("/api/meta");
    expect(r.status).toBe(200);
    expect(r.body.projectKey).toBe("AIP");
    expect(r.body.priorities).toEqual(["P0", "P1", "P2"]);
    expect(r.body.epics).toEqual([expect.objectContaining({ key: "AIP-1" })]);
    expect(r.body.standardParents).toEqual([expect.objectContaining({ key: "AIP-2", parent: "AIP-1" })]);
  });
});

describe("POST /api/draft validation (rejected before any LLM call)", () => {
  it("missing input → 400", async () => {
    const r = await request(app).post("/api/draft").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("input");
  });

  it("bad splitCount → 400", async () => {
    const r = await request(app).post("/api/draft").send({ input: "做个东西", splitCount: 99 });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("splitCount");
  });
});

describe("draft lifecycle on the fs store", () => {
  it("PUT enforces merge protection: submitted read-only, forged keys stripped, removal undone", async () => {
    const draft = mkDraft(
      [ticket("t1", { jiraKey: "AIP-100", jiraUrl: "https://x/browse/AIP-100" }), ticket("t2")],
      "2026-07-01T08:00:00.000Z",
    );
    const saved = await writeDraftFiles(draft, config.draftsDir);

    // 客户端手笔:删掉已提交的 t1、改 t2 并伪造 jiraKey
    const edited = structuredClone(draft);
    edited.tickets = [{ ...edited.tickets[1], summary: "[Some Epic] Edited", jiraKey: "AIP-999" }];
    const r = await request(app).put(`/api/drafts/${saved.id}`).send({ draft: edited });
    expect(r.status).toBe(200);

    const tickets = r.body.draft.tickets as Array<Record<string, unknown>>;
    const t1 = tickets.find((t) => t.localId === "t1");
    const t2 = tickets.find((t) => t.localId === "t2");
    expect(t1?.jiraKey).toBe("AIP-100"); // 被删除的已提交票找回、原样保留
    expect(t2?.summary).toBe("[Some Epic] Edited"); // 未提交票的编辑生效
    expect(t2?.jiraKey).toBeUndefined(); // 伪造的 key 被剥掉
  });

  it("GET /api/drafts lists, DELETE removes", async () => {
    const draft = mkDraft([ticket("t1")], "2026-07-02T08:00:00.000Z");
    const saved = await writeDraftFiles(draft, config.draftsDir);

    const list = await request(app).get("/api/drafts");
    expect(list.body.drafts.some((d: { id: string }) => d.id === saved.id)).toBe(true);

    const del = await request(app).delete(`/api/drafts/${saved.id}`);
    expect(del.body).toEqual({ ok: true });
    const after = await request(app).get("/api/drafts");
    expect(after.body.drafts.some((d: { id: string }) => d.id === saved.id)).toBe(false);
  });

  it("cleanup removes only fully-submitted records", async () => {
    const done = mkDraft([ticket("t1", { jiraKey: "AIP-101", jiraUrl: "https://x/browse/AIP-101" })], "2026-07-03T08:00:00.000Z");
    const pending = mkDraft([ticket("t1")], "2026-07-04T08:00:00.000Z");
    const savedDone = await writeDraftFiles(done, config.draftsDir);
    const savedPending = await writeDraftFiles(pending, config.draftsDir);

    const r = await request(app).post("/api/drafts/cleanup");
    expect(r.status).toBe(200);
    expect(r.body.removed).toBeGreaterThanOrEqual(1);

    const list = await request(app).get("/api/drafts");
    const ids = list.body.drafts.map((d: { id: string }) => d.id);
    expect(ids).not.toContain(savedDone.id);
    expect(ids).toContain(savedPending.id);
  });
});
