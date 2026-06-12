/**
 * sync-spec: refresh the local caches from Confluence + Jira.
 *
 * Pages are fetched sequentially (be gentle to the API); Jira metadata is
 * fetched in parallel with them. Multiple spec pages are concatenated with a
 * title heading each, separated by horizontal rules.
 */

import { fetchPageMarkdown } from "../clients/confluence-client.js";
import { getProjectMeta, type ProjectMeta } from "../clients/jira-client.js";
import type { ResolvedConfig } from "./config.js";
import { writeProjectMeta, writeSpecCache, type SpecCache } from "./spec-cache.js";

export interface SyncResult {
  spec: SpecCache;
  meta: ProjectMeta;
}

export async function syncSpec(
  config: ResolvedConfig,
  onProgress?: (message: string) => void,
): Promise<SyncResult> {
  const send = onProgress ?? (() => {});

  const metaPromise = getProjectMeta(config.projectKey);
  const pages: Array<{ url: string; title: string; markdown: string; version: number | null }> = [];
  for (const url of config.specPageUrls) {
    send(`拉取 Confluence 页面 ${url} …`);
    const page = await fetchPageMarkdown(url);
    send(`  ✓ 《${page.title}》(版本 ${page.version ?? "?"}，${page.markdown.split("\n").length} 行)`);
    pages.push({ url, ...page });
  }
  const meta = await metaPromise;
  send(
    `  ✓ Jira 项目 ${config.projectKey}: ${meta.issueTypes.length} 种票类型 · ${meta.priorities.length} 个优先级 · ${meta.linkTypes.length} 种关联类型`,
  );

  const markdown = pages.map((p) => `# ${p.title}\n\n${p.markdown.trim()}`).join("\n\n---\n\n") + "\n";
  const spec: SpecCache = {
    markdown,
    sources: pages.map((p) => ({ url: p.url, title: p.title, version: p.version })),
    syncedAt: new Date().toISOString(),
  };
  await writeSpecCache(config.cacheDir, spec);
  await writeProjectMeta(config.cacheDir, meta);
  return { spec, meta };
}
