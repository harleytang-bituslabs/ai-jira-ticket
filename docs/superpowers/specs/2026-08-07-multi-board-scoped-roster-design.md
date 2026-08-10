# 多 board 支持与名册收窄 — 设计

日期：2026-08-07 · 状态：第一刀已批准实现，第二刀记录终态

## 问题

公司有多个 Confluence space，每个 space 有自己的 Jira board；目前只接了 AIP 一个。两个具体缺陷：

1. **指派名册是全站的**。[src/clients/jira-client.ts](../../../src/clients/jira-client.ts) 的 `listUsers()` 打的是 `/rest/api/3/users/search`，返回站点全部活跃用户，与 board 无关，所以某个 board 的开票界面上会列出大量与该 board 无关的人。
2. **l2 与 admin 在派活上没有区别**。[src/server/services/policy.ts](../../../src/server/services/policy.ts) 里 l2 无任何内容限制，admin 的额外能力只体现在历史与用户管理，指派范围两者相同。

账号模型里也没有地方记录一个人属于哪个团队、能看哪些 board。

## 已确定的决策

| 议题 | 决定 | 理由 |
|---|---|---|
| 开票规范组织 | **全公司一套统一规范** | `spec.md` 保持单份，prompt cache 与 system prompt 完全不受影响 |
| board 名册来源 | **Jira `/rest/api/3/user/assignable/search?project=KEY`** | Jira 本身就知道谁能被指派到该项目，权威、零维护、人员变动自动跟随 |
| 「所属团队」语义 | ~~纯展示标签~~ → **2026-08-10 修订：l2 的派活范围 = 本团队** | 起初纯展示；后按 Harley 要求升级为权限依据（policy.ts `teamRoster`） |
| 多 board 切换形态 | **页面顶部全局切换器** | 开票与历史同时受控；只有一个可见 board 时自动隐藏，现有用户无感 |
| board 清单维护 | **`config.json` 的 `boards` 数组** | 与现有 config 分层一致（入库、无密钥、有 git 记录）；board 极少变动 |
| 老账号默认可见范围 | **空 = 什么都看不到** | 符合「不显示闲杂人等」的初衷；当前是开发版，运营摩擦可接受 |
| 交付节奏 | **分两刀** | 第一刀不依赖多 board 即可解决当前痛点，第二刀是纯容量扩展 |

## 既有代码中的有利条件

- `DraftFile.meta.projectKey` **已经存在**（[src/core/schema.ts:139](../../../src/core/schema.ts#L139)），且 [src/core/submit.ts:160](../../../src/core/submit.ts#L160) 建票时读的是 `draft.meta.projectKey` 而非 `config.projectKey` —— **提交链路本来就是按草稿走的，无需改动**。
- `enforcePolicy` 已在生成/保存/提交三条路径统一调用（[drafts.routes.ts](../../../src/server/routes/drafts.routes.ts) 三处），board 可见性规则加在这一处即全线生效。

写死单项目的位置只有：config schema、`sync-spec`、`refresh`、`/api/meta`、以及四份 `.cache/` 文件。

---

## 第一刀（本次实现）

### 1. 数据模型

`UserRecord`（[src/stores/user-store.ts](../../../src/stores/user-store.ts)）新增两个字段：

```ts
/** 可见 board 的 projectKey 列表。空 = 不能开票。admin 不受此字段约束。 */
boards: z.array(z.string()).default([]),
/** 纯展示标签(管理页、历史列表分组),不参与任何权限判断。 */
team: z.string().optional(),
```

`.default([])` 让现有 `users.json` 记录零迁移解析通过，落点正好是「默认看不到」。

`config.json` 第一刀不动，仍是单 `projectKey`。

### 2. 名册收窄

`jira-client` 新增 `listAssignableUsers(projectKey)`，走 `/rest/api/3/user/assignable/search?project=KEY&startAt=&maxResults=200`，分页与过滤（`accountType === "atlassian"` 且 `active`）沿用现有 `listUsers` 的写法。

- [src/server/services/refresh.ts](../../../src/server/services/refresh.ts) 与 [scripts/fetch-users.ts](../../../scripts/fetch-users.ts) 一并切过去，不保留两套。
- `UsersCache` 增加 `projectKey` 字段变成自描述的，为第二刀分目录预留。
- **前端零改动**：`/api/meta` 的 `roster` 形状不变，只是来源变窄。

### 3. 权限

`enforcePolicy` 新增一条，仍是权限规则的唯一出处：

```ts
if (user.level !== "admin" && !user.boards.includes(draft.meta.projectKey))
  throw new HttpError(403, `你没有 ${draft.meta.projectKey} 的开票权限`);
```

**刻意不做**：不在服务端校验 assignee 是否落在名册内。名册是缓存，新同事入职到下次「更新config」之间存在窗口期，卡在这里会误伤；而 Jira 在 `createIssue` 时本就会拒绝不可指派的 accountId —— 真正的强制点在那里，再加一层只会制造假阴性。名册收窄在 UI 层，越权提交由 Jira 层挡。

由此 l2 与 admin 的区别落定为：**l2 只能在自己可见的 board 内派活，admin 跨所有 board**。

### 4. 接口

| 位置 | 改动 |
|---|---|
| `publicUser`（[auth.routes.ts:10](../../../src/server/routes/auth.routes.ts#L10)） | 增加 `boards`、`team` |
| `adminView`（[admin.routes.ts:13](../../../src/server/routes/admin.routes.ts#L13)） | 同上 |
| `POST` / `PATCH /api/admin/users` | 接受 `boards: string[]` 与 `team: string`；board key 逐个校验（第一刀：必须等于 `config.projectKey`），非法值 400 |

### 5. 前端

仅管理页改动：[AdminPanel.tsx](../../../web/src/components/AdminPanel.tsx) 的建号表单与用户行各增加「可见 board」（第一刀即一个 AIP 复选框）与「团队」文本框；[web/src/types.ts](../../../web/src/types.ts) 的 `User` 补两个字段。开票页与历史页不动。

### 6. 测试

新增覆盖：

- policy 的 board 命中 / 未命中 × l1 / l2 / admin
- admin 路由能写入 `boards` / `team`，非法 board key 返回 400
- `listAssignableUsers` 的分页与过滤
- 缺失 `boards` 字段的旧 `users.json` 记录解析为 `boards: []`

现有 78 个测试全部保持绿色。

---

## 第二刀（本次不做，记录终态以保证第一刀不挡路）

- `config.json`：`projectKey` → `boards: [{ key, name }]` 数组
- `.cache/` → `.cache/boards/<KEY>/{project-meta,issues,roster}.json`，`spec.md` 保持全局单份
- 页面顶部全局 board 切换器；只有一个可见 board 时隐藏
- `/api/meta?board=KEY`；额外返回该用户可见的 board 列表以驱动切换器
- 历史列表按 board 隔离
- `refreshAll` 遍历所有已配置 board
- CLI 增加 `--board <KEY>`，默认取 `boards[0].key`

第一刀的 `boards: string[]`、自描述的 roster 缓存、以及按 `draft.meta.projectKey` 判断的 policy 规则，都是照着这个终态设计的；第二刀只做加法。
