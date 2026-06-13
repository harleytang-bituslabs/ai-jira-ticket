/**
 * ajt — the CLI shell over src/core.
 *
 * This file owns everything the library layer must not touch: dotenv, argv,
 * stdout, draft file naming/writing, interactive confirmation, exit codes.
 */

import { Command } from "commander";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../core/config.js";
import { draftTickets } from "../core/draft.js";
import { writeDraftFiles } from "../core/draft-files.js";
import { renderDraftMarkdown } from "../core/render.js";
import type { DraftFile } from "../core/schema.js";
import { readProjectMeta } from "../core/spec-cache.js";
import { submitDraft } from "../core/submit.js";
import { syncSpec } from "../core/sync-spec.js";
import { atomicWrite } from "../utils/fs.js";

dotenv.config({ quiet: true });

const program = new Command();
program
  .name("ajt")
  .description("AI Jira ticketing assistant — colloquial input in, spec-compliant tickets out")
  .option("--config <path>", "path to config.json", "config.json");

program
  .command("sync-spec")
  .description("拉取 Confluence 规范 + Jira 项目元数据，写入本地缓存")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const { spec, meta } = await syncSpec(config, (m) => console.log(m));
    console.log(`\n规范缓存 → ${config.cacheDir}/spec.md`);
    for (const s of spec.sources) console.log(`  《${s.title}》 v${s.version ?? "?"}  ${s.url}`);
    console.log(`项目元数据 → ${config.cacheDir}/project-meta.json`);
    console.log(`  票类型: ${meta.issueTypes.map((t) => t.name).join(", ")}`);
    console.log(`  优先级: ${meta.priorities.join(", ")}`);
    console.log(`  关联类型: ${meta.linkTypes.map((l) => l.name).join(", ")}`);
  });

program
  .command("draft")
  .description("把口语化描述变成结构化开票草稿（不碰 Jira）")
  .argument("<input...>", "口语化的需求/问题描述")
  .action(async (inputWords: string[]) => {
    const config = await loadConfig(program.opts().config);
    const input = inputWords.join(" ");
    const draft = await draftTickets(input, { config, onProgress: (m) => console.log(m) });
    const { jsonPath, mdPath } = await writeDraftFiles(draft, config.draftsDir);

    console.log(`\n生成 ${draft.tickets.length} 张票:`);
    for (const t of draft.tickets) {
      const badge = t.priority ? `${t.issueType}/${t.priority}` : t.issueType;
      console.log(`  ${t.localId} [${badge}]${t.parent ? ` (父: ${t.parent})` : ""} ${t.summary}`);
    }
    for (const l of draft.links) console.log(`  关联: ${l.from} ${l.type} ${l.to}`);
    if (draft.notes) console.log(`  说明: ${draft.notes}`);
    console.log(`\n草稿: ${jsonPath}`);
    console.log(`预览: ${mdPath}`);
    console.log(`检查/编辑草稿后运行: npm run ajt -- submit ${jsonPath}`);
  });

program
  .command("submit")
  .description("把草稿提交到 Jira（可反复重跑，已创建的自动跳过）")
  .argument("<file>", "draft 生成的 .json 草稿文件")
  .option("--dry-run", "只校验和展示计划，不创建")
  .option("--yes", "跳过交互确认")
  .option("--force", "跳过元数据预检")
  .action(async (file: string, opts: { dryRun?: boolean; yes?: boolean; force?: boolean }) => {
    const config = await loadConfig(program.opts().config);
    const meta = await readProjectMeta(config.cacheDir);
    let raw: string;
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      throw new Error(`读不到草稿文件 ${file} — 路径写对了吗？`);
    }
    // Parsed loosely here; submitDraft runs full schema validation first thing.
    const draft = JSON.parse(raw) as DraftFile;

    const result = await submitDraft(draft, {
      config,
      meta,
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.force ? { force: true } : {}),
      onProgress: (m) => console.log(m),
      persist: async (d) => {
        await atomicWrite(file, JSON.stringify(d, null, 2) + "\n");
        await atomicWrite(file.replace(/\.json$/, ".md"), renderDraftMarkdown(d));
      },
      ...(opts.yes || opts.dryRun
        ? {}
        : {
            confirm: async (plan: string) => {
              console.log(plan);
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              const answer = await rl.question("继续提交? [y/N] ");
              rl.close();
              return answer.trim().toLowerCase() === "y";
            },
          }),
    });

    if (!opts.dryRun) {
      const created = result.tickets.filter((t) => t.jiraKey);
      if (created.length === result.tickets.length) {
        console.log(`\n完成 — ${created.length} 张票已上板:`);
        for (const t of created) console.log(`  ${t.jiraKey}  ${t.jiraUrl}`);
      }
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
