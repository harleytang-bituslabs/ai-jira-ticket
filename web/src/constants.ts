/** 值级配色、类型排序、必填规则——开票表单与卡片共用（等价迁移自 1.x）。 */

import type { Meta, Ticket, User, UserLevel } from "./types";

/** 类型固定顺序（Bug 殿后）。 */
export const TYPE_ORDER = ["Epic", "Story", "Task", "Sub-task", "Bug"];

/** 类型：蓝色深浅表层级（Story/Task 同级同色），Bug 殿后用暖色警示。 */
export const TYPE_COLORS: Record<string, string> = {
  Epic: "#1e3a8a",
  Story: "#1d4ed8",
  Task: "#1d4ed8",
  "Sub-task": "#3b82f6",
  Bug: "#f59e0b",
};

/** 优先级：红橙黄绿灰，干净鲜亮的现代 UI 色（P1/P2 向黄偏移拉开层次）。 */
export const PRIORITY_COLORS: Record<string, string> = {
  P0: "#ef4444",
  P1: "#f59e0b",
  P2: "#ffd60a",
  P3: "#22c55e",
  Lowest: "#94a3b8",
};

export const LEVEL_LABELS: Record<UserLevel, string> = { l1: "普通", l2: "高级", admin: "管理员" };

export const isSubmitted = (t: Ticket): boolean => Boolean(t.jiraKey);

export function orderedTypes(meta: Meta, user: User): Array<{ name: string; subtask: boolean }> {
  const sorted = [...meta.issueTypes].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a.name);
    const ib = TYPE_ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  // L1 不允许建 Epic：直接不给选项（服务端仍有强制兜底）
  return user.level === "l1" ? sorted.filter((t) => t.name !== "Epic") : sorted;
}

// ─── 必填规则（提交前强制）────────────────────────────────────────────────────
// 父级、截止日期必填；优先级必填但 Sub-task 例外（规范规定 Sub-task 不使用优先级）；
// 指派对 Sub-task 必填（Jira 创建门要求），其他类型可选。

export function missingFields(t: Ticket): string[] {
  const miss: string[] = [];
  if (t.issueType !== "Epic" && !t.parent) miss.push("父级");
  if (t.issueType !== "Sub-task" && !t.priority) miss.push("优先级");
  if (!t.dueDate) miss.push("截止日期");
  if (t.issueType === "Sub-task" && !t.assignee) miss.push("指派");
  return miss;
}

export const FIELD_TO_CONTROL: Record<string, string> = {
  父级: "parent",
  优先级: "priority",
  截止日期: "dueDate",
  指派: "assignee",
};
