/**
 * Draft → human-readable markdown preview.
 *
 * Pure function. The preview is read-only convenience for review — submit
 * only ever reads the JSON draft, never this rendering.
 */

import type { DraftFile, Ticket } from "./schema.js";

export function renderDraftMarkdown(draft: DraftFile): string {
  const lines: string[] = [];
  const byId = new Map(draft.tickets.map((t) => [t.localId, t]));
  const children = new Map<string, Ticket[]>();
  for (const t of draft.tickets) {
    if (t.parent && byId.has(t.parent)) {
      const list = children.get(t.parent) ?? [];
      list.push(t);
      children.set(t.parent, list);
    }
  }
  const roots = draft.tickets.filter((t) => !t.parent || !byId.has(t.parent));

  lines.push(`# 开票草稿`);
  lines.push("");
  lines.push(`> ${draft.meta.input}`);
  lines.push("");
  lines.push(
    `项目 **${draft.meta.projectKey}** · 模型 ${draft.meta.model} · 创建于 ${draft.meta.createdAt}` +
      (draft.meta.specSyncedAt ? ` · 规范同步于 ${draft.meta.specSyncedAt}` : ""),
  );
  lines.push("");

  lines.push(`## 票据总览（${draft.tickets.length} 张）`);
  lines.push("");
  const shown = new Set<string>();
  const overviewLine = (t: Ticket, depth: number): void => {
    shown.add(t.localId);
    const indent = "  ".repeat(depth);
    const badge = t.priority ? `${t.issueType} · ${t.priority}` : t.issueType;
    const key = t.jiraKey ? ` → **${t.jiraKey}**` : "";
    lines.push(`${indent}- **${t.localId}** [${badge}] ${t.summary}${key}`);
    for (const c of children.get(t.localId) ?? []) overviewLine(c, depth + 1);
  };
  for (const r of roots) overviewLine(r, 0);
  // 正常路径下 schema 已拦父子环；这里兜底防手改 JSON 绕过校验时票从树中静默消失。
  if (shown.size < draft.tickets.length) {
    lines.push(`> ⚠ ${draft.tickets.length - shown.size} 张票因父子环未在树中显示，请检查 parent 字段`);
  }
  lines.push("");

  if (draft.links.length) {
    lines.push(`## 关联`);
    lines.push("");
    for (const l of draft.links) {
      const from = byId.get(l.from)?.jiraKey ?? l.from;
      const to = byId.get(l.to)?.jiraKey ?? l.to;
      lines.push(`- ${from} **${l.type}** ${to}${l.created ? " ✓" : ""}`);
    }
    lines.push("");
  }

  for (const t of draft.tickets) {
    lines.push(`---`);
    lines.push("");
    lines.push(`## ${t.localId} · ${t.summary}`);
    lines.push("");
    const facts: string[] = [`类型: ${t.issueType}`];
    if (t.priority) facts.push(`优先级: ${t.priority}`);
    if (t.labels.length) facts.push(`标签: ${t.labels.join(", ")}`);
    if (t.parent) facts.push(`父票: ${byId.get(t.parent)?.jiraKey ?? t.parent}`);
    if (t.assignee) facts.push(`指派: ${t.assignee}`);
    if (t.reporter) facts.push(`Reporter: ${t.reporter}`);
    if (t.dueDate) facts.push(`截止: ${t.dueDate}`);
    if (t.estimate) facts.push(`工时估算: ${t.estimate}（仅记录，不会提交）`);
    if (t.jiraKey) facts.push(`Jira: [${t.jiraKey}](${t.jiraUrl ?? ""})`);
    lines.push(facts.join(" · "));
    lines.push("");
    lines.push(t.description.trim());
    lines.push("");
  }

  if (draft.notes) {
    lines.push(`---`);
    lines.push("");
    lines.push(`## AI 拆票说明`);
    lines.push("");
    lines.push(draft.notes.trim());
    lines.push("");
  }

  return lines.join("\n");
}
