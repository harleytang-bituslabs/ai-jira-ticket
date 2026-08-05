# ai-jira-ticket (ajt)

AI 开票助手：输入口语化的中/英文描述，按团队保存在 Confluence 上的开票规范，生成结构化 Jira 票据草稿，人工确认后提交到 Jira kanban board。

2.0 起是**多用户 Web 服务**：邮箱+密码登录、两级职级+管理员、全员历史（admin）、提交确认防呆、草稿存 S3（每人一个文件夹）、Docker/CodeBuild 可部署。核心逻辑在 `src/core/`，与 HTTP 层解耦；CLI 保留为个人本地模式。

## 权限模型

| 能力 | 普通 (l1) | 高级 (l2) | 管理员 (admin) |
|---|---|---|---|
| 开票类型 | 不允许 Epic | 全部 | 全部 |
| 指派 | 强制=本人 | 任意（全员名册） | 任意 |
| 历史 | 仅自己 | 仅自己（含指派筛选） | **全员**（所有者列/筛选） |
| 他人记录 | — | — | 可查看、可删除（编辑/提交仍仅限自己的草稿） |
| 用户管理 | — | — | 建号 / 定级 / 重置密码 / 停用 |

权限由服务端中间件强制（`enforcePolicy` 在生成/保存/提交三条路径统一执行），前端只做隐藏。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` | ✅ | Atlassian API 凭证（Confluence + Jira 共用；兼容旧 `CONFLUENCE_*` 变量名） |
| `ANTHROPIC_API_KEY` | ✅ | AI 起草用 |
| `SESSION_SECRET` | 生产✅ | 会话 cookie 的 HMAC 密钥（≥32 随机字符）。不设则每次重启随机生成，所有人被登出 |
| `AJT_ADMIN_EMAIL` / `AJT_ADMIN_PASSWORD` | 首启✅ | 用户表为空时种入第一个管理员，之后无作用（`AJT_ADMIN_NAME` 可选，默认取邮箱前缀） |
| `AJT_S3_BUCKET` | | 设了走 S3 存储（草稿 `drafts/{email}/` + 用户表 `users.json`）；不设用本地 fs（开发模式）。凭证走标准 AWS 链（实例角色 / env） |
| `AJT_HOST` / `AJT_PORT` | | 默认 `127.0.0.1:9300`；容器/对外部署设 `AJT_HOST=0.0.0.0` |
| `AJT_COOKIE_SECURE` | | 上 HTTPS 后设 `1`（cookie 加 Secure 标记） |
| `AJT_MODEL` | | 覆盖起草模型（默认见 `src/llm/client.ts`） |
| `AJT_CONFIG` | | 指向另一份 config.json（默认 `./config.json`） |

`config.json`（入库共享，无密钥）：`projectKey` / `specPageUrls`（Confluence 规范页，可多篇）/ `defaultPriority` / `staticFields`（必填自定义字段逃生门）/ `language`（zh / en / auto）/ `teamMembers`（指派名册的兜底静态名单，拉过 Jira 全员缓存后即被替代）。

## 本地开发

```bash
npm install
cp .env.example .env        # 填 ATLASSIAN_* 与 ANTHROPIC_API_KEY
npm run ajt -- sync-spec    # 同步规范 + 项目元数据到 .cache/
npm run fetch-issues        # 看板快照（父级候选）
npm run build:web           # 构建前端 → web/dist

AJT_ADMIN_EMAIL=you@company.com AJT_ADMIN_PASSWORD=changeme8 npm run web
# → http://127.0.0.1:9300 登录即用。前端热更新开发另起: npm run dev:web (vite, 代理 /api → :9300)
```

测试与类型：`npm test`（vitest 单测 + supertest 路由级权限矩阵）、`npm run typecheck`（服务端 + 前端双 tsc）。

## 网页版使用

- **开票**：选优先级/类型/父级/指派/截止（说在话里的信息 AI 也会捕捉）→ 口语描述 → 选拆票方式（AI 自行决定 / 不拆 / 指定 N 张）→ AI 拆出可编辑卡片 → 微调 → 提交（弹窗确认每张票后才上板，先父后子，每张给链接）。Sub-task 父级两级联动（先选 Epic）。
- **历史**：历史即草稿档案。筛选：时间起止 / 父级 / 指派 / 提交状态（admin 另有所有者筛选）。没提完的「继续编辑」断点续传；「删除」「清理已完结」只删档案，**绝不影响 Jira 上已建的票**。
- **管理**（admin）：添加用户（邮箱=登录名、初始密码线下告知、级别、可选 Jira 邮箱）、改级别、停用（会话 30 秒内失效）、重置密码。防呆：最后一个活跃管理员不可被降级/停用。
- **更新config** 按钮：一键重拉 Confluence 规范 + Jira 看板快照 + 全员名册。**新环境首次登录后先点一次**。

## 部署（Docker / AWS CodeBuild）

```bash
# 本机验证镜像
docker build -t ajt .
docker run --rm -p 9300:9300 --env-file .env \
  -e SESSION_SECRET=<random> -e AJT_S3_BUCKET=<bucket> \
  -e AJT_ADMIN_EMAIL=you@company.com -e AJT_ADMIN_PASSWORD=<initial> ajt
```

多阶段构建：stage1 装全部依赖并 `vite build`，stage2 只带生产依赖 + `tsx` 直跑 TS 源码，非 root 运行，自带 `/healthz` 健康检查。

CodeBuild 用根目录 `buildspec.yml`：typecheck + 测试 → `docker build` → 推 ECR（`$ECR_REPO` 环境变量指定仓库，commit 短 hash + latest 双标签）→ 产出 `imagedefinitions.json` 供 ECS 流水线。环境需勾选 Privileged。

生产要点：

- **S3 模式必开**（`AJT_S3_BUCKET`）——容器磁盘是易失的；fs 模式仅限本地开发
- `.cache/` 在镜像里是空的：首启后管理员登录点一次「更新config」即可（或把三个 fetch 脚本跑进启动流程）
- **HTTPS 前密码走明文**：域名 + ACM + ALB 是下一阶段；在那之前只在内网使用，之后设 `AJT_COOKIE_SECURE=1`
- 单实例假设（登录限速与用户缓存在内存里）；上多实例前需要外置

## CLI 版（个人本地模式，无登录/无 S3）

```bash
npm run ajt -- draft "Safari 登录页偶发白屏要修，顺便把前端错误上报也接上"
npm run ajt -- submit drafts/20260611-153000-xxx.json   # --dry-run / --yes / --force
```

草稿即进度日志：submit 每建成一张票就把 Jira key 写回，失败修复后重跑同一条命令，已创建的自动跳过。

## 字段支持范围

- `parent` 可填草稿内引用（t1）或已存在的 Jira key——本项目 Story/Task 创建时必须挂 Epic
- `assignee`（姓名/邮箱，提交时解析成 Jira 账号）与 `dueDate`——Sub-task 创建时这两项必填
- `priority` 完全由草稿决定（Sub-task 按规范不带优先级）
- Reporter 不支持（该 Jira 项目屏幕未开放此字段）
- **已知限制**：Bug 的 Severity / Source 等必填自定义字段暂不支持自动提交，AI 会写进 description 并在 notes 里提醒人工补填

## 架构速览

```
src/
├── clients/          Atlassian HTTP 层（fetch + Basic auth）: confluence(页面→md) / jira(createmeta/create/link/users)
├── llm/client.ts     Anthropic 结构化输出（messages.parse + zod + prompt cache）
├── core/             纯库层: config / schema / spec-cache / sync-spec / draft / submit / render
├── stores/           持久层: DraftStore(fs / S3, 每人一夹) + UserStore(users.json, 30s 缓存)
├── server/
│   ├── index.ts      bootstrap: store 选择(S3/fs)、种管理员、listen
│   ├── app.ts        Express 组装: 静态托管 web/dist + 中间件链 + 路由挂载
│   ├── session.ts    scrypt 密码哈希 + HMAC 签名无状态 cookie（7 天）
│   ├── middlewares/  attachAuth / requireAuth / requireAdmin / 登录限速 / 统一错误
│   ├── services/     drafts 编排 + enforcePolicy(权限规则唯一出处)
│   └── routes/       auth / drafts / meta / admin
├── cli/              commander 薄壳（个人本地模式）
web/                  React 18 + Vite + TS 前端（pages/ + components/，构建产物 web/dist）
```

关键设计：

- **无状态会话**：cookie 只装身份（email+exp 的 HMAC），级别/停用状态每个请求从用户表现读——容器重启/多实例天然兼容，停用 30 秒内生效
- **规范静态缓存**：draft 读 `.cache/`，system prompt 字节稳定（Anthropic prompt cache 跨请求命中省钱）
- **草稿即历史**：`drafts/*.json` 是唯一真相源，submit 写回 Jira key，重跑幂等
