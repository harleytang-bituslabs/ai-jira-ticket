import { describe, expect, it } from "vitest";
import { renderDraftMarkdown } from "../src/core/render.js";
import { DraftFileSchema } from "../src/core/schema.js";

const draft = DraftFileSchema.parse({
  meta: {
    version: 1,
    createdAt: "2026-06-11T10:00:00.000Z",
    input: "Safari 登录白屏要修，顺便接错误上报",
    projectKey: "CG",
    specSyncedAt: "2026-06-11T09:00:00.000Z",
    specVersions: [12],
    model: "claude-opus-4-8",
  },
  tickets: [
    {
      localId: "t1",
      summary: "修复 Safari 登录页偶发白屏",
      description: "## 背景\n- Safari 16+ 偶发白屏",
      issueType: "Bug",
      priority: "High",
      labels: ["frontend"],
      jiraKey: "CG-101",
      jiraUrl: "https://x.atlassian.net/browse/CG-101",
    },
    {
      localId: "t2",
      summary: "排查 WebKit 渲染日志",
      description: "采集并分析崩溃日志",
      issueType: "Sub-task",
      parent: "t1",
    },
    {
      localId: "t3",
      summary: "接入前端错误上报 SDK",
      description: "选型并接入",
      issueType: "Task",
    },
  ],
  links: [{ from: "t3", to: "t1", type: "Relates", created: false }],
  notes: "白屏修复拆出排查子任务；错误上报独立成票。",
});

describe("renderDraftMarkdown", () => {
  it("renders overview tree with children indented under parents", () => {
    const md = renderDraftMarkdown(draft);
    expect(md).toContain("- **t1** [Bug · High] 修复 Safari 登录页偶发白屏 → **CG-101**");
    expect(md).toContain("  - **t2** [Sub-task] 排查 WebKit 渲染日志");
    expect(md).toContain("- **t3** [Task] 接入前端错误上报 SDK");
  });

  it("renders links, details and notes", () => {
    const md = renderDraftMarkdown(draft);
    expect(md).toContain("t3 **Relates** CG-101");
    expect(md).toContain("## t1 · 修复 Safari 登录页偶发白屏");
    expect(md).toContain("父票: CG-101");
    expect(md).toContain("## AI 拆票说明");
  });
});
