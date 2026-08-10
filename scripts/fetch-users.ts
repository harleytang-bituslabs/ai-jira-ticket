/**
 * Pull the project's assignable user roster into .cache/users.json.
 *
 * Usage: npm run fetch-users  (or: npx tsx scripts/fetch-users.ts [config-path])
 *
 * Handy for checking what names/emails are safe to use in a draft's
 * `assignee` field (submit resolves them via the same user search).
 */

import "dotenv/config";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { listAssignableUsers } from "../src/clients/jira-client.js";
import { loadConfig } from "../src/core/config.js";
import { atomicWrite } from "../src/utils/fs.js";

const config = await loadConfig(process.argv[2] ?? "config.json");

console.log(`拉取项目 ${config.projectKey} 的可指派用户 …`);
const users = await listAssignableUsers(config.projectKey);

await mkdir(config.cacheDir, { recursive: true });
const outPath = join(config.cacheDir, "users.json");
await atomicWrite(
  outPath,
  JSON.stringify({ fetchedAt: new Date().toISOString(), total: users.length, users }, null, 2) + "\n",
);

console.log(`\n共 ${users.length} 名可指派用户 → ${outPath}`);
for (const u of users) console.log(`  ${u.displayName}${u.email ? `  <${u.email}>` : ""}`);
