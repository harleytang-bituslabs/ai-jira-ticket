import { describe, expect, it } from "vitest";
import { confluenceHtmlToMarkdown } from "../src/utils/html-to-markdown.js";

// The module is battle-tested in the source project; these are sanity checks
// that the copy works in this repo's module/typescript setup.
describe("confluenceHtmlToMarkdown (copied module)", () => {
  it("flattens Confluence table cells into single-line GFM rows", () => {
    const html =
      "<table><colgroup><col/></colgroup><tbody>" +
      "<tr><th><p>字段</p></th><th><p>要求</p></th></tr>" +
      "<tr><td><p>标题</p></td><td><p>动词开头</p></td></tr>" +
      "</tbody></table>";
    const md = confluenceHtmlToMarkdown(html);
    expect(md).toContain("| 字段 | 要求 |");
    expect(md).toContain("| 标题 | 动词开头 |");
  });

  it("converts syntaxhighlighter blocks to fenced code", () => {
    const html =
      '<pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java;">int x = 1;</pre>';
    const md = confluenceHtmlToMarkdown(html);
    expect(md).toContain("```java");
    expect(md).toContain("int x = 1;");
  });
});
