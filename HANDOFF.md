# 交接说明（ajt · AI 开票工具 2.0）

写给下一个接手开发的 agent。**先读这一份，再读 [README.md](README.md)**（README 讲怎么用、怎么部署；这份讲现在到哪了、接下来干什么、以及哪些坑已经踩过）。

最后更新：2026-08-05 · 交接时 `dev` 分支 HEAD = `964dd74`

---

## 1. 这个项目是什么

工程师用口语（中/英混）描述要做的事 → AI 按团队保存在 Confluence 上的开票规范，产出**符合规范的 Jira 票草稿** → 人在网页上核对/微调 → 一键提交到 Jira 项目 **AIP**（bituslabs.atlassian.net）。

2.0 的目标是**推广给全公司使用**，所以做了：登录 + 三级权限、每人独立的开票历史、提交防呆确认、草稿存 S3、以及推 main 自动部署的形态。

---

## 2. 现在能用的东西（已验证）

| 环境 | 地址 | 状态 |
|---|---|---|
| 这台 EC2 上的常驻服务 | `http://<EC2 公有IP>:9300` | **运行中**，S3 存储模式，团队在用 |
| AWS App Runner（目标形态） | 未建 | **待做，见第 6 节** |

- 测试：**78 个全绿**（`npm test`）；类型检查前后端双通过（`npm run typecheck`）
- 存储：已切到 S3，桶 `bituslabs-ai-jira-ticket`（us-west-2），凭证走 EC2 实例角色
- 真实用量：桶里有 13 条真实开票记录，多数已上板到 Jira

### 服务怎么起/停（当前是手工 nohup，不是 systemd）

```bash
cd /home/ubuntu/harley/projects/ai-jira-ticket
# 停：注意别把执行 kill 的那个 shell 自己杀了（见第 8 节）
pgrep -f "tsx src/serve[r]" | while read p; do kill $p; done
# 起（另起一次工具调用，不要和上面写在同一条命令里）
(nohup npx tsx src/server/index.ts >> ajt-web.log 2>&1 &)
tail -2 ajt-web.log     # 应看到 "存储 S3:bituslabs-ai-jira-ticket"
```

改了**前端**只需 `npm run build:web`（Express 每次请求从磁盘读 `web/dist`，不用重启）；改了**后端**才需要重启。

---

## 3. 架构与代码地图

后端 Express 5 分层（路由 → 服务 → 持久层），前端 React 18 + Vite + TS。

```
src/
├── clients/          Atlassian HTTP 层：confluence-client(页面→md) / jira-client(createmeta/create/link/users)
├── llm/client.ts     Anthropic 结构化输出（messages.parse + zod + prompt cache）
├── core/             纯库层，与 HTTP 无关：config / schema / spec-cache / sync-spec / draft / submit / render
├── stores/
│   ├── draft-store.ts   DraftStore 接口 + FsDraftStore + S3DraftStore
│   └── user-store.ts    UserStore（users.json 单文档 + 30s 缓存）+ ACCOUNT_ID_RE
├── server/
│   ├── index.ts      bootstrap：选存储后端、种管理员、listen、后台补缓存
│   ├── app.ts        中间件链 + 路由挂载 + 静态托管 web/dist
│   ├── session.ts    scrypt 密码哈希 + HMAC 签名无状态 cookie（7 天）
│   ├── middlewares/  attachAuth / requireAuth / requireAdmin / 登录限速 / 统一错误(HttpError)
│   ├── services/     drafts(表单默认值+合并保护) / policy(权限规则唯一出处) / refresh(参考数据刷新)
│   └── routes/       auth / drafts / meta / admin
└── cli/index.ts      个人本地模式（无登录、无 S3），保留不动

web/src/
├── App.tsx           会话门：问 /api/me，任何 401 弹回登录
├── api.ts            fetch 封装 + ApiError
├── constants.ts      配色 / 必填规则 / displayName / DEFAULT_TYPE / configFreshness
├── pages/            LoginPage · MainPage(开票/历史/管理 三 tab)
└── components/       ComposeForm · TicketCard · Editor · ConfirmDialog · HistoryView · AdminPanel · Seg · ChangePasswordDialog
```

### 几个必须知道的设计约定

- **权限规则只有一个出处**：`src/server/services/policy.ts` 的 `enforcePolicy(user, draft)`，在生成/保存/提交**三条路径**都调用。前端只做隐藏，服务端才是强制。改权限一定改这里，不要在路由里另写判断。
- **草稿 = 历史**：`drafts/{owner}/{id}.json` 是唯一真相源。提交成功把 `jiraKey`/`jiraUrl` 回写，状态就从"草稿"变"已提交"。删历史只删档案，**绝不动 Jira 上的票**。
- **记录 id 在创建时确定**：`store.write(owner, draft, id?)` —— 更新必须传原 id。不传会从"创建时间+首票标题"重新推导，改标题就会多出一条重影记录（这是已修的真 bug，`test/stores.test.ts` 和 `test/server.test.ts` 各有一个测试锚着，别拆）。
- **会话 cookie 只装身份**（email + 过期时间的 HMAC）；级别和 active 每个请求从用户表现读，所以**停用账号 30 秒内生效**。
- **提交是断点续传式的**：每建成一张票就落盘，中途失败重跑同一条命令会跳过已建的。

---

## 4. 权限模型

| 能力 | 普通 l1 | 高级 l2 | 管理员 admin |
|---|---|---|---|
| 开票类型 | 不允许 Epic | 全部 | 全部 |
| 指派 | 强制=本人 | 任意 | 任意 |
| 历史 | 仅自己 | 仅自己 | **全员**（带所有者列/筛选） |
| 他人记录 | — | — | 可查看、可删除；编辑/提交仍仅限自己的 |
| 用户管理 | — | — | 建号/定级/重置密码/停用 |

防呆：任何会导致"零个活跃管理员"的操作（降级/停用最后一个 admin）被 400 拒绝。

### 现有账号（存在 S3 的 `users.json`）

| 登录名 | 姓名 | 级别 | 说明 |
|---|---|---|---|
| `admin` | 系统管理员 | admin | **纯用户名登录**，不是邮箱。密码在 `.env` 的 `AJT_ADMIN_PASSWORD` |
| `harley.tang@bituslabs.com` | Harley Tang | l1 | 项目负责人本人，密码他自己改过 |
| `chelsea.yao@bituslabs.com` | — | l1 | 同事 |

> 账号标识允许**邮箱或纯用户名**，规则 `ACCOUNT_ID_RE`（必须字母数字开头，`..`/`.hidden` 被拒——它同时是 S3 目录名，要防路径穿越）。

---

## 5. 数据与配置

### S3 目录结构（桶 `bituslabs-ai-jira-ticket`，us-west-2）

```
users.json                      账号表：登录名/姓名/级别/active/scrypt{salt,hash}/jiraEmail?
drafts/{登录名}/{id}.json        开票记录（= 历史）；一人一夹
```

草稿 JSON：`meta`（创建时间、原始输入、项目、规范版本、模型）+ `tickets[]`（标题/正文md/类型/优先级/父级/指派/startDate/dueDate/jiraKey/jiraUrl）+ `links[]` + `notes`。

**按人分文件夹**是有意的：列某人历史 = 列一个前缀，admin 全员 = 列 `drafts/`；两人同时开票不互相覆盖。代价是列表时 N+1 次 GetObject，对"每人几十份小文档"完全够，比维护索引文件可靠。

### `.cache/`（不在 S3，可再生）

`spec.md`（Confluence 规范全文 + frontmatter 版本号）、`project-meta.json`、`issues.json`（看板快照）、`users.json`（Jira 全站名册）。**进程启动时若缺失会自动拉一次**（`ensureCaches`，约 40 秒，失败不致命）；界面上「更新config」按钮走 `refreshAll` 同时刷这四份。

### 环境变量（本地在 `.env`，已 gitignore）

现有键：`ATLASSIAN_BASE_URL` `ATLASSIAN_EMAIL` `ATLASSIAN_API_TOKEN` `ANTHROPIC_API_KEY` `SESSION_SECRET` `AJT_HOST` `AJT_S3_BUCKET` `AWS_REGION` `AJT_ADMIN_EMAIL` `AJT_ADMIN_NAME` `AJT_ADMIN_PASSWORD`

- `SESSION_SECRET` **必须稳定**，变了所有人被登出
- `AJT_ADMIN_*` 只在用户表为空时种入管理员；现在 users.json 有账号，所以它们不生效（留着是换桶时能自举）
- 去掉 `AJT_S3_BUCKET` 即退回本地 fs 模式（本地 `drafts/`、`data/users.json` 都还在，是迁移前的原件，没删）

---

## 6. 接下来要做的第一件事：把 App Runner 建起来

**当前卡点：项目负责人（Harley）说他暂时没有 AWS 权限建这些资源。** 代码侧全部就绪，等权限到位后照 **[docs/deploy-apprunner.md](docs/deploy-apprunner.md)** 执行即可——那份文档是逐步操作清单（3 个 Secrets Manager 密钥、IAM 实例角色策略 JSON、建服务的每一项选择、部署后 4 步验证、2 个常见坑）。

要点摘录（细节看文档）：

- 形态：**源码直连**（App Runner 直接连 GitHub 构建，不经 CodeBuild/ECR），配置在根目录 [`apprunner.yaml`](apprunner.yaml)
- 触发：Deployment trigger 选 **Automatic** → 推 main 即自动构建部署
- 三个密钥用**独立的 plaintext secret**，不要包成 JSON（App Runner 注入整个 secret 值）
- 实例角色要 **App Runner - Tasks** 类型，策略需含 S3 读写 + `s3:ListBucket` + `secretsmanager:GetSecretValue`
- **Auto scaling Max size 必须 = 1**（登录限速和用户缓存在进程内存里，多实例会让限速形同虚设、停用生效变慢）
- Health check 指到 **`/healthz`**（免认证，专为此留的）
- 若构建报 `nodejs22` 不是有效运行时，把 `apprunner.yaml` 的 `runtime:` 改成 `nodejs20`（这台机器就是 Node 20，代码跑得好）

⚠️ **有一个未提交的本地提交**：`dev` 领先 `origin/dev` 一个提交（`964dd74`，修了 apprunner.yaml 的 `runtime-version` 格式隐患 + 拆分密钥的文档）。**建服务前必须先推上去**，否则 App Runner 读到的是旧版配置：

```bash
git -c credential.helper= push origin dev
git checkout main && git merge dev --ff-only && git -c credential.helper= push origin main && git checkout dev
```

---

## 7. 其余待办（按优先级）

1. **收窄安全组**：9300 端口目前能从公网访问（`launch-wizard-15` 安全组，未核实规则），而 HTTP 是明文传密码。应把来源限制到公司出口 IP / VPN 网段。**这是当前最大的安全缺口。**
2. **App Runner 验证通过后停掉 EC2 的 :9300**。两者共用同一个 S3 桶（数据同一份），但代码版本可能不同；对外只留一个入口，免得同事拿到两个地址。
3. **域名 + HTTPS**：App Runner 自带 `*.awsapprunner.com` 的 HTTPS，够用；要 `ajt.bituslabs.com` 就在 Custom domains 加 CNAME（证书自动）。域名归属还没问下来。
4. **`drafts/` 根目录下 27 条 6 月的散装草稿**没迁到 S3：它们是单用户时期的产物、不属于任何人，**当前界面本来就看不到**，迁过去会凭空多出记录。要归到 Harley 名下需他确认。
5. **上多实例前**需外置两处内存状态：登录失败限速（`middlewares/rate-limit.ts`）、用户表 30s 缓存（`stores/user-store.ts`）。
6. **可选**：强制首次登录改密（现在管理员给的初始密码可以一直用）；用户记录加 `mustChangePassword` 即可。

---

## 8. 已经踩过的坑（别重踩）

**这是共用开发服务器**，上面还有别人的东西：

- **绝不改全局 git config**（曾被明确纠正）。只用仓库级配置。
- `git push` 会 403：全局 credential helper 存着另一位同事的 token。用 `git -c credential.helper= push`（会提示一次输入，不存储）。**不要删除 `/tmp/git-creds-*`**，那是同事的。
- `pkill -f`/`pgrep -f` 的模式如果和当前 shell 的命令串互相匹配，会**把自己杀掉**（exit 144）。用括号技巧 `"tsx src/serve[r]"`，并且**把 kill 和随后的启动命令拆成两次工具调用**——写在同一条命令里，启动命令的字符串本身会被模式匹配到。

工程上的：

- **IDE 诊断经常是过期的**，尤其连续快速编辑后。判断类型错误一律跑 `npx tsc --noEmit`（前端另加 `-p web`）。
- **Jira 的 `reporter` 字段这个项目提不了**（创建和事后编辑都报 "cannot be set... not on the appropriate screen"），已全链路移除，别再加回来。
- **Bug 类型的 Severity / Source / Detected Environment / Affects Version** 是创建必填的自定义字段，目前不支持自动提交；AI 会写进正文并在 notes 提醒人工补。
- **「开始日期」是自定义字段** `customfield_10015`（不是标准字段），ID 放在 `config.json` 的 `startDateField`，置空即不发送。
- **首启缓存拉取必须在 `listen` 之后**（`src/server/index.ts` 里 `void ensureCaches(config)` 放在 listen 回调内）。放前面会让容器平台等不到 `/healthz` 而判部署失败——这个坑修过一次。

---

## 9. 项目负责人的协作偏好（重要）

Harley Tang（harley.tang@bituslabs.com），中文沟通。他明确要求过：

1. **先说清要改什么、拿到同意再动手**。曾因未经同意直接改代码被制止（"你好像没经过我的同意就开始改了"）。方案性改动先给结论 + 影响面。
2. **他自己提交，不要代他 git commit/push**。做完一段给他**完整的 commit 命令**（含 message），他自己跑。
3. **分阶段推进**，每个阶段结束"测试全绿 + 交提交命令"，等他说"继续"再进下一阶段。
4. 追求**代码简洁高效**，明确说过"不要一直往上打补丁，该优化优化"，也授权过必要时重构。
5. UI 上他会反复微调（配色、宽度、文案位置），照做即可；但**验收基线是等价迁移**，不要自己做视觉重设计。

---

## 10. 本地开发速查

```bash
npm install
npm run build:web              # 构建前端 → web/dist
npm run web                    # 起服务（读 .env）
npm run dev:web                # 前端热更新开发，代理 /api → :9300

npm test                       # vitest：78 个（含 supertest 路由级权限矩阵）
npm run typecheck              # 前后端双 tsc

npm run ajt -- sync-spec       # 同步 Confluence 规范
npm run fetch-issues           # 看板快照
npm run fetch-users            # Jira 全站名册
```

CLI 版（个人本地模式，无登录/无 S3）：`npm run ajt -- draft "口语描述"` → `npm run ajt -- submit drafts/xxx.json`（支持 `--dry-run` / `--yes`）。
