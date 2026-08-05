/**
 * Draft lifecycle routes, scoped to the session user: every record lives in
 * the caller's own folder (owner = 登录邮箱). The drafts store doubles as
 * ticketing history: list / edit / resubmit / delete all operate on the same
 * records, and deleting history never touches Jira.
 */

import { Router } from "express";
import type { ResolvedConfig } from "../../core/config.js";
import { draftTickets } from "../../core/draft.js";
import { DraftFileSchema, type DraftFile } from "../../core/schema.js";
import { readProjectMeta } from "../../core/spec-cache.js";
import { submitDraft } from "../../core/submit.js";
import type { DraftStore } from "../../stores/draft-store.js";
import { HttpError } from "../middlewares/error.js";
import {
  applyComposeDefaults,
  buildFieldDirectives,
  mergeDraftEdits,
  parseComposeDefaults,
  str,
} from "../services/drafts.js";
import { enforcePolicy, jiraIdentity } from "../services/policy.js";

export function draftsRoutes(config: ResolvedConfig, store: DraftStore): Router {
  const router = Router();

  /** 口语输入 + 表单字段 → AI 生成草稿并写入本人文件夹。 */
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
    const user = req.user!;
    const defaults = parseComposeDefaults((body.defaults ?? {}) as Record<string, unknown>);
    // L1 的表单值在进入 AI 之前就矫正:类型不许 Epic,指派锁定本人(生成的内容才对得上人)
    if (user.level === "l1") {
      if (defaults.issueType === "Epic") throw new HttpError(403, "低级账号不能创建 Epic 类型的票");
      defaults.assignee = jiraIdentity(user);
    }
    const fieldDirectives = await buildFieldDirectives(config, defaults);

    const draft = await draftTickets(input, {
      config,
      ...(splitCount != null ? { splitCount } : {}),
      ...(fieldDirectives ? { fieldDirectives } : {}),
    });
    applyComposeDefaults(draft, defaults);
    enforcePolicy(user, draft); // 兜底:AI 产物同样不许越权

    const saved = await store.write(user.email, draft);
    res.json({ id: saved.id, draft });
  });

  /** scope=all(仅 admin)返回全员记录,带 owner 标签供所有者列/筛选。 */
  router.get("/drafts", async (req, res) => {
    if (req.query.scope === "all") {
      if (req.user!.level !== "admin") throw new HttpError(403, "需要管理员权限");
      res.json({ drafts: await store.listAll() });
      return;
    }
    res.json({ drafts: await store.list(req.user!.email) });
  });

  /** Deletes every record of the caller whose tickets are all submitted. */
  router.post("/drafts/cleanup", async (req, res) => {
    const owner = req.user!.email;
    const entries = await store.list(owner);
    const done = entries.filter((e) => e.draft.tickets.every((t) => t.jiraKey));
    for (const e of done) await store.delete(owner, e.id);
    res.json({ removed: done.length });
  });

  /** Save card edits (submitted tickets are server-enforced read-only). */
  router.put("/drafts/:id", async (req, res) => {
    const owner = req.user!.email;
    const incoming = DraftFileSchema.parse((req.body as { draft?: unknown }).draft);
    const disk = await store.read(owner, req.params.id);
    const merged = mergeDraftEdits(disk, incoming);
    enforcePolicy(req.user!, merged);
    // 原地更新:id 必须沿用,否则改了标题就会多出一条记录
    const saved = await store.write(owner, merged, req.params.id);
    res.json({ id: saved.id, draft: merged });
  });

  router.post("/drafts/:id/submit", async (req, res) => {
    const owner = req.user!.email;
    const id = req.params.id;
    const draft = await store.read(owner, id);
    enforcePolicy(req.user!, draft); // 手改存储绕过 PUT 的兜底
    const meta = await readProjectMeta(config.cacheDir);
    let result: DraftFile;
    try {
      result = await submitDraft(draft, {
        config,
        meta,
        persist: async (d) => {
          await store.write(owner, d, id); // 断点续传的写回同样是原地更新
        },
      });
    } catch (err) {
      // 提交是断点续传式的：部分进度已由 persist 落盘，连着错误一起回给前端。
      const latest = await store.read(owner, id).catch(() => draft);
      res.status(400).json({ error: err instanceof Error ? err.message : String(err), id, draft: latest });
      return;
    }
    res.json({ id, draft: result });
  });

  /** admin 可带 ?owner=<email> 删除他人记录(全员历史的管理职能);其他人只能删自己的。 */
  router.delete("/drafts/:id", async (req, res) => {
    const self = req.user!.email;
    const requested = typeof req.query.owner === "string" && req.query.owner ? req.query.owner.toLowerCase() : self;
    if (requested !== self && req.user!.level !== "admin") throw new HttpError(403, "只能删除自己的记录");
    await store.delete(requested, req.params.id);
    res.json({ ok: true });
  });

  return router;
}
