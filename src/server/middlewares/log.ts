/** Minimal request log. Swap for pino-http when centralized logging exists. */

import type { NextFunction, Request, Response } from "express";

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/healthz") return next();
  const start = performance.now();
  const path = req.originalUrl; // req.path 在挂载路由内会被裁剪,入口处捕获全路径
  res.on("finish", () => {
    console.log(`${req.method} ${path} → ${res.statusCode} ${Math.round(performance.now() - start)}ms`);
  });
  next();
}
