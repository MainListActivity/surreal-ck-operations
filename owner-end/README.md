# 老板端（owner-end）

老板端由两部分组成：Cloudflare Worker 网关（`src/`）和老板页面（`src/ui/`，构建到 `public/`）。页面只负责展示和提交。权限判断、命令分流和译文投递规则都在 Worker 与仓库共享核心（`../src/`）里。

老板在这里能做的事：看每个员工正在做什么、接下来做什么、待发消息原文；编辑原文，选择译文语言，预览后保存；发布需求、加任务、改派、暂停或作废；管理笔记；管理员工策略和受保护命令；查看运维作业和审计，执行运维命令。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/worker.ts` | 入口。`/api/*` 进 Hono 路由，其余交给静态资源；`scheduled` 进定时任务 |
| `src/auth/` | 访问令牌验签（jose，RS256）和身份分流 |
| `src/commands.ts` | `POST /api/cmd` 的分流。老板、员工、系统身份各走各的路径 |
| `src/jobs.ts` | 执行端作业（`ops_job`）的排队、等待、结果与错误码 |
| `src/messages.ts`、`src/translate.ts` | 译文预览与保存、补译、笔记改写（OpenAI 兼容的译文服务） |
| `src/cron.ts` | 定时任务：员工身份同步、补译、笔记整理 |
| `src/idp/` | ma_hono 身份：机器令牌、用户与租户管理 |
| `src/ui/` | 老板页面（Preact，PKCE 登录，Bearer 令牌） |
| `public/` | 页面静态资源（`index.html`、`app.css`）。`app.js` 与 source map 由 `build:ui` 生成，已被忽略。`public/.assetsignore` 排除 `*.map`，部署时 source map 不上传 |
| `tests/` | 单测。`gateway-access.fork.test.ts` 是门控的公司 fork 测试 |
| `screenshots/` | 页面截图，见「截图」 |

## 配置

### 非机密变量（`wrangler.jsonc` 的 `vars`）

| 变量 | 说明 |
| --- | --- |
| `IDP_ISSUER`、`IDP_JWKS_URL` | ma_hono 公司租户的签发者和公钥地址（生产为 `https://o.maplayer.top/t/company`） |
| `CONSOLE_CLIENT_ID` | 老板页面的 PKCE 客户端 id（公开） |
| `IDP_TENANT_ID` | 公司租户 id，用于 ma_hono 管理接口路径。**当前为空**：为空时 `idp.*` 的租户与客户端命令返回 `not_configured` |
| `AGENT_EMAIL_DOMAIN` | 员工 agent 账号使用的邮箱域名 |
| `GATEWAY_CLIENT_ID`、`CRON_CLIENT_ID`、`VIEWER_CLIENT_ID` | 网关、定时任务、查看者的机器客户端 id（公开） |
| `COMPANY_DB_URL`、`COMPANY_NS`、`COMPANY_DB` | 公司 SurrealDB 的地址、命名空间和数据库（生产为 `wss://data.maplayer.top/rpc`、`company`、`main`） |

### 密钥（用 `wrangler secret put` 设置，不写进代码或 `wrangler.jsonc`）

| 名称 | 用途 | 缺失时 |
| --- | --- | --- |
| `GATEWAY_CLIENT_SECRET` | 网关机器令牌，员工命令与老板命令的数据库会话 | 对应会话返回 `not_configured` |
| `CRON_CLIENT_SECRET` | 定时任务机器令牌 | 定时任务的数据库会话不可用，各步骤只记日志 |
| `VIEWER_CLIENT_SECRET` | 查看者机器令牌，员工的 `db.read` | `db.read` 返回 `not_configured` |
| `IDP_ADMIN_TOKEN` | ma_hono 服务主体令牌（权限范围见「已知偏离」） | 身份同步跳过，`idp.*` 管理命令返回 `not_configured` |
| `CF_ACCOUNT_ID`、`CF_API_TOKEN` | `cf.api` 命令的账号 id 与令牌（都要设置） | `cf.api` 返回 `not_configured` |
| `MAGPIE_BASE_URL`、`MAGPIE_MODEL`、`MAGPIE_API_KEY` | 译文服务（三者都要设置）。`MAGPIE_BASE_URL` 是 OpenAI 兼容接口的基址，代码在其后追加 `/chat/completions`，所以基址要写到 API 版本路径（如 `/v1`）为止 | 译文与笔记改写不可用，定时补译跳过 |

## 本地开发

本地用 `wrangler dev --local` 运行 Worker，数据库用公司 fork 的本机 SurrealDB（不要用上游官方版本），不连生产库。

> `wrangler.jsonc` 的 `COMPANY_DB_URL` 指向生产库。本地运行前必须在 `.dev.vars` 里覆盖成本机地址，否则 `wrangler dev` 会连生产库。

`.dev.vars` 已被 `.gitignore` 忽略，只放本地值，不提交：

```ini
IDP_ISSUER=http://127.0.0.1:<端口>/t/company
IDP_JWKS_URL=http://127.0.0.1:<端口>/t/company/jwks.json
COMPANY_DB_URL=ws://127.0.0.1:<端口>/rpc
DEV_DB_ROOT_USER=root
DEV_DB_ROOT_PASS=<本地实例口令>
MAGPIE_BASE_URL=http://127.0.0.1:<端口>/v1
MAGPIE_MODEL=<任意模型名>
MAGPIE_API_KEY=<本地假值>
```

- `DEV_DB_ROOT_*` 让每个数据库会话都以 root 连接（见 `src/db.ts`）。所以 `readConfig` 只在 `COMPANY_DB_URL` 指向 `localhost` 或 `127.0.0.1` 时接受它。指向其它地址时配置直接失败（返回 503），不会悄悄放开权限。
- 本地需要两个替身服务，仓库里不包含：兼容的身份服务（OIDC 授权码加 PKCE，RS256 访问令牌），以及兼容的 `chat/completions` 译文服务。
- 本地数据库要先应用本仓库的 schema（到 058）。`tests/gateway-access.fork.test.ts` 演示了在隔离库上做引导的方式。

启动：

```sh
cd owner-end
bun run build                                  # 生成 public/app.js
./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8787
```

`bun run dev` 会先 build 再启动 `wrangler dev`。依赖用 pnpm 安装（`pnpm install`，锁文件是 `pnpm-lock.yaml`）。

## 测试与检查

在 `owner-end/` 下：

| 命令 | 内容 |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit`，严格模式，覆盖 `src/` 和 `tests/` |
| `bun run test` | `bun test tests`：网关、身份、页面的单测 |
| `bun run build:ui` | 把页面打包到 `public/app.js` |
| `RUN_SCK_OWNER_END_TESTS=1 bun test tests/gateway-access.fork.test.ts` | 在自建隔离库上验证 058 之后的访问规则 |
| `bun run deploy:dry-run` | build 后执行 `wrangler deploy --dry-run --outdir dist`，只打包，不上传 |

在仓库根目录下：

| 命令 | 内容 |
| --- | --- |
| `bun run typecheck` | 根目录的 `tsc`，覆盖 `src/` 和 `tests/`，不包含 owner-end |
| `bun scripts/worker-compat-check.ts` | 检查 Worker 入口和依赖是否只用了 Worker 支持的 API，要求零违规 |
| `RUN_SCK_CHANNEL_FORK_TESTS=1 bun test tests/outbound-translation.fork.test.ts tests/board-messages.fork.test.ts` | 派工对齐和译文投递在真实库上的测试 |
| `bun scripts/test-worktrees.ts --all` | 官方全量测试，自动设置各门控环境变量，包括 owner-end 的 fork 测试 |

门控测试只有设置了对应环境变量时才会执行，没有设置时显示为 skip。

## API 契约

所有接口在 `/api` 下，只认 `Authorization: Bearer <访问令牌>`，不用 cookie。

- 成功：`{"ok": true, "result": ...}`。
- 失败：`{"ok": false, "error": {"code": "...", "message": "...", "jobId": "..."}}`。`jobId` 只在执行端作业相关的错误中出现。
- 只有 `GET /api/config` 是裸 JSON。它在登录前读取，不包在 `ok` 里。

| 方法与路径 | 身份 | 说明 |
| --- | --- | --- |
| `GET /api/config` | 无需登录 | 登录参数：`issuer`、`clientId`、`authorizeUrl`、`tokenUrl`、`audience` |
| `GET /api/me` | 老板 | 当前老板的 `sub`、`roles`、`exp`。非老板返回 403 |
| `GET /api/board` | 老板 | 看板数据，与 `board.snapshot` 是同一份（`src/board.ts`） |
| `POST /api/cmd` | 老板；员工只能调用只读白名单 | 请求体 `{"command": "...", "input": {...}}`，`input` 缺省为 `{}`。请求带 `Origin` 时必须与请求同源；请求体上限 256 KB |
| 其它 `/api/*` | - | 404，`code: not_found` |

其余路径交给静态资源。未知路径回落到 `index.html`，`/auth/callback` 由页面自己处理（`run_worker_first` 只包含 `/api/*`）。

### 错误码

| `error.code` | HTTP | 含义 |
| --- | --- | --- |
| `unauthorized` | 401 | 没有令牌、令牌格式不对或验签失败（含 `login_failed`） |
| `forbidden` | 403 | 不是老板、员工无权调用、来源不同源、系统身份调用老板命令 |
| `invalid` | 400 | 请求不合法（含 `response_too_large`） |
| `not_found` | 404 | 接口或资源不存在 |
| `conflict` | 409 | `worktree_busy`、`already_claimed`、`lease_expired`、`self_review`、`checkpoint_limit`、`payment_approval_required`、`limit_reached`、`snapshot_gone`、`retire_refused`。其它未列出的业务错误也归为这里 |
| `pending` | 202 | 执行端作业超过 25 秒仍未完成。`error.message` 和 `error.jobId` 都是任务号，之后用 `ops.job.get` 取结果 |
| `upstream_error` | 502 | 数据库、身份服务或译文服务失败（含占位标记丢失）。未知的内部错误也归入这里，只返回“服务暂时出错，请稍后重试” |
| `unavailable` | 503 | `temporarily_unavailable`、`not_configured`、`unavailable` |

### 执行端作业

需要执行端宿主的命令（`RUNNER_ONLY_COMMANDS`，见 `src/owner-api.ts`）会排队到 `ops_job`。网关最多等 25 秒：完成则返回结果，失败则返回对应错误码，超时返回 `pending`。`ops.job.list` 和 `ops.job.get` 用来查询作业。

## 权限模型

身份由访问令牌决定（`src/auth/caller.ts`）：

- **老板**：`ac=owner` 且带 `Owner` 角色。可以调用全部老板命令。数据库会话用老板令牌登录，权限由数据库访问规则决定（`schema/055-access.surql`）。
- **员工**：`ac=agent`，令牌必须带任务绑定。员工的命令经过命令守卫（`src/command-guard.ts`），按固定顺序判定，第一条不通过即拒绝：
  1. 员工已停用；
  2. 命中写死的老板专属命令（`HARD_OWNER_ONLY`，如 `guard.*`、`agent.*`、`task.create`、`message.send`、`note.edit`）；
  3. 命中 `protected_command` 中标记为 `owner_only` 的命令；
  4. 不在员工的允许清单（`agent_policy.allow`）内，或命中禁止清单（`agent_policy.deny`）；
  5. 没有该任务的有效租约（持有人是本员工且未过期）。

  通过后，命令还必须在只读白名单内：`db.read`、`task.detail`、`note.list`、`note.preview`。员工的写入仍由执行端直连数据库，不经过网关。
- **系统身份**（`gateway`、`runner`、`automation`、`migrator`、`viewer`）：不能调用网关接口。运行器和定时任务调用老板命令会被拒绝，并写入审计。

### 审计

- 写操作、员工的全部调用（含被拒绝的），以及老板的非只读命令，都写入 `ops_audit`。审计只存参数摘要（`args_digest`）和一句摘要（`summary`，不超过 500 字符），不存原文。
- 只读命令不审计，否则看板的反复刷新会淹没真正的操作。只读判定是：`status`、`progress`、`brief`、`inbox`、`board.snapshot`、`db.read`、`translate.preview`、`idp.status`、`idp.user.list_agents`，以及以 `.list`、`.get`、`.detail`、`.preview`、`.plan`、`.consolidations`、`.records` 结尾的命令。
- 例外：`upgrade.list` 以 `.list` 结尾，因此也不审计。见「已知偏离」。

## 译文与投递

消息有一个“生效语言”，它决定员工收到原文还是译文（`effectiveLangOf`、`deliveryOf`，见 `src/outbound-messages.ts`）：

1. 老板为这条消息选过语言（包括选了“不翻译（原文投递）”）：以消息自己的语言为准。
2. 老板没有选过：跟着收件员工走，取员工策略的译文语言（`agent_policy.lang`）。消息上残留的旧语言不算。

有生效语言时，只有同时满足以下三条的译文才会投递。否则消息显示“等待译文”，不发原文：语言与生效语言相同；译文非空；译文记下的原文哈希与当前原文一致。原文一改，旧译文自动作废。

派工前，调度器会先把消息语言对齐到员工语言（`alignLanguage`）。复用已有员工和新建员工两条路径都会做。对齐时语言变了就清掉旧译文。译文还没就绪时，本轮不派工、不领租约、不新建员工。老板选过语言的消息不会被员工语言覆盖。

译文相关的规则：

- 译文服务失败不回滚原文。保存原文时如果已选语言，网关会立即补译；失败时返回 `translationPending`，由每分钟的定时任务补译。
- 选语言时先译好再保存。保存时以译过的那一版原文为守卫，期间原文被改则报冲突，请重新译。
- 派工时会替换的占位标记（`{taskId}`、`{acId}`、`sck call`、`task.md`、`notes.md`、`findings/round-NN.md`、`agents/eval.md`）如果在原文里出现，译文里也必须保留。否则返回 `upstream_error`，请重试。
- 原文和译文都不超过 20000 个字符。
- 语言代码须符合 `^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$`，如 `en`、`ja`。

## 定时任务

| 触发时间 | 做什么 |
| --- | --- |
| 每分钟（`* * * * *`） | 为在岗员工补开 agent 身份（ma_hono 用户，记入 `agent_identity`）。未配置 `IDP_ADMIN_TOKEN`、`IDP_TENANT_ID` 或 `AGENT_EMAIL_DOMAIN` 时跳过。同时为选了语言但译文缺失或过期的待发消息补译，每次最多 5 条 |
| 每天 19:30 UTC（`30 19 * * *`） | 到期的笔记整理。配置了译文服务时用它改写，改写失败则回退为原文 |

补译的顺序：从没失败过的消息先补，其余按上次失败时间从早到晚轮转（`translate_failed_at`）。这样一条反复失败的消息不会一直占着名额。

每一步独立执行，失败只记日志。定时任务用自动化客户端（`CRON_CLIENT_*`）访问数据库。

## 截图

`screenshots/` 下有四张图，均在本地种子数据上拍摄：本地 SurrealDB 内存实例、`wrangler dev`、身份和译文替身，没有连生产库。截图里的“执行端未知”是因为本地没有运行执行端宿主。

| 文件 | 视口 | 内容 |
| --- | --- | --- |
| `desktop-board.png` | 1440 宽，整页 | 首页看板：公司在动、员工卡片、排队与其它未发消息 |
| `desktop-message-translate.png` | 1440×900 | 消息编辑与译文预览：未保存草稿、英文预览。译文是替身输出 `[EN stub]` |
| `desktop-permissions.png` | 1440 宽，整页 | 员工与权限：员工策略、受保护命令、只能老板调用的命令 |
| `mobile-390-board.png` | 390 宽，整页 | 首页看板，移动端单列布局 |

截图用 ego-browser 自动化采集，采集脚本没有入库。

## 部署（本 PR 未执行）

1. 用 `wrangler secret put` 设置上文「密钥」中需要的值。
2. 建好租户后，在 `wrangler.jsonc` 中填入 `IDP_TENANT_ID`。
3. 执行 `bun run deploy:dry-run` 确认打包通过。静态资源上传 `app.css`、`app.js`、`index.html` 三个文件，`app.js.map` 按 `public/.assetsignore` 排除。
4. 老板批准后再执行 `wrangler deploy`。

## 已知偏离与遗留

1. **ma_hono 服务主体权限不足。** `IDP_ADMIN_TOKEN` 对应的服务主体只有 `tenant.read`、`user.read`、`user.provision`。创建租户（`POST /admin/tenants`）、客户端管理、租户的 PATCH、keys、DELETE 需要人工管理员会话，服务主体调用会返回 403。因此租户与客户端管理命令暂不可用，`IDP_TENANT_ID` 需要人工建租户后填入。
2. **`surrealdb` 解析自仓库根。** `owner-end/package.json` 没有声明 `surrealdb`，它来自根目录的 `node_modules`，版本见根目录 `package.json`。
3. **页面不用 cookie。** 页面用 PKCE 取得访问令牌，令牌只放在页面内存里，并同步到 `sessionStorage`（键 `sck.owner.session`），不用 localStorage。所有接口只认 `Authorization: Bearer`。
4. **派工译文门在看板侧未计入。** 调度器派工前会等待译文，但看板上的“可接”判断还没有计入这个条件。所以看板可能显示“可接”，而调度器暂不派工。这一项与 W3-RUNNER 的改动可能冲突，合并前需要核对。
5. **`upgrade.list` 不审计。** 它以 `.list` 结尾，按只读命令处理。测试已锁定这一行为。
6. **员工只读命令的审计标签。** 员工的只读命令经老板接口执行（`via=agent`），审计里的操作人标签是 `owner:agent`。是否改成员工自己的标签，待 review 确认。
7. **译文没有用真实服务验证。** 测试和截图用的是本地替身，译文形如 `[EN stub] 原文`。译文质量、延迟和费用需要接入真实译文服务后再验证。
8. **`wrangler.jsonc` 指向生产库。** 本地开发必须用 `.dev.vars` 覆盖，见「本地开发」。
9. **390px 下导航条横向滚动。** 这是设计如此，没有改。
