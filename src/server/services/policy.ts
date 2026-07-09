/**
 * 权限策略(服务端强制,前端隐藏只是体验):
 *
 *   L1  不允许 Epic;assignee 强制 = 本人(jiraEmail ?? email)
 *   L2  无内容限制
 *   admin  同 L2;额外能力(全员历史、跨用户删除、用户管理)在路由层守卫
 *
 * 已提交的票(jiraKey)是既成事实,不参与校验或改写。
 */

import type { DraftFile } from "../../core/schema.js";
import type { UserRecord } from "../../stores/user-store.js";
import { HttpError } from "../middlewares/error.js";

/** 本人在 Jira 侧的身份(登录邮箱与 Jira 邮箱不一致时由管理员配置 jiraEmail)。 */
export const jiraIdentity = (user: UserRecord): string => user.jiraEmail ?? user.email;

/** draft / save / submit 三条路径共用的策略执行点。会就地改写 assignee。 */
export function enforcePolicy(user: UserRecord, draft: DraftFile): void {
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
