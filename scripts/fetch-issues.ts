/**
 * Pull every ticket of the configured Jira project into .cache/issues.json.
 *
 * Usage: npm run fetch-issues  (or: npx tsx scripts/fetch-issues.ts [config-path])
 *
 * Handy for eyeballing board state and for looking up Epic keys when filling
 * a draft's `parent` field.
 */

import "dotenv/config";
import { join } from "node:path";
import { searchIssues } from "../src/clients/jira-client.js";
import { loadConfig } from "../src/core/config.js";
import { writeIssuesCache } from "../src/core/spec-cache.js";

const config = await loadConfig(process.argv[2] ?? "config.json");

console.log(`拉取项目 ${config.projectKey} 的全部票据 …`);
const issues = await searchIssues(`project = ${config.projectKey} ORDER BY created ASC`);

const outPath = join(config.cacheDir, "issues.json");
await writeIssuesCache(config.cacheDir, {
  projectKey: config.projectKey,
  fetchedAt: new Date().toISOString(),
  issues,
});

const byType = new Map<string, number>();
for (const i of issues) byType.set(i.issueType, (byType.get(i.issueType) ?? 0) + 1);

console.log(`\n共 ${issues.length} 张 → ${outPath}`);
console.log(`按类型: ${[...byType.entries()].map(([t, n]) => `${t} ${n}`).join(" · ")}`);

const epics = issues.filter((i) => i.issueType === "Epic");
if (epics.length) {
  console.log(`\nEpic 清单（填草稿 parent 用）:`);
  for (const e of epics) console.log(`  ${e.key}  [${e.status}]  ${e.summary}`);
}
