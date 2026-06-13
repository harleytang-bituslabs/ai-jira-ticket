/**
 * ajt web — the HTML shell over src/core.
 *
 * Flow: colloquial input → AI splits into 1..N editable ticket cards
 * (core/draft.ts; the AI's field choices are prefills, the human has final
 * say per card) → submit reuses the same submitDraft pipeline as the CLI.
 * The drafts dir doubles as ticketing history: list / edit / resubmit /
 * delete all operate on drafts/*.json. Deleting history never touches Jira.
 *
 * Binds to 127.0.0.1 by default — this box is shared and the server can
 * create Jira tickets with the .env credentials. Reach it via an SSH tunnel
 * (ssh -L 9300:localhost:9300 <server>) or VS Code port forwarding.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import { loadConfig } from "../core/config.js";
import { draftTickets } from "../core/draft.js";
import {
  deleteDraftFiles,
  listDrafts,
  readDraftFile,
  writeDraftFiles,
} from "../core/draft-files.js";
import { DraftFileSchema, type DraftFile } from "../core/schema.js";
import { readIssuesCache, readProjectMeta, writeIssuesCache } from "../core/spec-cache.js";
import { submitDraft } from "../core/submit.js";
import { syncSpec } from "../core/sync-spec.js";
import { searchIssues } from "../clients/jira-client.js";

dotenv.config({ quiet: true });

const HTML_URL = new URL("./index.html", import.meta.url);
const HOST = process.env.AJT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AJT_PORT ?? 9300);

const config = await loadConfig(process.env.AJT_CONFIG ?? "config.json");

// ─── Small HTTP helpers ─────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// ─── Handlers ───────────────────────────────────────────────────────────────

async function handleMeta(res: ServerResponse): Promise<void> {
  const meta = await readProjectMeta(config.cacheDir);
  const issues = await readIssuesCache(config.cacheDir);
  const pick = (i: { key: string; summary: string; status: string; parent: string | null }) => ({
    key: i.key,
    summary: i.summary,
    status: i.status,
    /** Epic key for Story/Task — drives the two-level parent picker for Sub-tasks. */
    parent: i.parent,
  });
  sendJson(res, 200, {
    projectKey: config.projectKey,
    issueTypes: meta.issueTypes.map((t) => ({ name: t.name, subtask: t.subtask })),
    priorities: meta.priorities,
    epics: issues.issues.filter((i) => i.issueType === "Epic" && i.status !== "Done").map(pick),
    standardParents: issues.issues
      .filter((i) => (i.issueType === "Story" || i.issueType === "Task") && i.status !== "Done")
      .map(pick),
    teamMembers: config.teamMembers,
    reporters: config.reporters,
    issuesFetchedAt: issues.fetchedAt,
  });
}

/** Re-pull everything the form depends on: Confluence spec + Jira project meta + the issue list. */
async function handleRefresh(res: ServerResponse): Promise<void> {
  const { spec } = await syncSpec(config);
  const issues = await searchIssues(`project = ${config.projectKey} ORDER BY created ASC`);
  await writeIssuesCache(config.cacheDir, {
    projectKey: config.projectKey,
    fetchedAt: new Date().toISOString(),
    issues,
  });
  sendJson(res, 200, {
    spec: spec.sources.map((s) => `《${s.title}》v${s.version ?? "?"}`).join("、"),
    issueTotal: issues.length,
    epicTotal: issues.filter((i) => i.issueType === "Epic").length,
  });
}

async function handleDraft(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const input = str(body.input);
  if (!input) throw new Error("input 不能为空");
  let splitCount: number | undefined;
  if (body.splitCount != null && body.splitCount !== "") {
    const n = Number(body.splitCount);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("splitCount 须为 1-20 的整数");
    splitCount = n;
  }

  // Field values the filer pre-chose in the form. They go to the model as a
  // directive (so titles/content match, e.g. the [Epic Name] prefix) AND are
  // applied deterministically afterwards so compliance never depends on the
  // model: assignee/dueDate to every ticket, priority to non-Sub-tasks,
  // type + parent to root tickets (AI-made children keep their structure).
  const raw = (body.defaults ?? {}) as Record<string, unknown>;
  const defaults = {
    issueType: str(raw.issueType),
    priority: str(raw.priority),
    parentKey: str(raw.parentKey),
    assignee: str(raw.assignee),
    reporter: str(raw.reporter),
    dueDate: str(raw.dueDate),
  };
  const parts: string[] = [];
  if (defaults.issueType) parts.push(`主票类型 ${defaults.issueType}`);
  if (defaults.parentKey) {
    const issues = await readIssuesCache(config.cacheDir).catch(() => null);
    const title = issues?.issues.find((i) => i.key === defaults.parentKey)?.summary;
    parts.push(`父级 ${defaults.parentKey}${title ? `《${title}》` : ""}`);
  }
  if (defaults.assignee) {
    const name = config.teamMembers.find((m) => m.email === defaults.assignee)?.name ?? defaults.assignee;
    parts.push(`指派 ${name}`);
  }
  if (defaults.dueDate) parts.push(`截止 ${defaults.dueDate}`);
  if (defaults.priority) parts.push(`优先级 ${defaults.priority}`);
  const fieldDirectives = parts.length
    ? `[指定字段: ${parts.join("；")}。这些值已由填单人确定，所有产出的票均须采用]`
    : undefined;

  const draft = await draftTickets(input, {
    config,
    ...(splitCount != null ? { splitCount } : {}),
    ...(fieldDirectives ? { fieldDirectives } : {}),
  });

  for (const t of draft.tickets) {
    // type/parent 只套到根票（AI 拆出的子票保留其层级结构）；其余字段全员套用。
    // 顺序要紧：先定 issueType，最后的 priority 才能据最终类型跳过 Sub-task。
    if (!t.parent) {
      if (defaults.issueType) t.issueType = defaults.issueType;
      if (defaults.parentKey) t.parent = defaults.parentKey;
    }
    if (defaults.assignee) t.assignee = defaults.assignee;
    if (defaults.reporter) t.reporter = defaults.reporter;
    if (defaults.dueDate) t.dueDate = defaults.dueDate;
    if (defaults.priority) t.priority = t.issueType === "Sub-task" ? null : defaults.priority;
  }

  const saved = await writeDraftFiles(draft, config.draftsDir);
  sendJson(res, 200, { id: saved.id, draft });
}

async function handleList(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { drafts: await listDrafts(config.draftsDir) });
}

/**
 * Save card edits. Submitted tickets (jiraKey on disk) are server-enforced
 * read-only: the disk version wins, removal is undone, and a client cannot
 * forge jiraKey onto an unsubmitted ticket. Created links survive likewise.
 */
async function handleSave(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const body = await readJsonBody(req);
  const incoming = DraftFileSchema.parse(body.draft);
  const disk = await readDraftFile(config.draftsDir, id);

  const submittedByLocal = new Map(disk.tickets.filter((t) => t.jiraKey).map((t) => [t.localId, t]));
  const tickets = incoming.tickets.map((t) => {
    const submitted = submittedByLocal.get(t.localId);
    if (submitted) return submitted; // read-only: disk version wins
    const { jiraKey: _k, jiraUrl: _u, ...rest } = t; // strip forged keys
    return rest;
  });
  for (const [localId, t] of submittedByLocal) {
    if (!tickets.some((x) => x.localId === localId)) tickets.unshift(t); // undo removal
  }

  const sameLink = (a: { from: string; to: string; type: string }, b: typeof a) =>
    a.from === b.from && a.to === b.to && a.type === b.type;
  const links = incoming.links.map((l) => ({
    ...l,
    created: disk.links.find((d) => sameLink(d, l))?.created ?? false,
  }));
  for (const d of disk.links) {
    if (d.created && !links.some((l) => sameLink(l, d))) links.push(d); // created links are facts
  }

  const merged = DraftFileSchema.parse({ ...disk, tickets, links, notes: incoming.notes, meta: disk.meta });
  const saved = await writeDraftFiles(merged, config.draftsDir);
  sendJson(res, 200, { id: saved.id, draft: merged });
}

async function handleSubmit(res: ServerResponse, id: string): Promise<void> {
  const draft = await readDraftFile(config.draftsDir, id);
  const meta = await readProjectMeta(config.cacheDir);
  let result: DraftFile;
  try {
    result = await submitDraft(draft, {
      config,
      meta,
      persist: async (d) => {
        await writeDraftFiles(d, config.draftsDir);
      },
    });
  } catch (err) {
    // Partial progress is already persisted; surface it with the error.
    const latest = await readDraftFile(config.draftsDir, id).catch(() => draft);
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err), id, draft: latest });
    return;
  }
  sendJson(res, 200, { id, draft: result });
}

async function handleDelete(res: ServerResponse, id: string): Promise<void> {
  await deleteDraftFiles(config.draftsDir, id);
  sendJson(res, 200, { ok: true });
}

/** Deletes every local record whose tickets are all submitted. */
async function handleCleanup(res: ServerResponse): Promise<void> {
  const entries = await listDrafts(config.draftsDir);
  const done = entries.filter((e) => e.draft.tickets.every((t) => t.jiraKey));
  for (const e of done) await deleteDraftFiles(config.draftsDir, e.id);
  sendJson(res, 200, { removed: done.length });
}

// ─── Router ─────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  void (async () => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const byId = /^\/api\/drafts\/([^/]+)(\/submit)?$/.exec(path);
    try {
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(await readFile(HTML_URL, "utf-8"));
      } else if (req.method === "GET" && path === "/api/meta") {
        await handleMeta(res);
      } else if (req.method === "POST" && path === "/api/refresh") {
        await handleRefresh(res);
      } else if (req.method === "POST" && path === "/api/draft") {
        await handleDraft(req, res);
      } else if (req.method === "GET" && path === "/api/drafts") {
        await handleList(res);
      } else if (req.method === "POST" && path === "/api/drafts/cleanup") {
        await handleCleanup(res);
      } else if (byId && !byId[2] && req.method === "PUT") {
        await handleSave(req, res, byId[1]);
      } else if (byId && byId[2] && req.method === "POST") {
        await handleSubmit(res, byId[1]);
      } else if (byId && !byId[2] && req.method === "DELETE") {
        await handleDelete(res, byId[1]);
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`ajt web 已启动: http://${HOST}:${PORT}  (项目 ${config.projectKey})`);
  if (HOST === "127.0.0.1") {
    console.log(`本机以外访问请走 SSH 隧道: ssh -L ${PORT}:localhost:${PORT} <这台服务器>`);
  }
});
