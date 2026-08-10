/**
 * Pull the project's participant roster into .cache/users.json — the same list
 * the web form's assignee picker uses.
 *
 * Usage: npm run fetch-users  (or: npx tsx scripts/fetch-users.ts [config-path])
 *
 * Handy for checking what names/emails are safe to use in a draft's
 * `assignee` field (submit resolves them via the same user search).
 */

import "dotenv/config";
import { join } from "node:path";
import { listProjectParticipants } from "../src/clients/jira-client.js";
import { loadConfig } from "../src/core/config.js";
import { writeUsersCache } from "../src/core/spec-cache.js";
import { FsCacheStore } from "../src/stores/cache-store.js";

const config = await loadConfig(process.argv[2] ?? "config.json");

console.log(`拉取项目 ${config.projectKey} 的参与者 …`);
const users = await listProjectParticipants(config.projectKey);

const outPath = join(config.cacheDir, "users.json");
await writeUsersCache(new FsCacheStore(config.cacheDir), {
  fetchedAt: new Date().toISOString(),
  total: users.length,
  users,
});

console.log(`\n共 ${users.length} 名参与者 → ${outPath}`);
for (const u of users) console.log(`  ${u.displayName}${u.email ? `  <${u.email}>` : ""}`);
