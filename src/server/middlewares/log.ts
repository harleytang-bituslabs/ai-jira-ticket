/**
 * Minimal request log. Swap for pino-http when centralized logging exists.
 *
 * Every request gets an 8-char id that appears in this line, in the error log
 * line, on the X-Request-Id header and in the JSON error body — so a user's
 * screenshot of 「排查码 a1b2c3d4」 resolves to one grep.
 */

import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  // Minted before the /healthz short-circuit: an error thrown anywhere still has one.
  req.id = randomBytes(4).toString("hex");
  res.setHeader("X-Request-Id", req.id);
  if (req.path === "/healthz") return next();
  const start = performance.now();
  const path = req.originalUrl; // req.path 在挂载路由内会被裁剪,入口处捕获全路径
  res.on("finish", () => {
    const who = req.user?.email ?? "anon";
    console.log(
      `${req.id} ${req.method} ${path} → ${res.statusCode} ${Math.round(performance.now() - start)}ms ${who}`,
    );
  });
  next();
}
