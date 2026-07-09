/** /api/meta + /api/refresh — the form's reference data and its refresh. */

import { Router } from "express";
import { listUsers, searchIssues } from "../../clients/jira-client.js";
import type { ResolvedConfig } from "../../core/config.js";
import { readIssuesCache, readProjectMeta, readRoster, writeIssuesCache, writeUsersCache } from "../../core/spec-cache.js";
import { syncSpec } from "../../core/sync-spec.js";

export function metaRoutes(config: ResolvedConfig): Router {
  const router = Router();

  router.get("/meta", async (_req, res) => {
    const meta = await readProjectMeta(config.cacheDir);
    const issues = await readIssuesCache(config.cacheDir);
    // L2/admin 的指派名册:优先 Jira 全站活跃用户缓存,还没拉过时退回 config.teamMembers
    const roster = await readRoster(config.cacheDir);
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
      roster: roster.length ? roster : config.teamMembers,
      issuesFetchedAt: issues.fetchedAt,
    });
  });

  /** Re-pull everything the form depends on: Confluence spec + Jira project meta + the issue list + the user roster. */
  router.post("/refresh", async (_req, res) => {
    const { spec } = await syncSpec(config);
    const issues = await searchIssues(`project = ${config.projectKey} ORDER BY created ASC`);
    await writeIssuesCache(config.cacheDir, {
      projectKey: config.projectKey,
      fetchedAt: new Date().toISOString(),
      issues,
    });
    const siteUsers = await listUsers();
    await writeUsersCache(config.cacheDir, { fetchedAt: new Date().toISOString(), total: siteUsers.length, users: siteUsers });
    res.json({
      spec: spec.sources.map((s) => `《${s.title}》v${s.version ?? "?"}`).join("、"),
      issueTotal: issues.length,
      epicTotal: issues.filter((i) => i.issueType === "Epic").length,
      userTotal: siteUsers.length,
    });
  });

  return router;
}
