/** Minimal request log. Swap for pino-http when centralized logging exists. */

import type { NextFunction, Request, Response } from "express";

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/healthz") return next();
  const start = performance.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} → ${res.statusCode} ${Math.round(performance.now() - start)}ms`);
  });
  next();
}
