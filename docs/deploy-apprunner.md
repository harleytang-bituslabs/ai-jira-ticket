# 部署到 AWS App Runner（推 main → 自动上线）

目标形态：GitHub `main` 有新提交 → App Runner 自动构建 → 滚动部署（零停机）→ 用户打开 HTTPS 网址登录即用。

仓库里已备好 [`apprunner.yaml`](../apprunner.yaml)（构建与运行配置）。下面是**你需要在控制台做的事**，按顺序来。

## 前置：状态与密钥的位置

| 数据 | 存哪 | 说明 |
|---|---|---|
| 草稿 / 开票历史 | S3 `bituslabs-ai-jira-ticket/drafts/{登录名}/` | 容器磁盘易失，必须放 S3 |
| 用户表（账号/密码哈希/级别） | S3 `bituslabs-ai-jira-ticket/users.json` | 同上 |
| 规范·看板·名册缓存 | 容器磁盘 `.cache/` | 首启自动拉取（约 40 秒），重启即重拉，无需人工干预 |
| API 密钥 / 会话密钥 | Secrets Manager | 绝不写进仓库或镜像 |

## 步骤 1：把三个密钥放进 Secrets Manager

区域用 **us-west-2**（和 S3 桶同区）。建 **3 个独立的 secret**，类型选 "Other type of secret" → **Plaintext**（整个值就是那一串，不要包成 JSON——App Runner 注入的是 secret 的完整值，JSON 会被原样塞进环境变量）：

| Secret 名 | 值 |
|---|---|
| `ajt/atlassian-api-token` | Atlassian API token |
| `ajt/anthropic-api-key` | Anthropic API key |
| `ajt/session-secret` | `openssl rand -hex 32` 的输出 |

> `SESSION_SECRET` **必须跨部署稳定**：它变了所有人被登出。放这里就是为了让它固定——绝不要依赖进程随机生成。

其余变量不是密钥，在服务配置里以**明文环境变量**填写即可（见步骤 2）：

| 变量 | 值 |
|---|---|
| `ATLASSIAN_BASE_URL` | `https://bituslabs.atlassian.net` |
| `ATLASSIAN_EMAIL` | 与上面 token 配对的账号邮箱 |

`AJT_ADMIN_EMAIL` / `AJT_ADMIN_PASSWORD` **不必配**：它们只在用户表为空时种入管理员，而 S3 上的 `users.json` 已经有账号了。将来换新桶需要自举时再加。

## 步骤 2：建 App Runner 服务

控制台 → App Runner → **Create service**：

1. **Source**：Source code repository → **Add new** → 授权 GitHub（这一步是 OAuth，必须你本人在控制台点）→ 选仓库 `harleytang-bituslabs/ai-jira-ticket`，分支 **main**
2. **Deployment trigger**：选 **Automatic** ← 这就是"推 main 自动部署"
3. **Build settings**：选 **Use a configuration file**（读仓库里的 `apprunner.yaml`，不用手填命令）
4. **Service settings**
   - Virtual CPU / Memory：**1 vCPU / 2 GB**（起草时要等 LLM 响应，2 GB 稳妥）
   - Port：**9300**（`apprunner.yaml` 里已声明，确认一致）
   - **Environment variables**：加 2 个明文（`ATLASSIAN_BASE_URL`、`ATLASSIAN_EMAIL`）
   - **Environment secrets**：加 3 个引用，Name 用变量名、Value 填 secret 的 ARN：
     `ATLASSIAN_API_TOKEN` / `ANTHROPIC_API_KEY` / `SESSION_SECRET`
     （`AJT_*` 那几个已在 `apprunner.yaml` 里，**不要重复填，同名会冲突**）
   - **Auto scaling**：新建一个配置，**Max size = 1**
     > 为什么必须是 1：登录失败限速和用户表缓存都在内存里。多实例会让限速形同虚设、停用账号的生效延迟变长。要上多实例得先把这两处外置（Redis/DynamoDB）。
   - **Health check**：Path `/healthz`（免认证，专为此设计）
5. **Instance role**：新建一个角色，附上步骤 3 的策略

## 步骤 3：实例角色的 S3 权限

App Runner 的 **instance role**（不是 access role）需要这份最小权限策略：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DraftsAndUsers",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::bituslabs-ai-jira-ticket/*"
    },
    {
      "Sid": "ListForHistory",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::bituslabs-ai-jira-ticket"
    },
    {
      "Sid": "ReadSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-west-2:*:secret:ajt/*"
    }
  ]
}
```

`ListBucket` 是必须的——按人列历史和管理员的全员视图都靠它。`GetSecretValue` 也必须显式给：少了它服务会在启动时因读不到密钥而反复失败。

## 步骤 4：首次部署后的检查

1. 打开 App Runner 给的网址 `https://xxxx.awsapprunner.com` → 应该看到登录页
2. 用 `admin` / 你设的密码登录 → 「管理」tab 能看到三个账号（说明 S3 用户表读到了）
3. 「历史」tab → 应看到 12 条既有记录（说明 S3 草稿读到了）
4. 首启后约 40 秒内 `/api/meta` 可能报错（缓存在后台拉取），稍等刷新即好；日志里会打印 `✓ 缓存已就绪`

## 步骤 5（可选）：绑自定义域名

App Runner → 服务 → **Custom domains** → 添加 `ajt.bituslabs.com` → 控制台给出几条 CNAME → 在 DNS 上加好 → 证书自动签发续期。原来的 `*.awsapprunner.com` 网址继续可用。

## 上线后的日常

- **发版**：合并到 `main` 就完事。App Runner 自动构建部署，失败会自动保留旧版本。
- **回滚**：`git revert` 后推 main（App Runner 没有一键回滚按钮，回滚就是再发一版）。
- **加人**：管理员在「管理」tab 建号，不需要动部署。
- **改规范/看板变动**：界面点「更新config」即可（写的是容器内缓存，重启会重拉，不影响正确性）。

## 成本预估

1 vCPU / 2 GB、Max size 1：内存约 $13/月常驻，vCPU 只在处理请求时计费（内部工具用量下通常几美元），构建按分钟计费但很便宜。**合计约 $15-20/月**。想更省可以降到 0.5 vCPU / 1 GB（约 $7/月），代价是 AI 起草时响应稍慢。

## 与 Dockerfile / buildspec.yml 的关系

仓库里那两个文件是**给 ECS/ECR 路线备的**，App Runner 源码模式不用它们。日后要迁到 ECS Fargate + ALB（多实例、更强网络控制），它们能直接用，不用重写。
