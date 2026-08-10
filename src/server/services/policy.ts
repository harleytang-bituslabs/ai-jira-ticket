/**
 * 权限策略(服务端强制,前端隐藏只是体验):
 *
 *   L1  不允许 Epic;assignee 强制 = 本人(登录用的工作邮箱即 Jira 身份)
 *   L2  指派范围 = 本团队(账号 team 相同的活跃账号)+ 自己;没设团队就只有自己。
 *       团队只存在于 ajt 账号上,所以没建号的同事 L2 派不了 —— 这是有意的。
 *   admin  不受限;额外能力(全员历史、跨用户删除、用户管理)在路由层守卫
 *
 * 已提交的票(jiraKey)是既成事实,不参与校验或改写。
 */

import type { DraftFile } from "../../core/schema.js";
import type { UserRecord, UserStore } from "../../stores/user-store.js";
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

/** L2 在界面上可选的指派名册:本人置顶,其余本团队活跃账号按姓名。没设团队 = 只有自己。 */
export async function teamRoster(user: UserRecord, users: UserStore): Promise<Array<{ name: string; email: string }>> {
  const members = user.team
    ? (await users.all()).filter((u) => u.active && u.team === user.team)
    : [user];
  const withSelf = members.some((m) => m.email === user.email) ? members : [...members, user];
  return withSelf
    .map((m) => ({ name: m.name, email: m.email }))
    .sort((a, b) => (a.email === user.email ? -1 : b.email === user.email ? 1 : a.name.localeCompare(b.name)));
}

/** L2 的单个指派是否越界。draft / save / submit 由 enforcePolicy 统一走这里;生成路径在调 LLM 前单独调一次。 */
export async function assertAssigneeAllowed(user: UserRecord, assignee: string | null | undefined, users: UserStore): Promise<void> {
  if (user.level !== "l2" || !assignee) return; // l1 被强制改写,admin 不受限
  const allowed = new Set((await teamRoster(user, users)).map((m) => m.email.toLowerCase()));
  if (!allowed.has(assignee.toLowerCase())) {
    throw new HttpError(
      403,
      user.team
        ? `高级账号只能指派给本团队（${user.team}）的成员：${assignee} 不在其中`
        : "你的账号还没设置团队，暂时只能指派给自己 —— 请联系管理员在管理页设置",
    );
  }
}

/** draft / save / submit 三条路径共用的策略执行点。会就地改写 L1 的 assignee。 */
export async function enforcePolicy(user: UserRecord, draft: DraftFile, users: UserStore): Promise<void> {
  assertBoardVisible(user, draft.meta.projectKey);
  if (user.level === "admin") return;
  if (user.level === "l1") {
    const self = jiraIdentity(user);
    for (const t of draft.tickets) {
      if (t.jiraKey) continue;
      if (t.issueType === "Epic") {
        throw new HttpError(403, "低级账号不能创建 Epic 类型的票");
      }
      t.assignee = self;
    }
    return;
  }
  // l2:逐票校验指派范围(未提交的才管;没指派的票放行)
  for (const t of draft.tickets) {
    if (t.jiraKey) continue;
    await assertAssigneeAllowed(user, t.assignee, users);
  }
}
