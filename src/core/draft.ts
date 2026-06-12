/**
 * draft: colloquial input → validated DraftFile.
 *
 * Single LLM pass. Structured outputs guarantee the JSON shape; the only
 * thing left to check locally is cross-field consistency (localId refs,
 * parent cycles), and on the rare failure the zod issues are fed back for a
 * bounded repair retry.
 *
 * Pure library function: no argv/stdout, no file writes — the CLI (or a
 * future HTTP/Slack wrapper) owns persistence.
 */

import { readFile } from "node:fs/promises";
import type { ProjectMeta } from "../clients/jira-client.js";
import { generateStructured, type ChatMessage } from "../llm/client.js";
import type { ResolvedConfig } from "./config.js";
import { DraftPayloadObjectSchema, DraftPayloadSchema, type DraftFile } from "./schema.js";
import { cacheAgeDays, readProjectMeta, readSpecCache } from "./spec-cache.js";

const PROMPT_URL = new URL("../prompts/draft-system.md", import.meta.url);

/** Warn (don't block) when the spec cache is older than this. */
const STALE_SPEC_DAYS = 30;

export interface DraftOptions {
  config: ResolvedConfig;
  /** Prior turns, reserved for future multi-round refinement; the new input is appended after these. */
  history?: ChatMessage[];
  /** Bounded retries when cross-validation fails (default 2). */
  maxRepair?: number;
  onProgress?: (message: string) => void;
}

export async function draftTickets(input: string, opts: DraftOptions): Promise<DraftFile> {
  const { config } = opts;
  const send = opts.onProgress ?? (() => {});
  const maxRepair = opts.maxRepair ?? 2;

  const spec = await readSpecCache(config.cacheDir);
  const meta = await readProjectMeta(config.cacheDir);
  const age = cacheAgeDays(spec);
  if (age >= STALE_SPEC_DAYS) {
    send(`⚠ 规范缓存已是 ${age} 天前同步的，建议先跑 ajt sync-spec`);
  }

  const system = await buildSystemPrompt(spec.markdown, meta, config);
  let messages: ChatMessage[] = [...(opts.history ?? []), { role: "user", content: input }];

  for (let attempt = 0; ; attempt++) {
    send(attempt === 0 ? "生成草稿中…" : `修复重试 ${attempt}/${maxRepair} …`);
    const { output, usage } = await generateStructured({
      model: config.model,
      system,
      messages,
      schema: DraftPayloadObjectSchema,
    });
    send(
      `  tokens: 输入 ${usage.inputTokens} · 缓存命中 ${usage.cacheReadInputTokens} · 缓存写入 ${usage.cacheCreationInputTokens} · 输出 ${usage.outputTokens}`,
    );

    const checked = DraftPayloadSchema.safeParse(output);
    if (checked.success) {
      return {
        meta: {
          version: 1,
          createdAt: new Date().toISOString(),
          input,
          projectKey: config.projectKey,
          specSyncedAt: spec.syncedAt || null,
          specVersions: spec.sources.map((s) => s.version),
          model: config.model,
        },
        tickets: checked.data.tickets,
        links: checked.data.links.map((l) => ({ ...l, created: false })),
        notes: checked.data.notes,
      };
    }

    const problems = checked.error.issues.map((i) => `- ${i.message}`).join("\n");
    if (attempt >= maxRepair) {
      throw new Error(`草稿交叉校验在 ${attempt + 1} 次尝试后仍未通过:\n${problems}`);
    }
    send("  ⚠ 交叉校验未通过，回喂错误重试");
    messages = [
      ...messages,
      { role: "assistant", content: JSON.stringify(output) },
      {
        role: "user",
        content: `Your previous output failed validation:\n${problems}\nReturn the complete corrected JSON.`,
      },
    ];
  }
}

// ─── System prompt assembly ─────────────────────────────────────────────────
// Everything injected here comes from the on-disk caches or static config, so
// the assembled prompt is byte-stable across calls — a prerequisite for
// Anthropic prompt-cache hits. Do not add timestamps or other per-call data.

async function buildSystemPrompt(
  specMarkdown: string,
  meta: ProjectMeta,
  config: ResolvedConfig,
): Promise<string> {
  const template = await readFile(PROMPT_URL, "utf-8");
  // Titles are always English per the conventions; this rule only scopes descriptions/notes.
  const languageRule =
    config.language === "zh"
      ? "Write descriptions, acceptance criteria and notes in Chinese."
      : config.language === "en"
        ? "Write descriptions, acceptance criteria and notes in English."
        : "Write descriptions, acceptance criteria and notes in the same language as the user's input.";
  return template
    .replaceAll("{{SPEC}}", specMarkdown.trim())
    .replaceAll("{{PROJECT_META}}", renderProjectMeta(meta))
    .replaceAll("{{DEFAULT_PRIORITY}}", config.defaultPriority ?? "the project's default priority")
    .replaceAll("{{LANGUAGE_RULE}}", languageRule);
}

export function renderProjectMeta(meta: ProjectMeta): string {
  const types = meta.issueTypes
    .map((t) => {
      const flags: string[] = [];
      if (t.subtask) flags.push("sub-task type — requires a parent");
      if (t.hierarchyLevel != null) flags.push(`hierarchy level ${t.hierarchyLevel}`);
      const suffix = flags.length ? ` (${flags.join("; ")})` : "";
      return `- ${t.name}${suffix}${t.description ? `: ${t.description}` : ""}`;
    })
    .join("\n");
  const links = meta.linkTypes.map((l) => `- ${l.name} (outward: "${l.outward}", inward: "${l.inward}")`).join("\n");
  return `Issue types:\n${types}\n\nPriorities: ${meta.priorities.join(", ")}\n\nLink types:\n${links}`;
}
