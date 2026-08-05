/**
 * Web-shell draft workflow logic, kept out of the HTTP layer so routes stay
 * thin and the rules are unit-testable:
 *   - compose defaults: field values the filer pre-chose in the form — sent
 *     to the model as a directive AND applied deterministically afterwards
 *   - merge protection: submitted tickets are server-enforced read-only
 */

import { readIssuesCache } from "../../core/spec-cache.js";
import { DraftFileSchema, type DraftFile } from "../../core/schema.js";
import type { ResolvedConfig } from "../../core/config.js";

/** Trimmed non-empty string, else null. */
export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface ComposeDefaults {
  issueType: string | null;
  priority: string | null;
  parentKey: string | null;
  assignee: string | null;
  startDate: string | null;
  dueDate: string | null;
}

export function parseComposeDefaults(raw: Record<string, unknown>): ComposeDefaults {
  return {
    issueType: str(raw.issueType),
    priority: str(raw.priority),
    parentKey: str(raw.parentKey),
    assignee: str(raw.assignee),
    startDate: str(raw.startDate),
    dueDate: str(raw.dueDate),
  };
}

/**
 * One-line directive appended to the model input so generated content matches
 * the chosen fields (e.g. the [Epic Name] title prefix needs the parent's name).
 */
export async function buildFieldDirectives(
  config: ResolvedConfig,
  defaults: ComposeDefaults,
): Promise<string | undefined> {
  const parts: string[] = [];
  if (defaults.issueType) parts.push(`主票类型 ${defaults.issueType}`);
  if (defaults.parentKey) {
    const issues = await readIssuesCache(config.cacheDir).catch(() => null);
    const title = issues?.issues.find((i) => i.key === defaults.parentKey)?.summary;
    parts.push(`父级 ${defaults.parentKey}${title ? `《${title}》` : ""}`);
  }
  if (defaults.assignee) {
    const name = config.teamMembers.find((m) => m.email === defaults.assignee)?.name ?? defaults.assignee;
    parts.push(`指派 ${name}`);
  }
  if (defaults.startDate) parts.push(`开始 ${defaults.startDate}`);
  if (defaults.dueDate) parts.push(`截止 ${defaults.dueDate}`);
  if (defaults.priority) parts.push(`优先级 ${defaults.priority}`);
  return parts.length
    ? `[指定字段: ${parts.join("；")}。这些值已由填单人确定，所有产出的票均须采用]`
    : undefined;
}

/**
 * Deterministic application of the chosen fields, so compliance never depends
 * on the model. type/parent 只套到根票（AI 拆出的子票保留其层级结构）；其余
 * 字段全员套用。顺序要紧：先定 issueType，最后的 priority 才能据最终类型跳过
 * Sub-task。
 */
export function applyComposeDefaults(draft: DraftFile, defaults: ComposeDefaults): void {
  for (const t of draft.tickets) {
    if (!t.parent) {
      if (defaults.issueType) t.issueType = defaults.issueType;
      if (defaults.parentKey) t.parent = defaults.parentKey;
    }
    if (defaults.assignee) t.assignee = defaults.assignee;
    if (defaults.startDate) t.startDate = defaults.startDate;
    if (defaults.dueDate) t.dueDate = defaults.dueDate;
    if (defaults.priority) t.priority = t.issueType === "Sub-task" ? null : defaults.priority;
  }
}

/**
 * Merge card edits onto the on-disk draft. Submitted tickets (jiraKey on
 * disk) are read-only: the disk version wins, removal is undone, and a
 * client cannot forge jiraKey onto an unsubmitted ticket. Created links
 * survive likewise. meta always comes from disk.
 */
export function mergeDraftEdits(disk: DraftFile, incoming: DraftFile): DraftFile {
  const submittedByLocal = new Map(disk.tickets.filter((t) => t.jiraKey).map((t) => [t.localId, t]));
  const tickets = incoming.tickets.map((t) => {
    const submitted = submittedByLocal.get(t.localId);
    if (submitted) return submitted; // read-only: disk version wins
    const { jiraKey: _k, jiraUrl: _u, ...rest } = t; // strip forged keys
    return rest;
  });
  for (const [localId, t] of submittedByLocal) {
    if (!tickets.some((x) => x.localId === localId)) tickets.unshift(t); // undo removal
  }

  const sameLink = (a: { from: string; to: string; type: string }, b: typeof a) =>
    a.from === b.from && a.to === b.to && a.type === b.type;
  const links = incoming.links.map((l) => ({
    ...l,
    created: disk.links.find((d) => sameLink(d, l))?.created ?? false,
  }));
  for (const d of disk.links) {
    if (d.created && !links.some((l) => sameLink(l, d))) links.push(d); // created links are facts
  }

  // Re-parse: cross-validation rejects dangling refs the client failed to clean.
  return DraftFileSchema.parse({ ...disk, tickets, links, notes: incoming.notes, meta: disk.meta });
}
