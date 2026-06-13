/**
 * submit: DraftFile → real Jira issues, resumable.
 *
 * Tickets are created in topological order (parents first) so children can
 * reference real parent keys. After every successful mutation the draft is
 * re-persisted with the new jiraKey / link state, which makes re-running the
 * same command after a mid-flight failure skip everything already created.
 */

import { createIssue, createIssueLink, findUserAccountId, type ProjectMeta } from "../clients/jira-client.js";
import { markdownToAdf } from "../utils/adf.js";
import type { ResolvedConfig } from "./config.js";
import { DraftFileSchema, isLocalId, type DraftFile, type Ticket } from "./schema.js";

export interface SubmitOptions {
  config: ResolvedConfig;
  meta: ProjectMeta;
  /** Validate + show the plan + test ADF conversion, create nothing. */
  dryRun?: boolean;
  /** Skip the metadata prechecks (schema validation still runs). */
  force?: boolean;
  onProgress?: (message: string) => void;
  /** Called after every successful mutation so progress survives crashes. */
  persist?: (draft: DraftFile) => Promise<void>;
  /** Shown the plan before creating; return false to abort. Omitted ⇒ proceed. */
  confirm?: (planText: string) => Promise<boolean>;
}

/**
 * Parents before children (Kahn). A parent that is a real Jira key already
 * exists, so its child is a root within the draft. Throws on cycles or
 * dangling localId parents — normally unreachable behind schema validation,
 * but exported for direct use.
 */
export function topoSort(tickets: Ticket[]): Ticket[] {
  const byId = new Map(tickets.map((t) => [t.localId, t]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>(tickets.map((t) => [t.localId, 0]));
  for (const t of tickets) {
    if (!t.parent || !isLocalId(t.parent)) continue;
    if (!byId.has(t.parent)) throw new Error(`ticket ${t.localId} references missing parent ${t.parent}`);
    children.set(t.parent, [...(children.get(t.parent) ?? []), t.localId]);
    indegree.set(t.localId, (indegree.get(t.localId) ?? 0) + 1);
  }
  const queue = tickets.filter((t) => indegree.get(t.localId) === 0).map((t) => t.localId);
  const order: Ticket[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const c of children.get(id) ?? []) {
      const d = indegree.get(c)! - 1;
      indegree.set(c, d);
      if (d === 0) queue.push(c);
    }
  }
  if (order.length !== tickets.length) throw new Error("parent relationships contain a cycle");
  return order;
}

/** Checks the draft only uses names that actually exist in the target project. */
export function precheck(draft: DraftFile, meta: ProjectMeta): string[] {
  const problems: string[] = [];
  const typeNames = new Set(meta.issueTypes.map((t) => t.name));
  const subtaskTypes = new Set(meta.issueTypes.filter((t) => t.subtask).map((t) => t.name));
  const linkNames = new Set(meta.linkTypes.map((l) => l.name));
  for (const t of draft.tickets) {
    if (!typeNames.has(t.issueType)) {
      problems.push(
        `${t.localId}: 票类型 "${t.issueType}" 在项目 ${meta.projectKey} 中不存在（可用: ${[...typeNames].join(", ")}）`,
      );
    }
    if (t.priority && meta.priorities.length && !meta.priorities.includes(t.priority)) {
      problems.push(`${t.localId}: 优先级 "${t.priority}" 不在 (${meta.priorities.join(", ")}) 中`);
    }
    if (subtaskTypes.has(t.issueType) && !t.parent && !t.jiraKey) {
      problems.push(`${t.localId}: "${t.issueType}" 是子任务类型，必须有 parent`);
    }
  }
  for (const l of draft.links) {
    if (!linkNames.has(l.type)) {
      problems.push(
        `关联 ${l.from}→${l.to}: 类型 "${l.type}" 不存在（可用: ${[...linkNames].join(", ")}）`,
      );
    }
  }
  return problems;
}

function buildPlanText(draft: DraftFile, ordered: Ticket[]): string {
  const lines: string[] = [`将对项目 ${draft.meta.projectKey} 执行：`];
  for (const t of ordered) {
    const badge = t.priority ? `${t.issueType}/${t.priority}` : t.issueType;
    lines.push(
      t.jiraKey
        ? `  ↷ ${t.localId} 已创建为 ${t.jiraKey}（跳过）`
        : `  + ${t.localId} [${badge}]${t.parent ? ` (父: ${t.parent})` : ""} ${t.summary}`,
    );
  }
  for (const l of draft.links) {
    lines.push(l.created ? `  ↷ 关联 ${l.from} ${l.type} ${l.to} 已创建（跳过）` : `  + 关联 ${l.from} ${l.type} ${l.to}`);
  }
  return lines.join("\n");
}

export async function submitDraft(input: DraftFile, opts: SubmitOptions): Promise<DraftFile> {
  const send = opts.onProgress ?? (() => {});
  const persist = opts.persist ?? (async () => {});

  // Re-validate — the draft file may have been hand-edited since draft time.
  const draft = DraftFileSchema.parse(input);

  if (!opts.force) {
    const problems = precheck(draft, opts.meta);
    if (problems.length) {
      throw new Error(`提交前检查未通过:\n${problems.map((p) => `- ${p}`).join("\n")}\n（--force 可跳过该检查）`);
    }
  }

  const ordered = topoSort(draft.tickets);
  const plan = buildPlanText(draft, ordered);

  if (opts.dryRun) {
    for (const t of ordered) if (!t.jiraKey) markdownToAdf(t.description);
    send(plan);
    send("dry-run: 未创建任何内容（description 已验证可转换为 Jira 格式）。");
    return draft;
  }

  if (opts.confirm && !(await opts.confirm(plan))) {
    send("已取消，未创建任何内容。");
    return draft;
  }

  const keyByLocal = new Map<string, string>();
  for (const t of draft.tickets) if (t.jiraKey) keyByLocal.set(t.localId, t.jiraKey);

  /** localId → its created Jira key; real keys pass through untouched. */
  const resolveRef = (ref: string): string => {
    if (!isLocalId(ref)) return ref;
    const key = keyByLocal.get(ref);
    if (!key) throw new Error(`internal: ${ref} 还没有对应的 Jira key`);
    return key;
  };

  // Resolve every assignee/reporter before any mutation so a bad name aborts cleanly.
  const accountIds = new Map<string, string>();
  for (const t of ordered) {
    if (t.jiraKey) continue;
    for (const person of [t.assignee, t.reporter]) {
      if (person && !accountIds.has(person)) {
        accountIds.set(person, await findUserAccountId(person));
      }
    }
  }

  try {
    for (const t of ordered) {
      if (t.jiraKey) {
        send(`↷ ${t.localId} 已创建为 ${t.jiraKey}，跳过`);
        continue;
      }
      const created = await createIssue({
        projectKey: draft.meta.projectKey,
        summary: t.summary,
        descriptionAdf: markdownToAdf(t.description),
        issueTypeName: t.issueType,
        ...(t.priority ? { priorityName: t.priority } : {}),
        labels: t.labels,
        ...(t.parent ? { parentKey: resolveRef(t.parent) } : {}),
        ...(t.assignee ? { assigneeAccountId: accountIds.get(t.assignee)! } : {}),
        ...(t.reporter ? { reporterAccountId: accountIds.get(t.reporter)! } : {}),
        ...(t.dueDate ? { dueDate: t.dueDate } : {}),
        extraFields: opts.config.staticFields,
      });
      t.jiraKey = created.key;
      t.jiraUrl = created.url;
      keyByLocal.set(t.localId, created.key);
      await persist(draft);
      send(`✓ ${t.localId} → ${created.key}  ${created.url}`);
    }

    for (const l of draft.links) {
      if (l.created) {
        send(`↷ 关联 ${l.from} ${l.type} ${l.to} 已创建，跳过`);
        continue;
      }
      const fromKey = resolveRef(l.from);
      const toKey = resolveRef(l.to);
      await createIssueLink(l.type, fromKey, toKey);
      l.created = true;
      await persist(draft);
      send(`✓ 关联: ${fromKey} ${l.type} ${toKey}`);
    }
  } catch (err) {
    await persist(draft);
    const done = draft.tickets.filter((t) => t.jiraKey).length;
    throw new Error(
      `提交在创建 ${done}/${draft.tickets.length} 张票后中断。\n${err instanceof Error ? err.message : String(err)}\n修复草稿后重跑同一命令，已创建的内容会自动跳过。`,
    );
  }

  return draft;
}
