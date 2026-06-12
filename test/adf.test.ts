import { describe, expect, it } from "vitest";
import { markdownToAdf } from "../src/utils/adf.js";

describe("markdownToAdf", () => {
  it("produces a top-level ADF document", () => {
    const doc = markdownToAdf("# 标题\n\n正文一段。");
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    expect(doc.content.length).toBeGreaterThan(0);
  });

  it("handles the constructs tickets actually use: lists, code, bold, links", () => {
    const md = [
      "## 复现步骤",
      "",
      "1. 打开登录页",
      "2. 点击 **登录**",
      "",
      "- 期望: 正常跳转",
      "- 实际: 白屏",
      "",
      "```js",
      "console.error(err)",
      "```",
      "",
      "[设计稿](https://example.com)",
    ].join("\n");
    const doc = markdownToAdf(md);
    const types = (doc.content as Array<{ type: string }>).map((n) => n.type);
    expect(types).toContain("heading");
    expect(types).toContain("orderedList");
    expect(types).toContain("bulletList");
    expect(types).toContain("codeBlock");
  });

  it("handles Chinese text", () => {
    const doc = markdownToAdf("验收标准：登录成功率 ≥ 99.9%");
    expect(doc.content.length).toBe(1);
  });
});
