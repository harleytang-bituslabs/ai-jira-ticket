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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../core/config.js";
import type { CacheStore } from "../stores/cache-store.js";
import type { DraftStore } from "../stores/draft-store.js";
import type { UserStore } from "../stores/user-store.js";
import { attachAuth, requireAdmin, requireAuth } from "./middlewares/auth.js";
import { errorHandler, notFound } from "./middlewares/error.js";
import { requestLog } from "./middlewares/log.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { draftsRoutes } from "./routes/drafts.routes.js";
import { metaRoutes } from "./routes/meta.routes.js";

/** Vite build output (npm run build:web). Assets are hashed, index.html must not be cached. */
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface AppDeps {
  drafts: DraftStore;
  users: UserStore;
  /** 共享参考数据(规范/看板/名册)。所有用户读同一份,不按人隔离。 */
  cache: CacheStore;
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
  app.use(express.static(WEB_DIST, { index: false }));
  app.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(join(WEB_DIST, "index.html"), (err) => {
      if (err && !res.headersSent) res.status(503).type("text/plain").send("前端未构建:先运行 npm run build:web");
    });
  });

  app.use("/api", authRoutes(deps.users, deps.sessionSecret));
  app.use("/api/admin", requireAdmin, adminRoutes(config, deps.users, deps.cache));
  app.use("/api", requireAuth, metaRoutes(config, deps.cache, deps.users));
  app.use("/api", requireAuth, draftsRoutes(config, deps.drafts, deps.cache, deps.users));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
