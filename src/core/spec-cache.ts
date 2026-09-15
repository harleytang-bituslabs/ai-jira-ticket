/**
 * Shared reference data behind a CacheStore (local dir for the CLI, one S3
 * prefix for the web service), written by sync-spec / fetch-issues / 「更新
 * config」 and read by draft, submit and the web UI:
 *   - spec.md           — ticketing conventions as markdown with frontmatter
 *                         (source/version/syncedAt). The body is injected
 *                         byte-for-byte into system prompts, which is what
 *                         makes Anthropic prompt caching effective.
 *   - project-meta.json — issue types / priorities / link types from Jira.
 *   - issues.json       — the project's tickets (npm run fetch-issues).
 */

import type { JiraIssueSummary, ProjectMeta } from "../clients/jira-client.js";
import type { CacheStore } from "../stores/cache-store.js";
import { invalid } from "./errors.js";

const SPEC_FILE = "spec.md";
const META_FILE = "project-meta.json";
const ISSUES_FILE = "issues.json";

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

export async function writeSpecCache(store: CacheStore, cache: SpecCache): Promise<void> {
  const frontmatter = ["---", `syncedAt: ${cache.syncedAt}`, `sources: ${JSON.stringify(cache.sources)}`, "---", ""].join(
    "\n",
  );
  await store.write(SPEC_FILE, frontmatter + cache.markdown);
}

export async function readSpecCache(store: CacheStore): Promise<SpecCache> {
  const raw = await store.read(SPEC_FILE);
  if (raw === null) {
    throw invalid("cache_missing", "参考数据还没准备好 —— 请点「更新config」拉取后重试", {
      detail: `No ${SPEC_FILE} in the cache; run \`ajt sync-spec\` or POST /api/refresh`,
    });
  }
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) {
    throw invalid("cache_missing", "参考数据格式不完整 —— 请点「更新config」重新拉取", {
      detail: `${SPEC_FILE} is missing its frontmatter; re-run \`ajt sync-spec\``,
    });
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

export async function writeProjectMeta(store: CacheStore, meta: ProjectMeta): Promise<void> {
  await store.write(META_FILE, JSON.stringify(meta, null, 2) + "\n");
}

export async function readProjectMeta(store: CacheStore): Promise<ProjectMeta> {
  const raw = await store.read(META_FILE);
  if (raw === null) {
    throw invalid("cache_missing", "项目配置还没准备好 —— 请点「更新config」拉取后重试", {
      detail: `No ${META_FILE} in the cache; run \`ajt sync-spec\` or POST /api/refresh`,
    });
  }
  return JSON.parse(raw) as ProjectMeta;
}

export function cacheAgeDays(cache: SpecCache): number {
  const t = Date.parse(cache.syncedAt);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// ─── Board snapshot (issues.json, written by `npm run fetch-issues`) ────────

export interface IssuesCache {
  projectKey: string;
  fetchedAt: string;
  issues: JiraIssueSummary[];
}

export async function writeIssuesCache(store: CacheStore, cache: IssuesCache): Promise<void> {
  await store.write(ISSUES_FILE, JSON.stringify(cache, null, 2) + "\n");
}

export async function readIssuesCache(store: CacheStore): Promise<IssuesCache> {
  const raw = await store.read(ISSUES_FILE);
  if (raw === null) {
    throw invalid("cache_missing", "看板快照还没准备好 —— 请点「更新config」拉取后重试", {
      detail: `No ${ISSUES_FILE} in the cache; run \`npm run fetch-issues\` or POST /api/refresh`,
    });
  }
  return JSON.parse(raw) as IssuesCache;
}

// ─── Company board list (projects.json, written by /api/refresh) ────────────

const PROJECTS_FILE = "projects.json";

export interface ProjectsCache {
  fetchedAt: string;
  projects: Array<{ key: string; name: string }>;
}

export async function writeProjectsCache(store: CacheStore, cache: ProjectsCache): Promise<void> {
  await store.write(PROJECTS_FILE, JSON.stringify(cache, null, 2) + "\n");
}

/** 缺失时给空清单而不是报错 —— 调用方须自行把已接入的 board 兜底进去。 */
export async function readProjectsCache(store: CacheStore): Promise<ProjectsCache> {
  try {
    const raw = await store.read(PROJECTS_FILE);
    if (raw === null) return { fetchedAt: "", projects: [] };
    return JSON.parse(raw) as ProjectsCache;
  } catch {
    return { fetchedAt: "", projects: [] };
  }
}

// ─── Participant roster (users.json, written by fetch-users / /api/refresh) ─

const USERS_FILE = "users.json";

export interface UsersCache {
  fetchedAt: string;
  total: number;
  users: Array<{ accountId: string; displayName: string; email: string | null }>;
}

export async function writeUsersCache(store: CacheStore, cache: UsersCache): Promise<void> {
  await store.write(USERS_FILE, JSON.stringify(cache, null, 2) + "\n");
}

/**
 * Assignee roster for the web form: cached project participants with a visible
 * email. Returns an empty list (and null timestamp) when the cache doesn't
 * exist yet, so a fresh deployment degrades to config.teamMembers rather than
 * erroring.
 */
export async function readRoster(store: CacheStore): Promise<{ fetchedAt: string | null; members: Array<{ name: string; email: string }> }> {
  try {
    const raw = await store.read(USERS_FILE);
    if (raw === null) return { fetchedAt: null, members: [] };
    const doc = JSON.parse(raw) as UsersCache;
    return {
      fetchedAt: doc.fetchedAt ?? null,
      members: doc.users
        .filter((u): u is { accountId: string; displayName: string; email: string } => Boolean(u.email))
        .map((u) => ({ name: u.displayName, email: u.email }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch {
    return { fetchedAt: null, members: [] };
  }
}
