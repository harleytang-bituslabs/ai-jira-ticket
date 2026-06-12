import { describe, expect, it } from "vitest";
import {
  DraftFileSchema,
  DraftPayloadSchema,
  crossValidationIssues,
} from "../src/core/schema.js";

const ticket = (over: Record<string, unknown> = {}) => ({
  localId: "t1",
  summary: "修复登录白屏",
  description: "## 背景\n- Safari 偶发白屏",
  issueType: "Bug",
  ...over,
});

describe("DraftPayloadSchema", () => {
  it("accepts a minimal payload and applies defaults", () => {
    const parsed = DraftPayloadSchema.parse({ tickets: [ticket()] });
    expect(parsed.tickets[0].labels).toEqual([]);
    expect(parsed.tickets[0].parent).toBeNull();
    expect(parsed.tickets[0].priority).toBeNull();
    expect(parsed.links).toEqual([]);
    expect(parsed.notes).toBeNull();
  });

  it("accepts parent/child plus a link", () => {
    const parsed = DraftPayloadSchema.parse({
      tickets: [ticket(), ticket({ localId: "t2", parent: "t1", issueType: "Sub-task" })],
      links: [{ from: "t1", to: "t2", type: "Relates" }],
    });
    expect(parsed.tickets).toHaveLength(2);
  });

  it("rejects duplicate localIds", () => {
    const r = DraftPayloadSchema.safeParse({ tickets: [ticket(), ticket()] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("duplicate localId");
  });

  it("rejects a dangling parent reference", () => {
    const r = DraftPayloadSchema.safeParse({ tickets: [ticket({ parent: "t9" })] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("missing parent");
  });

  it("rejects self-parenting", () => {
    const r = DraftPayloadSchema.safeParse({ tickets: [ticket({ parent: "t1" })] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("itself as parent");
  });

  it("rejects a parent cycle", () => {
    const r = DraftPayloadSchema.safeParse({
      tickets: [ticket({ parent: "t2" }), ticket({ localId: "t2", parent: "t1" })],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("cycle");
  });

  it("rejects links that reference missing tickets or themselves", () => {
    const dangling = DraftPayloadSchema.safeParse({
      tickets: [ticket()],
      links: [{ from: "t1", to: "t9", type: "Blocks" }],
    });
    expect(dangling.success).toBe(false);
    const self = DraftPayloadSchema.safeParse({
      tickets: [ticket()],
      links: [{ from: "t1", to: "t1", type: "Blocks" }],
    });
    expect(self.success).toBe(false);
  });

  it("rejects labels containing whitespace", () => {
    const r = DraftPayloadSchema.safeParse({ tickets: [ticket({ labels: ["front end"] })] });
    expect(r.success).toBe(false);
  });

  it("accepts real Jira keys as parent / link refs without requiring them in the draft", () => {
    const parsed = DraftPayloadSchema.parse({
      tickets: [ticket({ parent: "AIP-12" })],
      links: [{ from: "t1", to: "AIP-5", type: "Relates" }],
    });
    expect(parsed.tickets[0].parent).toBe("AIP-12");
  });

  it("rejects malformed parent refs", () => {
    expect(DraftPayloadSchema.safeParse({ tickets: [ticket({ parent: "x1" })] }).success).toBe(false);
  });

  it("validates dueDate format", () => {
    expect(DraftPayloadSchema.safeParse({ tickets: [ticket({ dueDate: "2026-06-19" })] }).success).toBe(true);
    expect(DraftPayloadSchema.safeParse({ tickets: [ticket({ dueDate: "6月19日" })] }).success).toBe(false);
  });
});

describe("DraftFileSchema", () => {
  const meta = {
    version: 1,
    createdAt: "2026-06-11T10:00:00.000Z",
    input: "修登录白屏",
    projectKey: "CG",
    specSyncedAt: "2026-06-11T09:00:00.000Z",
    specVersions: [12],
    model: "claude-opus-4-8",
  };

  it("round-trips a submitted draft (jiraKey written back)", () => {
    const parsed = DraftFileSchema.parse({
      meta,
      tickets: [{ ...ticket(), jiraKey: "CG-1", jiraUrl: "https://x.atlassian.net/browse/CG-1" }],
      links: [],
    });
    expect(parsed.tickets[0].jiraKey).toBe("CG-1");
  });

  it("runs the same cross-validation as the payload schema", () => {
    const r = DraftFileSchema.safeParse({ meta, tickets: [ticket({ parent: "t9" })] });
    expect(r.success).toBe(false);
  });
});

describe("crossValidationIssues", () => {
  it("returns empty for consistent references", () => {
    expect(
      crossValidationIssues({
        tickets: [
          { localId: "t1", parent: null },
          { localId: "t2", parent: "t1" },
        ],
        links: [{ from: "t1", to: "t2" }],
      }),
    ).toEqual([]);
  });
});
