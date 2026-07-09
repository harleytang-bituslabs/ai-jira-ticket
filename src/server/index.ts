/**
 * ajt web — bootstrap only. App assembly lives in app.ts, HTTP handlers in
 * routes/, business helpers in services/, cross-cutting concerns in
 * middlewares/.
 *
 * Binds to 127.0.0.1 by default — this box is shared and the server can
 * create Jira tickets with the .env credentials. Reach it via an SSH tunnel
 * (ssh -L 9300:localhost:9300 <server>) or set AJT_HOST=0.0.0.0.
 */

import dotenv from "dotenv";
import { loadConfig } from "../core/config.js";
import { buildApp } from "./app.js";

dotenv.config({ quiet: true });

const HOST = process.env.AJT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AJT_PORT ?? 9300);

const config = await loadConfig(process.env.AJT_CONFIG ?? "config.json");
const app = buildApp(config);

app.listen(PORT, HOST, () => {
  console.log(`ajt web 已启动: http://${HOST}:${PORT}  (项目 ${config.projectKey})`);
  if (HOST === "127.0.0.1") {
    console.log(`本机以外访问请走 SSH 隧道: ssh -L ${PORT}:localhost:${PORT} <这台服务器>`);
  }
});
