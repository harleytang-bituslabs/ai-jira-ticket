/**
 * Confluence Cloud REST v2 client.
 *
 * Public surface is intentionally small: callers feed a page URL and receive
 * `{ title, markdown }`. All Atlassian-specific knowledge — Basic auth,
 * `body-format=view`, HTML→markdown conversion — is encapsulated here.
 *
 * Auth: shared Atlassian credentials from ./atlassian-auth.js (same site and
 * token as the Jira client).
 */

import { confluenceHtmlToMarkdown, type ConfluenceMarkdownOptions } from "../utils/html-to-markdown.js";
import { getAtlassianAuthHeader, getAtlassianBaseUrl } from "./atlassian-auth.js";

// ─── URL parsing ────────────────────────────────────────────────────────────

export interface ConfluencePageRef {
  /** Origin only, no path. e.g. `https://bituslabs.atlassian.net` */
  baseUrl: string;
  /** Numeric page id as a string (Atlassian uses snowflake-style IDs). */
  pageId: string;
}

/**
 * Parse a Confluence page URL into `{ baseUrl, pageId }`.
 *
 * Accepts either of:
 *   https://<site>.atlassian.net/wiki/spaces/<KEY>/pages/<id>[/Slug]
 *   https://<site>.atlassian.net/wiki/pages/<id>
 *
 * Trailing slashes / query strings / fragments are tolerated.
 * Throws with an actionable message on malformed input.
 */
export function parseConfluenceUrl(url: string): ConfluencePageRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Confluence URL is not a valid URL: ${url}`);
  }
  const match = /\/pages\/(\d+)(?:\/|$|\?|#)/.exec(parsed.pathname);
  if (!match) {
    throw new Error(
      `Could not extract a page id from Confluence URL — expected ".../pages/<id>" but got: ${parsed.pathname}`,
    );
  }
  return { baseUrl: parsed.origin, pageId: match[1] };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

interface PageBodyResponse {
  id: string;
  title: string;
  status: string;
  /** Present on v2 responses; the old client simply didn't declare it. */
  version?: { number: number };
  body?: {
    view?: { value: string };
    storage?: { value: string };
  };
}

/**
 * Fetch a page in the requested body-format. The same endpoint serves both
 * `view` (rendered HTML, the primary source) and `storage` (XHTML with
 * Confluence's `<ac:*>` private tags, where third-party macros like
 * Adaptavist Orah-LaTeX keep their full source via CDATA).
 */
async function fetchPageBody(
  pageId: string,
  format: "view" | "storage",
): Promise<PageBodyResponse> {
  const base = getAtlassianBaseUrl();
  const path = `/wiki/api/v2/pages/${pageId}?body-format=${format}`;
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: getAtlassianAuthHeader(), Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        "Confluence rejected the API token (401). Regenerate at id.atlassian.com/manage-profile/security/api-tokens and update CONFLUENCE_API_TOKEN.",
      );
    }
    if (res.status === 403) {
      throw new Error(
        `Confluence denied access to page ${pageId} (403). The token's owner must be granted view permission on the space.`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Confluence page ${pageId} not found (404). Verify the URL or that the page hasn't been deleted/moved.`,
      );
    }
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Confluence API ${path} → HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as PageBodyResponse;
}

// ─── LaTeX extraction (Adaptavist Orah-LaTeX macro support) ─────────────────

/**
 * Parse the storage-format XML and return a map of macro local-id → LaTeX
 * source. Confluence's view body-format only renders Orah-LaTeX as an iframe
 * loader script with truncated source in JSON; the full LaTeX is only
 * available in storage's `<ac:plain-text-body><![CDATA[…]]></…>`.
 */
function extractLatexMap(storageXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const macroRe =
    /<ac:structured-macro[^>]*ac:name="orah-latex"[^>]*ac:local-id="([^"]+)"[\s\S]*?<\/ac:structured-macro>/g;
  for (const m of storageXml.matchAll(macroRe)) {
    const localId = m[1];
    const cdata =
      /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/.exec(
        m[0],
      );
    if (cdata) map.set(localId, cdata[1]);
  }
  return map;
}

/**
 * Replace each `<div data-macro-name="orah-latex" …>…<script>…</script></div>`
 * in view HTML with `<div data-mathblock-idx="N">x</div>`, where N indexes
 * into the returned `blocks` array carrying the verbatim LaTeX source.
 *
 * The sentinel `x` body is required: turndown elides genuinely-blank
 * elements before its rules ever see them, so an empty placeholder div
 * would silently disappear.
 *
 * Falls through unchanged when no LaTeX is found for a localId — no content
 * is ever lost; worst case the user sees the unrendered iframe loader.
 */
function injectLatexPlaceholders(
  viewHtml: string,
  latexMap: Map<string, string>,
): { html: string; blocks: string[] } {
  const blocks: string[] = [];
  if (latexMap.size === 0) return { html: viewHtml, blocks };
  const blockRe =
    /<div\b[^>]*data-macro-name="orah-latex"[\s\S]*?<\/script>\s*<\/div>/g;
  const html = viewHtml.replace(blockRe, (block) => {
    const idMatch = /data-local-id="([^"]+)"/.exec(block);
    const localId = idMatch?.[1];
    const latex = localId ? latexMap.get(localId) : null;
    if (latex == null) return block;
    const idx = blocks.push(latex) - 1;
    return `<div data-mathblock-idx="${idx}">x</div>`;
  });
  return { html, blocks };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface FetchedPage {
  /** Page title as Confluence stores it; safe to display verbatim. */
  title: string;
  /** GFM-strict markdown converted from `body-format=view`. */
  markdown: string;
  /** Confluence page version number — recorded in the spec cache so staleness can be checked cheaply later. */
  version: number | null;
}

/**
 * Fetch a Confluence page and return its title + markdown body.
 *
 * Internally fetches **both** body-formats in parallel:
 *   - `view` (rendered HTML) is the primary source the converter walks.
 *   - `storage` (XHTML w/ Confluence's `<ac:*>` tags) is the **only** place
 *     full Orah-LaTeX macro source survives — `view` truncates it inside
 *     the iframe loader script. We harvest LaTeX from storage, splice
 *     placeholder divs into the view HTML, and pass the source array
 *     through `markdownOptions.latexBlocks` so the converter can emit
 *     proper `$$…$$` math fences with whitespace preserved.
 *
 * `markdownOptions` lets callers extend the Confluence-specific turndown
 * rules without modifying this client; see [confluenceHtmlToMarkdown] for
 * the option shape. Any `latexBlocks` passed in is overridden by the auto-
 * extracted set — direct callers wanting full control can call
 * `confluenceHtmlToMarkdown` themselves.
 */
export async function fetchPageMarkdown(
  pageUrl: string,
  markdownOptions?: ConfluenceMarkdownOptions,
): Promise<FetchedPage> {
  const { pageId } = parseConfluenceUrl(pageUrl);
  const [view, storage] = await Promise.all([
    fetchPageBody(pageId, "view"),
    fetchPageBody(pageId, "storage"),
  ]);
  const viewHtml = view.body?.view?.value;
  if (!viewHtml) {
    throw new Error(
      `Confluence page ${pageId} returned no HTML body. The page may be empty or in a draft-only state.`,
    );
  }
  const latexMap = extractLatexMap(storage.body?.storage?.value ?? "");
  const { html: patched, blocks } = injectLatexPlaceholders(viewHtml, latexMap);
  const markdown = confluenceHtmlToMarkdown(patched, {
    ...markdownOptions,
    latexBlocks: blocks,
  });
  return { title: view.title, markdown, version: view.version?.number ?? null };
}
