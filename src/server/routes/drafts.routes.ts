/**
 * Draft lifecycle routes. The drafts dir doubles as ticketing history:
 * list / edit / resubmit / delete all operate on the same records, and
 * deleting history never touches Jira.
 */

import { Router } from "express";
import type { ResolvedConfig } from "../../core/config.js";
import { draftTickets } from "../../core/draft.js";
import { deleteDraftFiles, listDrafts, readDraftFile, writeDraftFiles } from "../../core/draft-files.js";
import { DraftFileSchema, type DraftFile } from "../../core/schema.js";
import { readProjectMeta } from "../../core/spec-cache.js";
import { submitDraft } from "../../core/submit.js";
import {
  applyComposeDefaults,
  buildFieldDirectives,
  mergeDraftEdits,
  parseComposeDefaults,
  str,
} from "../services/drafts.js";

export function draftsRoutes(config: ResolvedConfig): Router {
  const router = Router();

  /** 口语输入 + 表单字段 → AI 生成草稿并落盘。 */
  router.post("/draft", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const input = str(body.input);
    if (!input) throw new Error("input 不能为空");
    let splitCount: number | undefined;
    if (body.splitCount != null && body.splitCount !== "") {
      const n = Number(body.splitCount);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("splitCount 须为 1-20 的整数");
      splitCount = n;
    }
    const defaults = parseComposeDefaults((body.defaults ?? {}) as Record<string, unknown>);
    const fieldDirectives = await buildFieldDirectives(config, defaults);

    const draft = await draftTickets(input, {
      config,
      ...(splitCount != null ? { splitCount } : {}),
      ...(fieldDirectives ? { fieldDirectives } : {}),
    });
    applyComposeDefaults(draft, defaults);

    const saved = await writeDraftFiles(draft, config.draftsDir);
    res.json({ id: saved.id, draft });
  });

  router.get("/drafts", async (_req, res) => {
    res.json({ drafts: await listDrafts(config.draftsDir) });
  });

  /** Deletes every local record whose tickets are all submitted. */
  router.post("/drafts/cleanup", async (_req, res) => {
    const entries = await listDrafts(config.draftsDir);
    const done = entries.filter((e) => e.draft.tickets.every((t) => t.jiraKey));
    for (const e of done) await deleteDraftFiles(config.draftsDir, e.id);
    res.json({ removed: done.length });
  });

  /** Save card edits (submitted tickets are server-enforced read-only). */
  router.put("/drafts/:id", async (req, res) => {
    const incoming = DraftFileSchema.parse((req.body as { draft?: unknown }).draft);
    const disk = await readDraftFile(config.draftsDir, req.params.id);
    const merged = mergeDraftEdits(disk, incoming);
    const saved = await writeDraftFiles(merged, config.draftsDir);
    res.json({ id: saved.id, draft: merged });
  });

  router.post("/drafts/:id/submit", async (req, res) => {
    const id = req.params.id;
    const draft = await readDraftFile(config.draftsDir, id);
    const meta = await readProjectMeta(config.cacheDir);
    let result: DraftFile;
    try {
      result = await submitDraft(draft, {
        config,
        meta,
        persist: async (d) => {
          await writeDraftFiles(d, config.draftsDir);
        },
      });
    } catch (err) {
      // 提交是断点续传式的：部分进度已由 persist 落盘，连着错误一起回给前端。
      const latest = await readDraftFile(config.draftsDir, id).catch(() => draft);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err), id, draft: latest });
      return;
    }
    res.json({ id, draft: result });
  });

  router.delete("/drafts/:id", async (req, res) => {
    await deleteDraftFiles(config.draftsDir, req.params.id);
    res.json({ ok: true });
  });

  return router;
}
