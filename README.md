# ai-jira-ticket (ajt)

AI 开票助手：输入口语化的中/英文描述，按团队保存在 Confluence 上的开票规范，生成结构化 Jira 票据草稿，人工确认后提交到 Jira kanban board。

半自动两步流：`draft` 生成草稿（不碰 Jira）→ 人工查看/编辑 → `submit` 提交（可反复重跑，已创建的自动跳过）。核心逻辑在 `src/core/`，是与终端无关的库函数 —— 未来要做 HTTP API / Slack bot 全自动，外面套壳即可。

## 安装与配置（一次性）

```bash
npm install
cp .env.example .env   # 填三样: ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN / ANTHROPIC_API_KEY
                       # (兼容老项目的 CONFLUENCE_* 变量名)
```

编辑 `config.json`（入库共享，无密钥）:

```jsonc
{
  "projectKey": "AIP",                   // 目标 Jira 项目代号
  "specPageUrls": ["https://<site>.atlassian.net/wiki/spaces/X/pages/<id>/..."],  // 规范页面，可多篇
  "defaultPriority": "P2",               // 提示给 AI 的默认优先级（仅 Story/Task；提交时不自动补）
  "staticFields": {},                    // 每张票固定附加的 Jira 字段（必填自定义字段逃生门）
  "language": "auto"                     // description 语言: zh / en / auto(跟随输入)；标题按规范恒为英文
}
```

然后同步一次规范:

```bash
npm run ajt -- sync-spec
```

## 日常使用（网页版，推荐）

```bash
npm run web    # 默认 http://127.0.0.1:9300，远程访问走 SSH 隧道: ssh -L 9300:localhost:9300 <服务器>
```

**开票页**：口语描述大活（谁干什么、什么时候要，说在话里 AI 会捕捉成预填值）→ 选拆票方式（AI 自行决定 / 不拆 / 指定 N 张）→ AI 拆出 1..N 张**可编辑卡片**——标题正文可直接改，类型 / 优先级 / 父级 / 指派 / 截止日期每卡一套下拉框（AI 的选择只是预填，人有最终决定权），批量栏支持"全部指派给某人"一键铺开。不想要的卡直接删。确认后提交，先父后子上板，每张给链接。

**历史页**：每次开票一条记录，每张票显示 `草稿 / 已提交` 状态（已提交带 Jira 链接、只读）。没提完的可"继续编辑"接着提（断点续传）；"删除"和"清理已完结"只删本地 `drafts/` 档案，**绝不影响 Jira 上已建的票**。

候选数据来自缓存：Epic/父级列表更新跑 `npm run fetch-issues`，规范改版跑 `npm run ajt -- sync-spec`；指派候选是 config.json 的 `teamMembers` 静态名单。

## 日常使用（CLI 版，AI 自动拆票）

```bash
# 1. 说人话生成草稿（落在 drafts/，附同名 .md 预览）
npm run ajt -- draft "Safari 登录页偶发白屏要修，顺便把前端错误上报也接上"

# 2. 查看/编辑草稿 JSON（description 就是一段 markdown 文本），然后提交
npm run ajt -- submit drafts/20260611-153000-xxx.json
```

`submit` 的开关:

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只校验和展示计划、验证 description 可转 Jira 格式，不创建 |
| `--yes` | 跳过交互确认（自动化用） |
| `--force` | 跳过元数据预检（极少用） |

所有命令支持 `--config <path>` 指向另一份 config.json（多项目共用一套工具）。

## 规范更新了怎么办

Confluence 上的规范页面改版后，任何人跑一次 `npm run ajt -- sync-spec` 即可。draft 时若缓存超过 30 天会提示。缓存文件（`.cache/spec.md`）的 frontmatter 记录了来源 URL、页面版本号和同步时间，可审计。

## 字段支持范围

- `parent` 可以填草稿内引用（t1）或**已存在的 Jira key**（如 `AIP-7` 的 Epic）——本项目 Story/Task 创建时必须挂 Epic
- `assignee`（姓名/邮箱，submit 时自动解析成 Jira 账号）和 `dueDate`（YYYY-MM-DD）会真实提交——Sub-task 创建时这两项必填，AI 起草若留空需人工在草稿里补
- `priority` 完全由草稿决定，提交时不自动补默认值（Sub-task / Bug 按规范不带优先级）
- **已知限制**：Bug 在本项目创建时必填的 Severity / Source / Detected Environment / Affects Version 自定义字段暂不支持自动提交，AI 会把这些信息写进 description 并在 notes 里提醒人工补填

## 中途失败怎么办

submit 每建成一张票就把 Jira key 写回草稿文件。任何一步失败（最常见：项目有必填自定义字段），终端会打印 Jira 的具体报错；修复草稿（或往 `config.json` 的 `staticFields` 里补字段）后**重跑同一条命令**，已创建的票和关联自动跳过。

## 架构速览

```
src/
├── clients/        Atlassian HTTP 层（原生 fetch + Basic auth，凭证收敛在 atlassian-auth.ts）
│   ├── confluence-client.ts   页面 → markdown（复用自 ai-game-whole-game-pipeline，含 5 条 Confluence 修复规则）
│   └── jira-client.ts         createmeta / createIssue / issueLink，Jira 错误体透传
├── llm/client.ts   Anthropic 结构化输出薄封装（messages.parse + zod schema + prompt cache）
├── core/           纯库层（不碰 argv/stdout）: config / schema / spec-cache / sync-spec / draft / submit / render
├── prompts/        draft 的 system prompt 模板（{{SPEC}} 注入规范全文）
└── cli/index.ts    commander 薄壳: sync-spec / draft / submit
```

关键设计:

- **规范静态缓存**: draft 读本地 `.cache/`，不实时拉 Confluence —— 快、离线可用、system prompt 字节稳定（Anthropic prompt cache 跨多次 draft 命中省钱）。
- **结构化输出**: LLM 经 API 层 schema 约束直接产出合法 JSON（zod 定义见 `src/core/schema.ts`），票间关系用局部 id（t1/t2），submit 时按拓扑序（先父后子）映射成真实 key。
- **草稿即进度日志**: `drafts/*.json` 是唯一真相源（`.md` 仅预览），submit 的写回让重跑天然幂等。

## 开发

```bash
npm test                # vitest 单测
npm run typecheck       # tsc --noEmit
```
