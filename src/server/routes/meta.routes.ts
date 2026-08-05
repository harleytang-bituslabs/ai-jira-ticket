/** /api/meta + /api/refresh — the form's reference data and its refresh. */

import { Router } from "express";
import type { ResolvedConfig } from "../../core/config.js";
import { readIssuesCache, readProjectMeta, readRoster, readSpecCache } from "../../core/spec-cache.js";
import { refreshAll } from "../services/refresh.js";

export function metaRoutes(config: ResolvedConfig): Router {
  const router = Router();

  router.get("/meta", async (_req, res) => {
    const meta = await readProjectMeta(config.cacheDir);
    const issues = await readIssuesCache(config.cacheDir);
    // L2/admin 的指派名册:优先 Jira 全站活跃用户缓存,还没拉过时退回 config.teamMembers
    const roster = await readRoster(config.cacheDir);
    // 「更新config」同时刷这三份;单独跑 CLI 的 sync-spec / fetch-issues 会让它们分叉,
    // 所以三个时间都回给前端,由界面决定说一句话还是分开说。
    const spec = await readSpecCache(config.cacheDir).catch(() => null);
    const pick = (i: { key: string; summary: string; status: string; parent: string | null }) => ({
      key: i.key,
      summary: i.summary,
      status: i.status,
      /** Epic key for Story/Task — drives the two-level parent picker for Sub-tasks. */
      parent: i.parent,
    });
    res.json({
      projectKey: config.projectKey,
      issueTypes: meta.issueTypes.map((t) => ({ name: t.name, subtask: t.subtask })),
      priorities: meta.priorities,
      epics: issues.issues.filter((i) => i.issueType === "Epic" && i.status !== "Done").map(pick),
      standardParents: issues.issues
        .filter((i) => (i.issueType === "Story" || i.issueType === "Task") && i.status !== "Done")
        .map(pick),
      roster: roster.members.length ? roster.members : config.teamMembers,
      specSyncedAt: spec?.syncedAt ?? null,
      issuesFetchedAt: issues.fetchedAt,
      rosterFetchedAt: roster.fetchedAt,
    });
  });

  /** Re-pull everything the form depends on: Confluence spec + Jira project meta + issue list + user roster. */
  router.post("/refresh", async (_req, res) => {
    res.json(await refreshAll(config));
  });

  return router;
}
