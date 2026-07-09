/**
 * Express app assembly — middleware chain + route mounting. Kept separate
 * from the listen bootstrap (index.ts) so tests can drive the app with
 * supertest and config stays injectable.
 */

import express from "express";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../core/config.js";
import { errorHandler, notFound } from "./middlewares/error.js";
import { requestLog } from "./middlewares/log.js";
import { draftsRoutes } from "./routes/drafts.routes.js";
import { metaRoutes } from "./routes/meta.routes.js";

const HTML_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

export function buildApp(config: ResolvedConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLog);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(HTML_PATH);
  });

  app.use("/api", metaRoutes(config));
  app.use("/api", draftsRoutes(config));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
