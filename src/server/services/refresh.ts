/**
 * 参考数据刷新：Confluence 规范 + Jira 项目元数据 + 看板快照 + 全站名册。
 *
 * 两个入口共用这一份：管理员点「更新config」（POST /api/refresh），以及进程
 * 启动时的自检 —— 容器镜像里 .cache/ 是空的，没有它 /api/meta 会直接报错，
 * 新部署的第一个访客就撞墙。
 */

import { listProjectParticipants, listProjects, searchIssues } from "../../clients/jira-client.js";
import type { ResolvedConfig } from "../../core/config.js";
import type { CacheStore } from "../../stores/cache-store.js";
import { readProjectMeta, writeIssuesCache, writeProjectsCache, writeUsersCache } from "../../core/spec-cache.js";
import { syncSpec } from "../../core/sync-spec.js";

export interface RefreshResult {
  spec: string;
  issueTotal: number;
  epicTotal: number;
  userTotal: number;
}

export async function refreshAll(config: ResolvedConfig, cache: CacheStore): Promise<RefreshResult> {
  const { spec } = await syncSpec(config, cache);
  const issues = await searchIssues(`project = ${config.projectKey} ORDER BY created ASC`);
  await writeIssuesCache(cache, {
    projectKey: config.projectKey,
    fetchedAt: new Date().toISOString(),
    issues,
  });
  // 名册取「在这个项目里真干过活的人」,而不是「Jira 允许被指派的人」——后者在本站
  // 等于全公司,分不出项目。代价见 listProjectParticipants 的注释。
  const users = await listProjectParticipants(config.projectKey);
  await writeUsersCache(cache, { fetchedAt: new Date().toISOString(), total: users.length, users });
  // 全公司 board 清单:管理页授权可见 board 的候选(列全公司,勾已可见)
  const projects = await listProjects();
  await writeProjectsCache(cache, { fetchedAt: new Date().toISOString(), projects });
  return {
    spec: spec.sources.map((s) => `《${s.title}》v${s.version ?? "?"}`).join("、"),
    issueTotal: issues.length,
    epicTotal: issues.filter((i) => i.issueType === "Epic").length,
    userTotal: users.length,
  };
}

/**
 * 缓存缺失时拉一次（容器首启/新机器）。刻意不致命：Atlassian 挂了也让服务起来，
 * 管理员进界面点「更新config」即可补齐。
 */
export async function ensureCaches(config: ResolvedConfig, cache: CacheStore): Promise<void> {
  const present = await readProjectMeta(cache).then(
    () => true,
    () => false,
  );
  if (present) return;
  console.log("缓存为空（新部署）——正在拉取规范/看板/名册 …");
  try {
    const r = await refreshAll(config, cache);
    console.log(`✓ 缓存已就绪: ${r.spec} · ${r.issueTotal} 张票 · ${r.userTotal} 名用户`);
  } catch (err) {
    console.warn(`⚠ 首启缓存拉取失败（服务照常启动，登录后点「更新config」重试）: ${err instanceof Error ? err.message : err}`);
  }
}
