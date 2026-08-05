/**
 * ajt web — bootstrap only. App assembly lives in app.ts, HTTP handlers in
 * routes/, business helpers in services/, persistence in ../stores/.
 *
 * Storage backend: AJT_S3_BUCKET set → S3 (drafts + user directory in one
 * bucket, per-user folders); otherwise local fs for development.
 *
 * Binds to 127.0.0.1 by default — set AJT_HOST=0.0.0.0 to expose.
 */

import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { loadConfig } from "../core/config.js";
import { FsDraftStore, S3DraftStore, type DraftStore } from "../stores/draft-store.js";
import { FsUserStore, S3UserStore, type UserStore } from "../stores/user-store.js";
import { buildApp } from "./app.js";
import { bootstrapAdmin } from "./bootstrap.js";
import { ensureCaches } from "./services/refresh.js";

dotenv.config({ quiet: true });

const HOST = process.env.AJT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AJT_PORT ?? 9300);

const config = await loadConfig(process.env.AJT_CONFIG ?? "config.json");

const bucket = process.env.AJT_S3_BUCKET?.trim();
const drafts: DraftStore = bucket ? new S3DraftStore(bucket) : new FsDraftStore(config.draftsDir);
const users: UserStore = bucket ? new S3UserStore(bucket) : new FsUserStore("data/users.json");

const sessionSecret =
  process.env.SESSION_SECRET ??
  (() => {
    console.warn("⚠ SESSION_SECRET 未设置——本次进程使用随机密钥，重启后所有登录会话失效");
    return randomBytes(32).toString("hex");
  })();

await bootstrapAdmin(users);

const app = buildApp(config, { drafts, users, sessionSecret });

app.listen(PORT, HOST, () => {
  console.log(`ajt web 已启动: http://${HOST}:${PORT}  (项目 ${config.projectKey} · 存储 ${bucket ? `S3:${bucket}` : "本地文件"})`);
  if (HOST === "127.0.0.1") {
    console.log(`本机以外访问请走 SSH 隧道: ssh -L ${PORT}:localhost:${PORT} <这台服务器>`);
  }
  // 先监听、后拉缓存：容器平台的健康检查等不了首启那几十秒（等不到 /healthz 就判部署失败）。
  // 这几十秒里 /api/meta 会报错，拉完即自愈。
  void ensureCaches(config);
});
