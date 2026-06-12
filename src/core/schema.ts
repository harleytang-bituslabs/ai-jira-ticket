/**
 * Type hub for the whole project (zod v4).
 *
 * Two layers of schema:
 *   - DraftPayloadObjectSchema — the plain object shape handed to the LLM via
 *     structured outputs (no cross-field refinements; the API enforces shape).
 *   - DraftPayloadSchema / DraftFileSchema — the same shapes plus cross-field
 *     validation (localId uniqueness, dangling refs, parent cycles), run
 *     locally after the LLM responds and again before submit.
 *
 * Tickets reference each other by localId ("t1", "t2", …) because real Jira
 * keys don't exist until submit; submit maps localId → key in topological
 * order and writes the keys back into the draft file.
 */

import { z } from "zod";

export const LOCAL_ID_RE = /^t\d+$/;
/** A real Jira issue key, e.g. "AIP-12" — used to reference pre-existing issues (typically Epics). */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const REF_RE = /^(t\d+|[A-Z][A-Z0-9]*-\d+)$/;

export function isLocalId(ref: string): boolean {
  return LOCAL_ID_RE.test(ref);
}

export const TicketSchema = z.object({
  localId: z.string().regex(LOCAL_ID_RE, 'localId must look like "t1", "t2", …'),
  summary: z.string().min(1).max(255),
  /** Markdown. Converted to ADF at submit time. */
  description: z.string().min(1),
  /** Must be one of the issue type names in the cached project metadata. */
  issueType: z.string().min(1),
  /** Must be one of the priority names in the cached project metadata. Null = don't set (Sub-task/Bug). */
  priority: z.string().nullable().default(null),
  labels: z.array(z.string().regex(/^\S+$/, "Jira labels cannot contain whitespace")).default([]),
  /** localId of another draft ticket, or a real Jira key (e.g. an existing Epic), or null. */
  parent: z.string().regex(REF_RE, 'parent must be "tN" or a Jira key like "AIP-12"').nullable().default(null),
  /** Name or email; submit resolves it to an accountId via user search. */
  assignee: z.string().nullable().default(null),
  /** YYYY-MM-DD; required at creation for Sub-tasks in spec-compliant projects. */
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dueDate must be YYYY-MM-DD")
    .nullable()
    .default(null),
  /** Display-only — not sent to Jira. */
  estimate: z.string().nullable().default(null),
});

export const LinkSchema = z.object({
  /** Outward side: "t1 blocks t2" ⇒ from=t1, to=t2, type="Blocks". Accepts localIds or real Jira keys. */
  from: z.string().regex(REF_RE),
  to: z.string().regex(REF_RE),
  /** Must be one of the link type names in the cached project metadata. */
  type: z.string().min(1),
});

/** Shape-only schema passed to the LLM via structured outputs. */
export const DraftPayloadObjectSchema = z.object({
  tickets: z.array(TicketSchema).min(1),
  links: z.array(LinkSchema).default([]),
  /** LLM's explanation of how/why it split the work — for human review only. */
  notes: z.string().nullable().default(null),
});

// ─── Cross-field validation (shared by payload and draft-file schemas) ───────

interface CrossShape {
  tickets: Array<{ localId: string; parent: string | null }>;
  links: Array<{ from: string; to: string }>;
}

/**
 * Returns human-readable problems; empty array means the references are
 * consistent. localId-style refs ("tN") must resolve within the draft; real
 * Jira keys ("AIP-12") refer to pre-existing issues and pass through (their
 * existence is checked by Jira itself at submit time).
 */
export function crossValidationIssues(val: CrossShape): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const t of val.tickets) {
    if (ids.has(t.localId)) issues.push(`duplicate localId "${t.localId}"`);
    ids.add(t.localId);
  }
  for (const t of val.tickets) {
    if (t.parent === t.localId) issues.push(`ticket "${t.localId}" lists itself as parent`);
    else if (t.parent && isLocalId(t.parent) && !ids.has(t.parent))
      issues.push(`ticket "${t.localId}" references missing parent "${t.parent}"`);
  }
  for (const l of val.links) {
    if (isLocalId(l.from) && !ids.has(l.from)) issues.push(`link references missing ticket "${l.from}"`);
    if (isLocalId(l.to) && !ids.has(l.to)) issues.push(`link references missing ticket "${l.to}"`);
    if (l.from === l.to) issues.push(`link from "${l.from}" to itself`);
  }
  const cycle = findParentCycle(val.tickets);
  if (cycle) issues.push(`parent relationships form a cycle: ${cycle.join(" → ")}`);
  return issues;
}

function findParentCycle(tickets: CrossShape["tickets"]): string[] | null {
  const parentOf = new Map(tickets.map((t) => [t.localId, t.parent]));
  for (const t of tickets) {
    const seen = new Set<string>([t.localId]);
    // Jira-key parents terminate the chain — an existing issue can't loop back into the draft.
    let cur = t.parent && isLocalId(t.parent) ? t.parent : null;
    while (cur) {
      if (seen.has(cur)) return [...seen, cur];
      seen.add(cur);
      const next = parentOf.get(cur) ?? null;
      cur = next && isLocalId(next) ? next : null;
    }
  }
  return null;
}

function applyCross(val: CrossShape, ctx: { addIssue: (issue: { code: "custom"; message: string }) => void }): void {
  for (const message of crossValidationIssues(val)) ctx.addIssue({ code: "custom", message });
}

/** Full validation of what the LLM returned: shape + cross-references. */
export const DraftPayloadSchema = DraftPayloadObjectSchema.superRefine(applyCross);

// ─── Draft file envelope (what lands in drafts/*.json) ───────────────────────

export const DraftFileSchema = z
  .object({
    meta: z.object({
      version: z.literal(1),
      createdAt: z.string(),
      /** The original colloquial input, kept for the audit trail. */
      input: z.string(),
      projectKey: z.string(),
      specSyncedAt: z.string().nullable(),
      specVersions: z.array(z.number().nullable()).default([]),
      model: z.string(),
    }),
    tickets: z
      .array(
        TicketSchema.extend({
          /** Written back by submit ⇒ re-running skips already-created tickets. */
          jiraKey: z.string().optional(),
          jiraUrl: z.string().optional(),
        }),
      )
      .min(1),
    links: z.array(LinkSchema.extend({ created: z.boolean().default(false) })).default([]),
    notes: z.string().nullable().default(null),
  })
  .superRefine(applyCross);

export type DraftPayload = z.infer<typeof DraftPayloadSchema>;
export type DraftFile = z.infer<typeof DraftFileSchema>;
export type Ticket = DraftFile["tickets"][number];
export type DraftLink = DraftFile["links"][number];
