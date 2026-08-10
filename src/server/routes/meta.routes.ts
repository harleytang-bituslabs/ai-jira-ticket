/** /api/meta + /api/refresh — the form's reference data and its refresh. */

import { Router } from "express";
import type { ResolvedConfig } from "../../core/config.js";
import { readIssuesCache, readProjectMeta, readRoster, readSpecCache } from "../../core/spec-cache.js";
import type { CacheStore } from "../../stores/cache-store.js";
import type { UserRecord, UserStore } from "../../stores/user-store.js";
import { teamRoster } from "../services/policy.js";
import { refreshAll } from "../services/refresh.js";

type RosterMember = { name: string; email: string };

/**
 * 名册取自项目参与者,所以还没被派过票的新人不在里面 —— 但他至少得能把票派给自己。
 * 保底把本人并进去(已在其中则不动),并保持按姓名排序。
 */
function withSelf(members: RosterMember[], user: UserRecord): RosterMember[] {
  if (members.some((m) => m.email.toLowerCase() === user.email.toLowerCase())) return members;
  return [...members, { name: user.name, email: user.email }].sort((a, b) => a.name.localeCompare(b.name));
}

export function metaRoutes(config: ResolvedConfig, cache: CacheStore, users: UserStore): Router {
  const router = Router();

  const rosterFor = async (user: UserRecord): Promise<RosterMember[]> => {
    if (user.level === "l1") return [{ name: user.name, email: user.email }];
    if (user.level === "l2") return teamRoster(user, users);
    const roster = await readRoster(cache);
    return withSelf(roster.members.length ? roster.members : config.teamMembers, user);
  };

  router.get("/meta", async (req, res) => {
    const meta = await readProjectMeta(cache);
    const issues = await readIssuesCache(cache);
    // L2/admin 的指派名册:优先本项目参与者缓存,还没拉过时退回 config.teamMembers
    const roster = await readRoster(cache);
    // 「更新config」同时刷这三份;单独跑 CLI 的 sync-spec / fetch-issues 会让它们分叉,
    // 所以三个时间都回给前端,由界面决定说一句话还是分开说。
    const spec = await readSpecCache(cache).catch(() => null);
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
      // 指派名册按级别收窄:admin = 全项目参与者(+本人);l2 = 本团队账号;l1 = 只有本人(界面本就锁定)
      roster: await rosterFor(req.user!),
      specSyncedAt: spec?.syncedAt ?? null,
      issuesFetchedAt: issues.fetchedAt,
      rosterFetchedAt: roster.fetchedAt,
    });
  });

  /** Re-pull everything the form depends on: Confluence spec + Jira project meta + issue list + user roster. */
  router.post("/refresh", async (_req, res) => {
    res.json(await refreshAll(config, cache));
  });

  return router;
}
