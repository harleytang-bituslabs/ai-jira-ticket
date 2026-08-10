/**
 * 参考数据刷新：Confluence 规范 + Jira 项目元数据 + 看板快照 + 全站名册。
 *
 * 两个入口共用这一份：管理员点「更新config」（POST /api/refresh），以及进程
 * 启动时的自检 —— 容器镜像里 .cache/ 是空的，没有它 /api/meta 会直接报错，
 * 新部署的第一个访客就撞墙。
 */

import { listAssignableUsers, searchIssues } from "../../clients/jira-client.js";
import type { ResolvedConfig } from "../../core/config.js";
import { readProjectMeta, writeIssuesCache, writeUsersCache } from "../../core/spec-cache.js";
import { syncSpec } from "../../core/sync-spec.js";

export interface RefreshResult {
  spec: string;
  issueTotal: number;
  epicTotal: number;
  userTotal: number;
}

export async function refreshAll(config: ResolvedConfig): Promise<RefreshResult> {
  const { spec } = await syncSpec(config);
  const issues = await searchIssues(`project = ${config.projectKey} ORDER BY created ASC`);
  await writeIssuesCache(config.cacheDir, {
    projectKey: config.projectKey,
    fetchedAt: new Date().toISOString(),
    issues,
  });
  const users = await listAssignableUsers(config.projectKey);
  await writeUsersCache(config.cacheDir, { fetchedAt: new Date().toISOString(), total: users.length, users });
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
export async function ensureCaches(config: ResolvedConfig): Promise<void> {
  const present = await readProjectMeta(config.cacheDir).then(
    () => true,
    () => false,
  );
  if (present) return;
  console.log("缓存为空（新部署）——正在拉取规范/看板/名册 …");
  try {
    const r = await refreshAll(config);
    console.log(`✓ 缓存已就绪: ${r.spec} · ${r.issueTotal} 张票 · ${r.userTotal} 名用户`);
  } catch (err) {
    console.warn(`⚠ 首启缓存拉取失败（服务照常启动，登录后点「更新config」重试）: ${err instanceof Error ? err.message : err}`);
  }
}
