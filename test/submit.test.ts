import { describe, expect, it } from "vitest";
import type { ProjectMeta } from "../src/clients/jira-client.js";
import { DraftFileSchema, type Ticket } from "../src/core/schema.js";
import { precheck, topoSort } from "../src/core/submit.js";

const t = (localId: string, over: Partial<Ticket> = {}): Ticket => ({
  localId,
  summary: `票 ${localId}`,
  description: "内容",
  issueType: "Task",
  priority: null,
  labels: [],
  parent: null,
  assignee: null,
  reporter: null,
  dueDate: null,
  estimate: null,
  ...over,
});

describe("topoSort", () => {
  it("puts parents before children regardless of input order", () => {
    const sorted = topoSort([t("t3", { parent: "t2" }), t("t2", { parent: "t1" }), t("t1")]);
    expect(sorted.map((x) => x.localId)).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps independent roots and handles multiple children", () => {
    const sorted = topoSort([t("t2", { parent: "t1" }), t("t1"), t("t4"), t("t3", { parent: "t1" })]);
    const ids = sorted.map((x) => x.localId);
    expect(ids.indexOf("t1")).toBeLessThan(ids.indexOf("t2"));
    expect(ids.indexOf("t1")).toBeLessThan(ids.indexOf("t3"));
    expect(ids).toContain("t4");
  });

  it("throws on a cycle", () => {
    expect(() => topoSort([t("t1", { parent: "t2" }), t("t2", { parent: "t1" })])).toThrow(/cycle/);
  });

  it("throws on a dangling parent", () => {
    expect(() => topoSort([t("t1", { parent: "t9" })])).toThrow(/missing parent/);
  });

  it("treats a real Jira key parent as a root within the draft", () => {
    const sorted = topoSort([t("t2", { parent: "t1" }), t("t1", { parent: "AIP-7" })]);
    expect(sorted.map((x) => x.localId)).toEqual(["t1", "t2"]);
  });
});

describe("precheck", () => {
  const meta: ProjectMeta = {
    projectKey: "CG",
    issueTypes: [
      { id: "1", name: "Task", subtask: false },
      { id: "2", name: "Bug", subtask: false },
      { id: "3", name: "Sub-task", subtask: true },
    ],
    priorities: ["High", "Medium", "Low"],
    linkTypes: [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }],
    fetchedAt: "2026-06-11T09:00:00.000Z",
  };

  const draft = (tickets: unknown[], links: unknown[] = []) =>
    DraftFileSchema.parse({
      meta: {
        version: 1,
        createdAt: "2026-06-11T10:00:00.000Z",
        input: "x",
        projectKey: "CG",
        specSyncedAt: null,
        specVersions: [],
        model: "claude-opus-4-8",
      },
      tickets,
      links,
    });

  it("passes a clean draft", () => {
    const d = draft([t("t1", { priority: "High" }), t("t2", { issueType: "Sub-task", parent: "t1" })], [
      { from: "t1", to: "t2", type: "Blocks" },
    ]);
    expect(precheck(d, meta)).toEqual([]);
  });

  it("flags unknown issue type, priority and link type", () => {
    const d = draft([t("t1", { issueType: "Epic", priority: "Urgent" }), t("t2")], [
      { from: "t1", to: "t2", type: "Duplicates" },
    ]);
    const problems = precheck(d, meta);
    expect(problems.some((p) => p.includes('票类型 "Epic"'))).toBe(true);
    expect(problems.some((p) => p.includes('优先级 "Urgent"'))).toBe(true);
    expect(problems.some((p) => p.includes('"Duplicates" 不存在'))).toBe(true);
  });

  it("requires a parent for sub-task types", () => {
    const problems = precheck(draft([t("t1", { issueType: "Sub-task" })]), meta);
    expect(problems.some((p) => p.includes("必须有 parent"))).toBe(true);
  });

  it("accepts a real Jira key as parent", () => {
    const d = draft([t("t1", { parent: "AIP-7", priority: "High" })]);
    expect(precheck(d, meta)).toEqual([]);
  });
});
