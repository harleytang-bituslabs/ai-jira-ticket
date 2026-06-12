/**
 * Local cache written by sync-spec and read by draft/submit.
 *
 * Two files under the cache dir:
 *   - spec.md          — the ticketing conventions as markdown, with a small
 *                        frontmatter recording where/when it came from. The
 *                        body is injected byte-for-byte into the system
 *                        prompt, which is what makes Anthropic prompt caching
 *                        effective across draft calls.
 *   - project-meta.json — issue types / priorities / link types from Jira.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectMeta } from "../clients/jira-client.js";
import { atomicWrite } from "../utils/fs.js";

const SPEC_FILE = "spec.md";
const META_FILE = "project-meta.json";

export interface SpecSource {
  url: string;
  title: string;
  /** Confluence page version at sync time — cheap staleness signal for later. */
  version: number | null;
}

export interface SpecCache {
  markdown: string;
  sources: SpecSource[];
  syncedAt: string;
}

export async function writeSpecCache(dir: string, cache: SpecCache): Promise<void> {
  await mkdir(dir, { recursive: true });
  const frontmatter = ["---", `syncedAt: ${cache.syncedAt}`, `sources: ${JSON.stringify(cache.sources)}`, "---", ""].join(
    "\n",
  );
  await atomicWrite(join(dir, SPEC_FILE), frontmatter + cache.markdown);
}

export async function readSpecCache(dir: string): Promise<SpecCache> {
  let raw: string;
  try {
    raw = await readFile(join(dir, SPEC_FILE), "utf-8");
  } catch {
    throw new Error(`No spec cache found at ${dir}/${SPEC_FILE} — run \`ajt sync-spec\` first`);
  }
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) {
    throw new Error(`${dir}/${SPEC_FILE} is missing its frontmatter — re-run \`ajt sync-spec\``);
  }
  const fields = new Map(
    m[1].split("\n").map((line) => {
      const i = line.indexOf(": ");
      return [line.slice(0, i), line.slice(i + 2)] as const;
    }),
  );
  return {
    markdown: raw.slice(m[0].length),
    syncedAt: fields.get("syncedAt") ?? "",
    sources: JSON.parse(fields.get("sources") ?? "[]") as SpecSource[],
  };
}

export async function writeProjectMeta(dir: string, meta: ProjectMeta): Promise<void> {
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, META_FILE), JSON.stringify(meta, null, 2) + "\n");
}

export async function readProjectMeta(dir: string): Promise<ProjectMeta> {
  try {
    return JSON.parse(await readFile(join(dir, META_FILE), "utf-8")) as ProjectMeta;
  } catch {
    throw new Error(`No project metadata found at ${dir}/${META_FILE} — run \`ajt sync-spec\` first`);
  }
}

export function cacheAgeDays(cache: SpecCache): number {
  const t = Date.parse(cache.syncedAt);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - t) / 86_400_000);
}
