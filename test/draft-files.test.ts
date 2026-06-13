import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertDraftId,
  deleteDraftFiles,
  listDrafts,
  readDraftFile,
  writeDraftFiles,
} from "../src/core/draft-files.js";
import { DraftFileSchema, type DraftFile } from "../src/core/schema.js";

const mkDraft = (createdAt: string, summary: string): DraftFile =>
  DraftFileSchema.parse({
    meta: {
      version: 1,
      createdAt,
      input: "测试输入",
      projectKey: "AIP",
      specSyncedAt: null,
      specVersions: [],
      model: "claude-opus-4-8",
    },
    tickets: [{ localId: "t1", summary, description: "正文", issueType: "Task" }],
    links: [],
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ajt-drafts-"));
});

describe("draft-files", () => {
  it("writes json+md and lists newest first", async () => {
    await writeDraftFiles(mkDraft("2026-06-10T08:00:00.000Z", "Old work"), dir);
    const newer = await writeDraftFiles(mkDraft("2026-06-12T08:00:00.000Z", "New work"), dir);
    const entries = await listDrafts(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(newer.id);
    expect((await readdir(dir)).filter((f) => f.endsWith(".md"))).toHaveLength(2);
  });

  it("skips corrupt files instead of failing the whole listing", async () => {
    await writeDraftFiles(mkDraft("2026-06-12T08:00:00.000Z", "Good"), dir);
    await writeFile(join(dir, "20260601-000000-broken.json"), "{ not json", "utf-8");
    await writeFile(join(dir, "20260601-000001-wrongshape.json"), JSON.stringify({ hello: 1 }), "utf-8");
    const entries = await listDrafts(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].draft.tickets[0].summary).toBe("Good");
  });

  it("round-trips a draft by id and errors on a missing one", async () => {
    const { id } = await writeDraftFiles(mkDraft("2026-06-12T08:00:00.000Z", "Round trip"), dir);
    const loaded = await readDraftFile(dir, id);
    expect(loaded.tickets[0].summary).toBe("Round trip");
    await expect(readDraftFile(dir, "20990101-000000-nope")).rejects.toThrow(/不存在/);
  });

  it("deletes both files", async () => {
    const { id } = await writeDraftFiles(mkDraft("2026-06-12T08:00:00.000Z", "Delete me"), dir);
    await deleteDraftFiles(dir, id);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects path-traversal ids", () => {
    expect(() => assertDraftId("../etc/passwd")).toThrow(/非法/);
    expect(() => assertDraftId("a/b")).toThrow(/非法/);
    expect(() => assertDraftId("20260612-013200-Infinite-Factory")).not.toThrow();
    expect(() => assertDraftId("20260612-101010-修复登录")).not.toThrow();
  });

  it("listDrafts on a missing dir returns empty", async () => {
    expect(await listDrafts(join(dir, "no-such-subdir"))).toEqual([]);
  });
});
