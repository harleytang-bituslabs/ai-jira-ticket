/**
 * HTML → Markdown conversion utilities.
 *
 * Pure functions (no env, no I/O). Convert HTML strings to markdown using
 * turndown + turndown-plugin-gfm, with extra rules for Confluence-specific
 * markup that the default rules mishandle.
 */

import TurndownService from "turndown";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — turndown-plugin-gfm has no published @types package.
import { gfm } from "turndown-plugin-gfm";

/**
 * Minimal DOM-node shape for the properties our default rules read.
 * turndown hands replacement functions a domino-backed HTMLElement at
 * runtime; we type only what we use so the core package can stay on
 * its Node-only `lib` setting (no DOM types pulled in).
 */
interface DomLikeElement {
  nodeName: string;
  previousElementSibling: unknown;
  classList?: { contains(token: string): boolean };
  querySelector(selector: string): unknown;
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/**
 * A named turndown rule. Equivalent to `TurndownService.Rule` but carrying
 * its own key so callers can pass an array without juggling a separate map.
 */
export interface NamedTurndownRule {
  name: string;
  filter: TurndownService.Filter;
  replacement: TurndownService.ReplacementFunction;
}

/**
 * Default rules applied to Confluence `body-format=view` HTML on top of the
 * gfm plugin. Each one targets a real failure observed against Atlassian
 * Cloud live docs; see the plan + test/ spike for the validation evidence.
 *
 * Exported so callers can introspect, override by name, or skip entirely
 * via the `replaceDefaultRules` option.
 */
export const DEFAULT_CONFLUENCE_RULES: NamedTurndownRule[] = [
  {
    // Confluence wraps every <td>/<th> child in <p> (often an empty self-
    // closing <p local-id="…" /> for blank cells). The gfm table rule then
    // leaks newlines inside the row, breaking GFM single-row syntax — any
    // strict markdown parser drops the table once a row's column count
    // drifts. Render cells as a single inline string instead.
    name: "confluence-table-cell",
    filter: ["td", "th"],
    replacement: (content, node) => {
      const text = content
        .replace(/\|/g, "\\|")
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const el = node as unknown as DomLikeElement;
      const isFirstCell = el.previousElementSibling == null;
      return (isFirstCell ? "| " : " ") + text + " |";
    },
  },
  {
    // Confluence renders code as <pre class="syntaxhighlighter-pre"
    //   data-syntaxhighlighter-params="brush: java; …">…</pre>
    // turndown's default code rule expects <pre><code>…</code></pre> and
    // misses these, so they fall through to the plain-paragraph handler
    // and lose their fences entirely. Pull the brush out for the language
    // hint when present.
    name: "confluence-syntaxhighlighter",
    filter: (node): boolean => {
      const el = node as unknown as DomLikeElement;
      if (el.nodeName !== "PRE") return false;
      return (
        el.classList?.contains("syntaxhighlighter-pre") === true ||
        el.querySelector("code") == null
      );
    },
    replacement: (_content, node) => {
      const el = node as unknown as DomLikeElement;
      const params = el.getAttribute("data-syntaxhighlighter-params") ?? "";
      const brushMatch = /brush:\s*([a-z0-9_+-]+)/i.exec(params);
      const lang = brushMatch ? brushMatch[1] : "";
      const text = (el.textContent ?? "").replace(/\n+$/, "");
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    },
  },
  {
    // turndown-plugin-gfm only registers <s>/<strike>, not <del>; Confluence
    // emits <del>. Force GFM-correct double-tilde for all three spellings
    // so strikethrough survives consistently.
    name: "strikethrough-del",
    filter: ["del", "s", "strike"],
    replacement: (content) => `~~${content}~~`,
  },
];

export interface ConfluenceMarkdownOptions {
  /**
   * Extra turndown rules applied AFTER the defaults. Use this to handle
   * Confluence elements not covered by the built-in set (info panels,
   * status badges, embedded macros, …) without modifying core code.
   *
   * Rules sharing a `name` with a default override that default — turndown
   * dedupes by key. To keep things explicit, this is the only override
   * mechanism (no merge, no priority numbers).
   */
  extraRules?: NamedTurndownRule[];

  /**
   * Skip the default Confluence rules entirely. Useful only when caller
   * needs full control or is converting non-Confluence HTML. Defaults
   * stay applied unless this is set to `true`.
   */
  replaceDefaultRules?: boolean;

  /**
   * LaTeX source strings indexed by `<div data-mathblock-idx="N">` markers
   * in the HTML. When provided, the converter emits a `$$…$$` math fence
   * containing `latexBlocks[N]` verbatim — newlines preserved.
   *
   * This indirection (passing source by reference instead of inlining into
   * the HTML) is essential: turndown's DOM walk would otherwise normalize
   * whitespace inside the placeholder div, collapsing newlines to spaces
   * and letting LaTeX `%` comment lines swallow the rest of the formula
   * once a renderer flattens it onto one line.
   *
   * Typically supplied by `fetchPageMarkdown` after extracting LaTeX from
   * Confluence's storage body-format. Direct callers who don't need math
   * blocks simply omit this.
   */
  latexBlocks?: string[];
}

/**
 * String-level preprocessing applied before turndown parses the HTML.
 *
 * Strips `<colgroup>…</colgroup>`. turndown-plugin-gfm's `isFirstTbody`
 * helper requires a `<tbody>` to have a null or empty-`<thead>`
 * previousSibling, but Confluence often emits
 *   <table>…<colgroup>…</colgroup><tbody>…
 * The colgroup makes that check fail; the gfm table rule then bails out
 * and the entire `<table>` falls through to "keep" mode, dumping the raw
 * HTML into the markdown. addRule fires too late to fix this — the
 * decision happens during DOM walk, before our replacement runs.
 */
function preprocessConfluenceHtml(html: string): string {
  return html.replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/gi, "");
}

/**
 * Convert Confluence `body-format=view` HTML to GFM markdown.
 *
 * Returns markdown that's safe to render in any GFM-strict previewer
 * (VS Code, GitHub, markdown-it) AND safe to feed into the existing
 * line-range-classifier LLM pass — the conversion is deterministic and
 * preserves the original text content character-for-character within
 * each block.
 */
export function confluenceHtmlToMarkdown(
  html: string,
  options: ConfluenceMarkdownOptions = {},
): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  td.use(gfm);

  const rules = [
    ...(options.replaceDefaultRules ? [] : DEFAULT_CONFLUENCE_RULES),
    ...(options.extraRules ?? []),
  ];
  for (const rule of rules) {
    td.addRule(rule.name, { filter: rule.filter, replacement: rule.replacement });
  }

  // LaTeX block rule — defined inline (not in DEFAULT_CONFLUENCE_RULES)
  // because its replacement closes over the caller-supplied source array.
  // Skipped entirely when no latexBlocks are passed, so direct callers
  // pay zero cost for the math-block path.
  const latexBlocks = options.latexBlocks;
  if (latexBlocks?.length) {
    td.addRule("confluence-mathblock", {
      filter: (node): boolean => {
        const el = node as unknown as DomLikeElement;
        return el.nodeName === "DIV" && el.getAttribute("data-mathblock-idx") != null;
      },
      replacement: (_content, node) => {
        const el = node as unknown as DomLikeElement;
        const raw = el.getAttribute("data-mathblock-idx");
        const idx = raw == null ? -1 : parseInt(raw, 10);
        const latex = latexBlocks[idx];
        if (latex == null) return "";
        return `\n\n$$\n${latex.trim()}\n$$\n\n`;
      },
    });
  }

  return td.turndown(preprocessConfluenceHtml(html));
}
