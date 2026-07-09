/**
 * Express app assembly — middleware chain + route mounting. Kept separate
 * from the listen bootstrap (index.ts) so tests can drive the app with
 * supertest and every dependency (config, stores, session secret) stays
 * injectable.
 *
 * Auth model: /healthz and /api/login are open; everything else under /api
 * requires a session. GET / serves the app shell (the frontend redirects to
 * login on 401s).
 */

import express from "express";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../core/config.js";
import type { DraftStore } from "../stores/draft-store.js";
import type { UserStore } from "../stores/user-store.js";
import { attachAuth, requireAuth } from "./middlewares/auth.js";
import { errorHandler, notFound } from "./middlewares/error.js";
import { requestLog } from "./middlewares/log.js";
import { authRoutes } from "./routes/auth.routes.js";
import { draftsRoutes } from "./routes/drafts.routes.js";
import { metaRoutes } from "./routes/meta.routes.js";

const HTML_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

export interface AppDeps {
  drafts: DraftStore;
  users: UserStore;
  sessionSecret: string;
}

export function buildApp(config: ResolvedConfig, deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // 未来在 ALB 后面时 req.ip 取真实客户端
  app.use(express.json({ limit: "2mb" }));
  app.use(requestLog);
  app.use(attachAuth(deps.users, deps.sessionSecret));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(HTML_PATH);
  });

  app.use("/api", authRoutes(deps.users, deps.sessionSecret));
  app.use("/api", requireAuth, metaRoutes(config));
  app.use("/api", requireAuth, draftsRoutes(config, deps.drafts));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
