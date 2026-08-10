/** 值级配色、类型排序、必填规则——开票表单与卡片共用（等价迁移自 1.x）。 */

import type { Meta, RosterMember, Ticket, User, UserLevel } from "./types";

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

/** 团队的可选项(l2 派活范围按它圈定)。与服务端 src/stores/user-store.ts 的 TEAMS 必须一致。 */
export const TEAMS = ["AI", "MLE", "Art", "Devops", "BO", "Leader"] as const;

/** 开票表单进来时预选的类型（团队日常开的绝大多数是子任务）。 */
export const DEFAULT_TYPE = "Sub-task";

/**
 * 父级下拉的选项文字。刻意几乎不截断：本项目的标题普遍带 [Epic][模块] 前缀，
 * 区分度往往在四五十字之后（`[AI Model] [Standardized Infras Processing] …`
 * 这样的前缀就占 44 字），截短会让不同的票看起来一模一样。
 * 下拉弹层的宽度由浏览器按最长选项自动撑开，长文字不影响收起时的控件宽度；
 * 这里的上限只是防个别异常长标题把弹层撑到离谱。
 */
export const parentOptionLabel = (prefix: string, summary: string): string =>
  `${prefix} · ${summary.length > 120 ? summary.slice(0, 120) + "…" : summary}`;

/** 本地时间 YYYY-MM-DD HH:mm —— 比 toLocaleString() 的 "8/4/2026, 4:59:01 PM" 好认。 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 顶栏那句"配置更新于…"。「更新config」会同时刷新规范文档、看板快照、人员名册，
 * 三者通常同一时刻；但 CLI 能单独刷某一份，那就必须分开说，否则文案在撒谎。
 */
export function configFreshness(meta: Meta): { text: string; detail: string } {
  const stamps = [
    { label: "开票规范文档", at: meta.specSyncedAt },
    { label: "Jira 看板", at: meta.issuesFetchedAt },
    { label: "人员名册", at: meta.rosterFetchedAt },
  ];
  const detail = stamps.map((s) => `${s.label}: ${fmtTime(s.at)}`).join("\n");
  const times = stamps.map((s) => (s.at ? new Date(s.at).getTime() : NaN));
  const known = times.filter((t) => !Number.isNaN(t));
  // 5 分钟内视为同一次刷新（三次网络请求本身有先后）
  const together = known.length === stamps.length && Math.max(...known) - Math.min(...known) < 5 * 60_000;
  return {
    text: together
      ? `开票规范与看板数据更新于 ${fmtTime(meta.specSyncedAt)}`
      : `规范 ${fmtTime(meta.specSyncedAt)} · 看板 ${fmtTime(meta.issuesFetchedAt)}`,
    detail,
  };
}

/** 非 Sub-task 类型的默认优先级：规范定的 P2，项目里没有则取第一个。 */
export const defaultPriority = (meta: Meta): string | null =>
  meta.priorities.includes("P2") ? "P2" : (meta.priorities[0] ?? null);

export const isSubmitted = (t: Ticket): boolean => Boolean(t.jiraKey);

/**
 * 邮箱 → 人名。邮箱只是人与 Jira 账号的对应键，界面上一律显示人名；
 * 名册里查不到的（离职、外部账号）退回显示原值，总比空着好。
 */
export const displayName = (email: string | null | undefined, roster: RosterMember[]): string =>
  email ? (roster.find((m) => m.email === email)?.name ?? email) : "";

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
