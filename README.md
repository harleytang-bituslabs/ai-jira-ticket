# ai-jira-ticket (ajt)

AI 开票助手：输入口语化的中/英文描述，按团队保存在 Confluence 上的开票规范，生成结构化 Jira 票据草稿，人工确认后提交到 Jira kanban board。

多用户 Web 服务：邮箱+密码登录、两级职级+管理员、全员历史（admin）、提交确认防呆、草稿存 S3（每人一个文件夹）。核心逻辑在 `src/core/`，与 HTTP 层解耦；CLI 是不需要登录的个人本地模式。

开发命令、架构约束、在本仓库改代码的规则见 **[CLAUDE.md](CLAUDE.md)**。

## 权限模型

| 能力 | 普通 (l1) | 高级 (l2) | 管理员 (admin) |
|---|---|---|---|
| 可见 board | 管理员授权的 | 管理员授权的 | **全部**（恒定，不看 boards 字段） |
| 开票类型 | 不允许 Epic | 全部 | 全部 |
| 指派 | 强制=本人 | **仅本团队**（team 相同的活跃账号；没设团队=仅本人） | 任意（该 board 的参与者名册） |
| 历史 | 仅自己 | 仅自己（含指派筛选） | **全员**（所有者列/筛选） |
| 他人记录 | — | — | 可查看、可删除（编辑/提交仍仅限自己的草稿） |
| 用户管理 | — | — | 建号 / 定级 / 授权 board / 定团队 / 重置密码 / 停用 |

权限由服务端强制（`enforcePolicy` 在生成/保存/提交三条路径统一执行），前端只做隐藏。任何会导致"零个活跃管理员"的操作（降级/停用最后一个 admin）被拒绝。

**账号标识**可以是邮箱或纯用户名（规则 `ACCOUNT_ID_RE`，它同时是 S3 目录名，所以拒绝路径穿越形态）。用邮箱登录时，登录邮箱就是 Jira 身份。

**board 可见性**：账号上的 `boards` 列表是唯一依据，**新账号默认为空 = 开不了票**，须由管理员在管理页勾选开通。账号的 `team` 字段决定 **l2 的派活范围**：只能指派给同团队的活跃账号（没设团队就只能派自己）。团队只存在于 ajt 账号上，所以 l2 派不了没建号的同事——要么给对方建号定团队，要么由 admin 来派。

**指派名册**取自该项目**历史票的 assignee 与 reporter**（即真正在这个 board 上干过活的人）。不用 Jira 的 `assignable/search`：本站的权限方案把「可指派」开给了全公司，实测 26 个项目各返回同一批 63 人，分不出项目；参与者则差异明显（AIP 22 人 · BOP 13 人 · FL 11 人，BOP 与 FL 只交集 1 人）。

两个代价是刻意接受的：**从没被派过票的新人不在名册里**（所以指派框允许直接手输邮箱，且 `/api/meta` 总会把当前登录者并进名册），**离职/转岗的人会一直留着**（历史票不会消失）。服务端**刻意不**校验 assignee 是否在名册内——名册是缓存，卡在这里会误伤新人；真正的强制点在 Jira 建票时。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ATLASSIAN_BASE_URL` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` | ✅ | Atlassian 站点与 API 凭证（Confluence + Jira 共用；兼容 `CONFLUENCE_*` 变量名） |
| `ANTHROPIC_API_KEY` | ✅ | AI 起草用 |
| `SESSION_SECRET` | 生产✅ | 会话 token 的 HMAC 密钥（≥32 随机字符）。不设则每次重启随机生成，所有人被登出 |
| `AJT_ADMIN_EMAIL` / `AJT_ADMIN_PASSWORD` | 首启✅ | 用户表为空时种入第一个管理员，之后无作用（`AJT_ADMIN_NAME` 可选，默认取邮箱前缀） |
| `AJT_S3_BUCKET` | | 设了走 S3 存储（见下方「数据与存储」）；不设用本地 fs（开发模式） |
| `AWS_REGION` | S3✅ | S3 桶所在区域。凭证走标准 AWS 凭证链（实例角色 / env） |
| `AJT_HOST` / `AJT_PORT` | | 默认 `127.0.0.1:9300`；对外部署设 `AJT_HOST=0.0.0.0` |
| `AJT_MODEL` | | 覆盖起草模型（默认值是 `src/core/config.ts` 的 `DEFAULT_MODEL`） |
| `AJT_CONFIG` | | 指向另一份 config.json（默认 `./config.json`） |

本地凭据放 `.env`（已 gitignore），模板见 [`.env.example`](.env.example)。`dotenv` 不覆盖已存在的环境变量，所以 systemd unit / 容器里设的值优先于 `.env`。

`config.json`（入库共享，无密钥）：`projectKey` / `specPageUrls`（Confluence 规范页，可多篇）/ `defaultPriority` / `staticFields`（必填自定义字段逃生门）/ `startDateField`（「开始日期」自定义字段 ID，置空即不发送）/ `language`（zh / en / auto）/ `teamMembers`（指派名册的兜底静态名单，参与者缓存为空时才用）。

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
- **管理**（admin）：添加用户（登录名、初始密码线下告知、级别、团队、可见 board）、改级别、改团队、增删可见 board、停用（会话 30 秒内失效）、重置密码。填完邮箱会**按 Jira 参与记录自动预勾可见 board**，也可手动改；已有账号有「识别 board」按钮做同样的事。
- **更新config** 按钮：一键重拉 Confluence 规范 + Jira 项目元数据 + 看板快照 + 参与者名册 + Jira 项目清单（管理页显示 board 名称用），结果写进全员共享的缓存。**新环境首次登录后先点一次**。

## 数据与存储

| 数据 | S3 模式（`AJT_S3_BUCKET`） | fs 模式（本地开发） |
|---|---|---|
| 开票记录（= 历史） | `drafts/{账号}/{id}.json` | `drafts/{账号}/{id}.json` |
| 用户表 | `users.json` | `data/users.json` |
| 参考数据（规范 / 项目元数据 / 看板快照 / 参与者名册 / 项目清单） | `cache/` 前缀：`spec.md` `project-meta.json` `issues.json` `users.json` `projects.json` | `.cache/` |

- **草稿 JSON**：`meta`（创建时间、原始输入、项目、规范版本、模型）+ `tickets[]`（标题/正文md/类型/优先级/父级/指派/startDate/dueDate/jiraKey/jiraUrl）+ `links[]` + `notes`。提交成功回写 `jiraKey`/`jiraUrl`，记录即从"草稿"变"已提交"。
- **按人分文件夹**：列某人历史 = 列一个前缀，admin 全员 = 列 `drafts/`；两人同时开票不互相覆盖。代价是列表时 N+1 次 GetObject，对"每人几十份小文档"够用，比维护索引文件可靠。
- **参考数据全员共用一份**、不按人隔离：服务启动即可用上一次「更新config」的结果。存储里没有时启动后自动在后台拉一次（约 40 秒，失败不致命，管理员点「更新config」重试）。S3 读取有 60 秒进程内缓存。
- `npm run ajt -- sync-spec` / `fetch-issues` / `fetch-users` 和 CLI 只读写本地 `.cache/`。S3 模式下的 Web 服务读的是桶里的 `cache/`，要刷新它用界面上的「更新config」。

## 部署

**分支**：只有 `main`。

**运行形态**：服务跑在一台 EC2 上，是用户级 systemd unit `ajt`（[`deploy/ajt.service`](deploy/ajt.service)，安装位置 `~/.config/systemd/user/ajt.service`）。它用 `tsx` 直接跑这个仓库目录里的 TypeScript 源码，绑定 `0.0.0.0:9300`，`Restart=always`，日志进 journald，存储走 S3（桶 `bituslabs-ai-jira-ticket`，us-west-2）。该用户开了 linger，所以开机自启、登出不停。

**发版**：在服务器上把仓库目录更新到要上线的 `main`，然后

```bash
npm run deploy               # = scripts/deploy.sh
```

脚本依次做：依赖（`package-lock.json` 比 `node_modules` 新才 `npm ci`）→ typecheck → 测试 → `build:web` → `systemctl --user restart ajt` → 轮询 `/healthz`。所有检查都在重启之前跑完，检查不过不会停掉在跑的服务。脚本**不碰 git**：上线的就是目录里当前检出的代码；也**没有回滚**，回滚就是检出旧提交再部署一次。`--skip-checks` 跳过 typecheck 和测试（应急用），`--install` 强制 `npm ci`。

- 只改了前端：`npm run build:web` 即生效（Express 每次请求从磁盘读 `web/dist`），不用重启
- 状态 / 日志：`systemctl --user status ajt` · `journalctl --user -u ajt -f`
- 重启或停止只用 `systemctl --user restart|stop ajt`；直接 kill 进程会在 3 秒后被 systemd 拉起
- 首次安装 unit：`cp deploy/ajt.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now ajt`（需要 `loginctl enable-linger` 才能开机自启）。没装 unit 时 `deploy.sh` 自己用 nohup 起进程，必须用 `--host` 指定绑定地址

生产要点：

- **S3 模式必开**，`SESSION_SECRET` 必须稳定（变了所有人被登出）
- **单实例**：登录失败限速与用户表 30 秒缓存都在进程内存里，多实例前需外置
- **明文 HTTP 对公网开放**：见下方「已知限制与待办」

### 备选部署：App Runner / Docker / CodeBuild

三套配置都已入库，但对应的 AWS 资源都没有建，不参与发版。

- **AWS App Runner**（源码直连，推 `main` 自动构建、滚动部署、自带 HTTPS）：配置在 [`apprunner.yaml`](apprunner.yaml)，控制台操作清单、IAM 策略、密钥放置见 **[docs/deploy-apprunner.md](docs/deploy-apprunner.md)**。
- **Docker**：多阶段构建，stage1 装全部依赖并 `vite build`，stage2 只带生产依赖 + `tsx` 直跑 TS 源码，非 root 运行，自带 `/healthz` 健康检查。

  ```bash
  docker build -t ajt .
  docker run --rm -p 9300:9300 --env-file .env \
    -e SESSION_SECRET=<random> -e AJT_S3_BUCKET=<bucket> \
    -e AJT_ADMIN_EMAIL=you@company.com -e AJT_ADMIN_PASSWORD=<initial> ajt
  ```

- **CodeBuild → ECR → ECS**：根目录 `buildspec.yml`，typecheck + 测试 → `docker build` → 推 ECR（`$ECR_REPO` 指定仓库，commit 短 hash + latest 双标签）→ 产出 `imagedefinitions.json` 供 ECS 流水线。环境需勾选 Privileged。适合需要多实例、精细网络控制（ECS Fargate + ALB）时。

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
- Bug 的 Severity / Source / Detected Environment / Affects Version 是创建必填的自定义字段，不支持自动提交：AI 会写进 description 并在 notes 里提醒人工补填

## 已知限制与待办

1. **明文 HTTP 对公网开放**：服务绑 `0.0.0.0:9300`，EC2 安全组对 `0.0.0.0/0` 放行全部端口，登录密码明文传输。这台机器上还有别人的服务，安全组收不窄；要 HTTPS 就得迁到 App Runner 或在前面加反向代理。
2. **单项目**：`config.json` 只有一个 `projectKey`。账号的 `boards`、`enforcePolicy` 和提交（按 `draft.meta.projectKey` 建票）已经按 board 工作，但规范同步、项目元数据、看板快照、名册和起草都只针对这一个项目。扩成多 board 需要：`config.json` 改成 `boards: [{ key, name }]`；参考数据按 board 分目录（`spec.md` 仍是全局一份）；页面顶部全局 board 切换器（只有一个可见 board 时隐藏）；`/api/meta?board=KEY` 并返回用户可见的 board 列表；历史按 board 隔离；`refreshAll` 遍历所有 board；CLI 加 `--board <KEY>`。
3. **单实例**：上多实例前需外置登录失败限速（`src/server/middlewares/rate-limit.ts`）和用户表缓存（`src/stores/user-store.ts`）。
4. **初始密码不强制修改**：管理员给的初始密码可以一直用。要强制，就在用户记录上加 `mustChangePassword`，登录后拦到改密页。

## 架构速览

```
src/
├── clients/          Atlassian HTTP 层（fetch + Basic auth）: confluence(页面→md) / jira(createmeta/create/link/users/projects)
├── llm/client.ts     Anthropic 结构化输出（messages.parse + zod + prompt cache）
├── core/             纯库层: config / schema / spec-cache / sync-spec / draft / submit / render
├── stores/           持久层: DraftStore(fs / S3, 每人一夹) + UserStore(users.json, 30s 缓存)
│                     + CacheStore(fs / S3 的 cache/ 前缀, 全员共享, 60s 读缓存)
├── server/
│   ├── index.ts      bootstrap: 选存储后端、种管理员、listen、listen 之后后台补缓存
│   ├── app.ts        Express 5 组装: 静态托管 web/dist + 中间件链 + 路由挂载
│   ├── session.ts    scrypt 密码哈希 + HMAC 签名的无状态会话 token（7 天）
│   ├── middlewares/  attachAuth / requireAuth / requireAdmin / 登录限速 / 统一错误 / 请求日志
│   ├── services/     drafts 编排 / policy(权限规则唯一出处) / refresh(参考数据刷新)
│   └── routes/       auth / drafts / meta / admin
├── cli/              commander 薄壳（个人本地模式）
scripts/              fetch-issues / fetch-users / deploy.sh
deploy/ajt.service    systemd 用户 unit
web/                  React 19 + Vite + TS 前端（pages/ + components/，构建产物 web/dist）
```

关键设计：

- **无状态会话**：登录发 HMAC 签名的 token（email+exp），存各标签页的 sessionStorage、走 Authorization 头——**一台电脑可同时登多个账号**（每个标签页一个）。刻意不用 cookie（cookie 全浏览器共享，最后登录的账号会接管其他标签页）。级别/停用状态每个请求从用户表现读，停用 30 秒内生效；容器重启/多实例天然兼容。代价：新标签页/重开浏览器需重新登录，token 对页面脚本可读（内部工具可接受）
- **规范静态缓存**：draft 从 `CacheStore` 读规范，system prompt 字节稳定（Anthropic prompt cache 跨请求命中省钱）
- **草稿即历史**：草稿 JSON 是唯一真相源，submit 写回 Jira key，重跑幂等
