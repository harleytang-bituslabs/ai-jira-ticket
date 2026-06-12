/**
 * markdown → ADF (Atlassian Document Format) for Jira v3 rich-text fields.
 *
 * Thin wrapper over marklassian so the rest of the codebase never imports the
 * library directly — if it ever needs replacing (e.g. table support), only
 * this file changes.
 */

import { markdownToAdf as convert } from "marklassian";

export interface AdfDocument {
  version: 1;
  type: "doc";
  content: unknown[];
}

export function markdownToAdf(markdown: string): AdfDocument {
  try {
    return convert(markdown) as AdfDocument;
  } catch (err) {
    const head = markdown.length > 200 ? markdown.slice(0, 200) + "…" : markdown;
    throw new Error(
      `markdown→ADF conversion failed: ${err instanceof Error ? err.message : String(err)}\nOffending markdown starts with:\n${head}`,
    );
  }
}
