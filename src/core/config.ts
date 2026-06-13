/**
 * Configuration loading.
 *
 * Two layers, split by sensitivity:
 *   - config.json (committed) — team-shared, non-secret: target project,
 *     spec page URLs, default priority, static extra fields.
 *   - .env (gitignored) — credentials, loaded by the CLI via dotenv before
 *     anything here runs. The model override (AJT_MODEL) also lives there.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-4-8";

const ConfigSchema = z.object({
  projectKey: z.string().min(1, "projectKey is empty — edit config.json"),
  /**
   * Static team roster for this version — drives the web UI's assignee
   * dropdown. The Jira fetch path (npm run fetch-users) is kept around for
   * when this needs to scale beyond a hand-maintained list.
   */
  teamMembers: z.array(z.object({ name: z.string().min(1), email: z.string().min(1) })).default([]),
  /** Reporter candidates for the web form (separate from the assignee roster). */
  reporters: z.array(z.object({ name: z.string().min(1), email: z.string().min(1) })).default([]),
  specPageUrls: z
    .array(z.url())
    .min(1, "specPageUrls needs at least one Confluence page URL — edit config.json"),
  /**
   * Hinted to the LLM as the default for Story/Task when the input carries no
   * urgency signal. Never auto-applied at submit — priorities come solely from
   * the draft (Sub-task/Bug intentionally carry none).
   */
  defaultPriority: z.string().optional(),
  /** Extra Jira fields merged into every createIssue payload (escape hatch for required custom fields). */
  staticFields: z.record(z.string(), z.unknown()).default({}),
  /** Language for ticket text: zh / en / auto (follow the input). */
  language: z.enum(["zh", "en", "auto"]).default("auto"),
  cacheDir: z.string().default(".cache"),
  draftsDir: z.string().default("drafts"),
});

export interface ResolvedConfig extends z.infer<typeof ConfigSchema> {
  /** From AJT_MODEL env, defaulting to DEFAULT_MODEL. */
  model: string;
}

export async function loadConfig(path = "config.json"): Promise<ResolvedConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    throw new Error(`Could not read ${path} — run from the project root or pass --config <path>`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, model: process.env.AJT_MODEL || DEFAULT_MODEL };
}
