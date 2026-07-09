/**
 * Tail middlewares: 404 for unmatched routes, unified error responses.
 *
 * Business errors thrown from handlers become 400 {error} (Express 5 forwards
 * rejected async handlers here automatically). Errors carrying a numeric
 * `status` (e.g. body-parser failures) keep their own code.
 */

import type { NextFunction, Request, Response } from "express";

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: "not found" });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e = err as { status?: unknown; type?: unknown; message?: unknown };
  if (e.type === "entity.parse.failed") {
    res.status(400).json({ error: "请求体不是合法 JSON" });
    return;
  }
  const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 400;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}
