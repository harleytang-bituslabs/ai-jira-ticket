/**
 * Draft persistence shared by the CLI and the web server: every draft lands
 * in the drafts dir as <stamp>-<slug>.json (source of truth) plus a same-name
 * .md preview. The drafts dir doubles as the ticketing history — submit
 * writes jiraKey back into the file, so a ticket's status is derivable
 * (jiraKey ⇒ submitted, else draft) and "history" is just list/read/delete
 * over this directory.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../utils/fs.js";
import { renderDraftMarkdown } from "./render.js";
import { DraftFileSchema, type DraftFile } from "./schema.js";

/** Stamp + slug (slug may contain CJK). Guards every by-id file operation. */
const DRAFT_ID_RE = /^[\w一-鿿-]+$/;

export function assertDraftId(id: string): void {
  if (!DRAFT_ID_RE.test(id)) throw new Error(`非法的草稿 id: ${id}`);
}

export function draftBaseName(draft: DraftFile): string {
  const d = new Date(draft.meta.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
  const words = draft.tickets[0]?.summary.match(/[\p{L}\p{N}]+/gu) ?? [];
  const slug = words.join("-").slice(0, 24).replace(/-+$/, "") || "draft";
  return `${stamp}-${slug}`;
}

/** Writes (or re-writes) both draft files; stable path for a given draft. */
export async function writeDraftFiles(
  draft: DraftFile,
  draftsDir: string,
): Promise<{ id: string; jsonPath: string; mdPath: string }> {
  await mkdir(draftsDir, { recursive: true });
  const id = draftBaseName(draft);
  const jsonPath = join(draftsDir, `${id}.json`);
  const mdPath = join(draftsDir, `${id}.md`);
  await atomicWrite(jsonPath, JSON.stringify(draft, null, 2) + "\n");
  await atomicWrite(mdPath, renderDraftMarkdown(draft));
  return { id, jsonPath, mdPath };
}

export interface DraftListEntry {
  id: string;
  draft: DraftFile;
}

/** All drafts newest-first. A single corrupt file is skipped, never fatal. */
export async function listDrafts(draftsDir: string): Promise<DraftListEntry[]> {
  let files: string[];
  try {
    files = await readdir(draftsDir);
  } catch {
    return [];
  }
  const entries: DraftListEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const draft = DraftFileSchema.parse(JSON.parse(await readFile(join(draftsDir, f), "utf-8")));
      entries.push({ id: f.slice(0, -".json".length), draft });
    } catch {
      // corrupt or foreign file — history must still render
    }
  }
  entries.sort((a, b) => b.draft.meta.createdAt.localeCompare(a.draft.meta.createdAt));
  return entries;
}

export async function readDraftFile(draftsDir: string, id: string): Promise<DraftFile> {
  assertDraftId(id);
  let raw: string;
  try {
    raw = await readFile(join(draftsDir, `${id}.json`), "utf-8");
  } catch {
    throw new Error(`草稿 ${id} 不存在`);
  }
  return DraftFileSchema.parse(JSON.parse(raw));
}

/** Removes the local record (json + md). Never touches Jira. */
export async function deleteDraftFiles(draftsDir: string, id: string): Promise<void> {
  assertDraftId(id);
  await rm(join(draftsDir, `${id}.json`), { force: true });
  await rm(join(draftsDir, `${id}.md`), { force: true });
}
