/**
 * 权限策略(服务端强制,前端隐藏只是体验):
 *
 *   L1  不允许 Epic;assignee 强制 = 本人(登录用的工作邮箱即 Jira 身份)
 *   L2  无内容限制
 *   admin  同 L2;额外能力(全员历史、跨用户删除、用户管理)在路由层守卫
 *
 * 已提交的票(jiraKey)是既成事实,不参与校验或改写。
 */

import type { DraftFile } from "../../core/schema.js";
import type { UserRecord } from "../../stores/user-store.js";
import { HttpError } from "../middlewares/error.js";

/** 本人在 Jira 侧的身份 —— 登录名就是工作邮箱,两边同一个。 */
export const jiraIdentity = (user: UserRecord): string => user.email;

/**
 * board 可见性。单独导出是因为生成路径要在调用 LLM *之前* 就挡住 ——
 * enforcePolicy 在那条路径上是拿到 AI 产物之后才跑的兜底。
 *
 * admin 恒定可见全部 board,不看 boards 字段:否则第一个管理员会把自己锁在门外。
 */
export function assertBoardVisible(user: UserRecord, projectKey: string): void {
  if (user.level === "admin") return;
  if (!user.boards.includes(projectKey)) {
    throw new HttpError(403, `你没有 ${projectKey} 的开票权限,请联系管理员开通`);
  }
}

/** draft / save / submit 三条路径共用的策略执行点。会就地改写 assignee。 */
export function enforcePolicy(user: UserRecord, draft: DraftFile): void {
  assertBoardVisible(user, draft.meta.projectKey);
  if (user.level !== "l1") return;
  const self = jiraIdentity(user);
  for (const t of draft.tickets) {
    if (t.jiraKey) continue;
    if (t.issueType === "Epic") {
      throw new HttpError(403, "低级账号不能创建 Epic 类型的票");
    }
    t.assignee = self;
  }
}
