# 公司运行手册 v3

## 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| 任务服务 | 本机 launchd `org.surrealck.company-mcp`（`127.0.0.1:38473`），兼跑 GitHub 投影；129 上的远端入口 `data.maplayer.top/sck-mcp` 已停用 | 任务、租约、审计、目标、关口；admin/owner 通道 |
| 调度器 | Paseo 插件内（`plugin/server/dispatch.ts` tick 循环） | 不消耗模型 token：读队列、叫醒/新开员工、收回并改派、订阅健康、老板通知 |
| 员工通道 | Paseo 插件内 `plugin/server/sidecar.ts`（每实例一个） | 代持实例凭证、代领任务、自动续租、relay `sck call`、回收 `report.md`/`blocker.md` 为提交/阻塞；把 `ops_*` 转给运维代理。架构与排障详见 [sidecar 通道](sidecar-channel.md) |
| 运维代理 | Paseo 插件内 `src/ops/`（`OpsBroker`，由通道调用） | 持有密封凭证与 Cloudflare/IdP 权限，替员工建账号、建 workspace、管成员、登录、调产品接口、查 workspace 数据、给浏览器登录；员工只拿会话句柄，见下文「运维代理」 |
| 员工 | Paseo 会话 | 按 [协议](../agents/PROTOCOL.md) 执行、写 `.sck` 交付物；进程内无任何凭证，环境里的凭证变量在 spawn 前被清空 |
| 数据 | 本机 SurrealDB（公司 fork，`org.surrealck.company-db`，`127.0.0.1:38480`，数据在 `private/db`）`sck_agent_company/control_plane` | 唯一事实来源；每小时备份到 R2 `sck-company-backup`，每周恢复演练 |

数据位于**本机 SurrealDB**：连接地址与 root 凭证在 `private/company-db.env`（`scripts/company-db.sh install` 生成，优先于产品 `.env`；测试环境不隐式读取）。产品数据仍在 129，由产品 `.env` 描述。备份由 `scripts/company-backup.ts` 完成：zstd 压缩，单文件超过 20MB 拒传并发老板通知，R2 上保留 2 份小时备份加若干每日备份，总量不超过 40MB；`verify` 把最新备份恢复到临时内存库核对行数。运营流水按 `src/data-retention.ts` 的保留期由插件生命周期清理删除。

服务目录：`~/Library/Application Support/SurrealCKCompany/`（`active` 指向固定发布目录；`private/` 为配置与凭证，0700；`logs/` 为日志）。安装、启停：发布目录内 `sh scripts/company-service.sh install|status|restart|stop|uninstall`，默认只管理 `mcp`（任务服务 + GitHub 投影）。调度器、员工通道和运维代理都跑在 Paseo 插件 `sck-company` 里。节点上的插件版本由节点更新器按 Release 切换（见 [company-upgrades.md](company-upgrades.md)），不要手工 `plugin install` 或 `reload` 来升级。本机调试改了 `plugin/` 或 `src/` 时，可用 `$PASEO_CLI plugin reload sck-company` 重载（不要重启 Paseo 守护进程）；开发树登记会被节点更新器拒绝切换，调试结束后执行 `paseo plugin remove sck-company`，再运行 `sh scripts/node-updater.sh run` 重新登记发行版本；**不要再装 launchd 的 dispatcher**（`SCK_COMPONENTS=dispatcher` 仅为旧部署保留），否则会和插件重复派工。服务依赖本机 Paseo、SurrealDB、网络与 GitHub 登录；Mac 合盖或关机时公司暂停。

## 老板入口

三种方式等价，都会写入 `owner_command` 表，由调度器（或命令行本身）执行：

1. **命令行**（在发布目录 `~/Library/Application Support/SurrealCKCompany/active` 下）：

   ```
   sck owner task.create '{"type":"software","title":"我要一个 B2C 商城"}'
   sck owner task.plan '{"type":"software","title":"导出按钮在 Safari 下无效"}'
   sck owner route.list '{}'
   pnpm run company inbox
   pnpm run company approve <任务ID> [意见]
   pnpm run company reject <任务ID> <意见>
   pnpm run company reply <任务ID> <回答>
   pnpm run company direction "先服务律师团队"
   pnpm run company pause | resume | status
   pnpm run company cost [任务ID] [--days N]
   ```

2. **直接写 SurrealDB**（`sck_agent_company/control_plane`）：

   ```sql
   CREATE owner_command CONTENT { kind: 'task.create', type: 'software', text: '我要一个 B2C 商城' };
   CREATE owner_command CONTENT { kind: 'approve', task: '<任务ID>', text: '同意' };
   CREATE owner_command CONTENT { kind: 'reject', task: '<任务ID>', text: '需要修改：…' };
   CREATE owner_command CONTENT { kind: 'reply', task: '<任务ID>', text: '回答：…' };
   CREATE owner_command CONTENT { kind: 'direction', text: '公司方向…' };
   CREATE owner_command CONTENT { kind: 'pause' };   -- 或 'resume'
   ```

   执行结果回写在同一行的 `status`（applied / failed）和 `result`。

3. **在 Paseo 里直接说**：你的指令由老板通道转录为 `task.create` / `set_direction` / `record_owner_decision` 等动作，并逐字记录你的原话，审计来源沿用 `gm-relay:<员工编号>`（历史命名保留）。

唯一编排单位是任务：`route` 表把任务类型映射到执行岗、复核岗与消息模板（执行岗≠复核岗，一任务一会话）。`task.create` 按路由 `next` 把后继类型展开为 `planned` 链，在前驱 accept 的同一事务里激活；员工 `submit` 可带 `next` 提议后继。发给员工的每条消息都是 `outbound_message` 行：老板在控制台消息流预览、编辑、扣留或放行，发送成功后才标记 sent。复核回避只有一条规则：在该任务 `submit` 审计行里作为 actor 出现的员工不能复核它；事实读不出时该任务按 `unknown` 等待。


## 项目环境与凭证

项目环境告诉员工一个仓库怎么发布、在哪验证、哪些是红线；领取任务时随 `project` 字段下发（目标创建时用 `--project` 关联）。

```
pnpm run admin project set project.json                           # 写入或更新
pnpm run admin project list                                       # 查看（含凭证名，不含值）
pnpm run admin project lengths <项目>                              # 只读长度诊断（字段/计数/UTF-8 字节，不含正文）
pnpm run admin project check project.json                         # 只读校验候选输入，不写库
pnpm run admin project broker surreal_ck production broker.json   # 配置该环境的运维代理（见下节）
printf '%s' "$VALUE" | pnpm run admin secret set surreal_ck production SOME_NAME - "用途"   # 角色写 - 表示无
```

`project.json` 结构：`{ id, name, repoPath, defaultBranch, release, rollback, redLines[], runbooks[], notes, envs: [{ name, url, healthUrl, verify }] }`。公开文本上限（按 UTF-8 字节，不是字符）：`release`/`rollback` 各 16 KiB，`notes` 32 KiB；`runbooks` 最多 50 条、每条最多 2 KiB、数组序列化总量最多 32 KiB。超限输入在项目/env 写入前拒绝；存量超限字段未改变时原样保留，显式改变必须满足上限。`project lengths`/`project check` 只返回字段名、计数和字节数，不输出正文或凭证。

凭证存在 `env_secret` 表，值用 AES-256-GCM 加密；密钥只在本机登录钥匙串（服务 `surreal-ck-company`，账号 `env-secret-key`，首次写入凭证时自动生成）。**员工读不到任何凭证值**：`get_secret` / `put_secret` 已下线（调用得到 `unknown_tool` 和指向运维工具的提示），claim 不再下发 `secrets`，`project` 只列凭证名。值只由运维代理在插件进程内解密使用。测试账号的密码 `<别名>_PASSWORD` 由运维代理在 `ops_account_ensure` 时生成并直接密封，不需要手工登记；沿用旧的 `QA_PASSWORD`（对应别名 `QA`）也行。部署密钥不放这里：代码发布走各仓库的 CI（例如 surreal_ck 的 SSH 部署密钥只在 GitHub `production` Environment）。

安全边界：员工、插件和老板命令行跑在同一个系统用户下。这套机制去掉的是「交到员工手里的凭证」和「继承进员工环境的凭证变量」，它不是沙箱：员工进程在操作系统层面仍读得到同用户可读的文件（产品 `.env`、服务 `private/`、钥匙串）。越界读取违反协议、会留在会话日志里，但不会被技术阻止；要强隔离需把员工会话放进独立系统用户或容器。数据库 root 与老板命令行没有密码学隔离；老板身份靠审计来源和协议约束，不是防伪机制。

## 运维代理（ops broker）

员工需要账号、workspace、登录这类凭证才能做的事，不自己动手，向插件里的运维代理（`src/ops/broker.ts`）提出请求：员工 `sck call ops_*` → 会话私有通道（req/res 文件）→ 通道把请求绑定到当前租约的任务 → `OpsBroker` 校验后执行 → 脱敏结果原路返回。员工用法见 [协议](../agents/PROTOCOL.md) 的「运维工具」，通道细节见 [sidecar 通道](sidecar-channel.md)。

能力：`ops_info`、`ops_health`、`ops_account_ensure`（建/修测试账号）、`ops_login`（按账号别名登录，得客户会话句柄；`audience:"ops"` 时经 `idp.ops` 公共客户端直连 IdP `/token` 换出运营会话，不列 workspace、不自动建账号）、`ops_operator_login`（按别名登录运营通道：独立 OIDC client、运营 audience、PKCE 公开客户端经 `/api/auth/ops/token` 兑换；登录时以 `GET /api/ops/quota/context` 实时校验运营身份）、`ops_workspace_ensure`、`ops_member_list|add|remove`、`ops_request`（以会话调产品 HTTP 接口；运营会话只许 `/api/ops/*`，客户会话不许 `/api/ops/*`）、`ops_query`（以会话在 workspace 库里查询）、`ops_browser_login`（把会话注入员工的 ego-browser 任务空间：客户会话落产品 `/` 写 `oidc.access_token`/`oidc.exp`；运营会话先重探 `/api/ops/quota/context` 再落 `/ops/`，写 ops 控制台 `UserManager` 的 `oidc.user:<issuer>:<clientId>` 序列化 `User` 记录；`ops` audience 会话禁止注入）、`ops_idp_client_info`（只读核对 IdP 已登记公开 client 与代理配置的一致性，不返回密钥）、`ops_idp_client_claims`（读/删 client access_token claim 行：`action:"list"` 按 client_id/client_name 列单 client 全部 claim 或仅传 claim_name 做全 tenant 扫描，`action:"delete"` 按 client_id+claim_name 加 source_type/fixed_value 等值限定词精确删除并回返回命中行，空命中报 `not_found`）、`ops_logout`、`ops_origin_status|health|logs`（源站只读：broker 用专用受限密钥 SSH 到 `sckops`，sshd 强制命令只跑 `/usr/local/bin/sck-origin-agent`，服务名白名单、参数有界、两端脱敏；需环境配置 `origin`）。新增能力只需：在 `src/ops/` 实现，登记到 `OPS_TOOLS` 与 `OpsBroker` 的处理表，补测试（`tests/ops-broker.test.ts`，用 `tests/support/ops-world.ts` 的假 IdP/产品/D1），在协议表里加一行，再 `sh plugin/scripts/vendor.sh` 并 `plugin reload`；通道不用改，工具清单自动并入。

每个环境的配置（`admin project broker`，只放非敏感项，校验不过不入库）：

```json
{
  "roles": ["qa", "engineering", "product"],
  "idp": { "issuer": "https://o.maplayer.top/t/ck", "clientId": "<产品 OIDC client id>", "audience": "https://auth.maplayer.top", "redirectUri": "https://l.maplayer.top/auth/callback",
    "ops": { "clientId": "<IdP 上登记的运营公开 client id>", "audience": "https://l.maplayer.top/api/ops/mcp", "redirectUri": "<运营回调地址>" } },
  "ops": { "clientId": "<运营 OIDC 公开 client id>", "redirectUri": "<运营回调地址>", "resource": "https://l.maplayer.top/api/ops/mcp" },
  "product": { "url": "https://l.maplayer.top" },
  "accounts": { "prefix": "sck-", "emailDomain": "maplayer.top", "workspacePrefix": "sck-" },
  "d1": { "tenantId": "<IdP 租户 id>", "databaseId": "<IdP D1 数据库 id>" },
  "data": { "url": "https://data.maplayer.top", "namespace": "main" },
  "limits": { "workspacesPerDay": 6, "accountsPerDay": 20 }
}
```

`roles` 是可用 ops 工具的岗位（缺省 qa / engineering / product）；`accounts` 决定命名：用户名 `<prefix><别名小写>`、邮箱 `<用户名>@<emailDomain>`，新 workspace 的 slug 必须以 `workspacePrefix` 开头；`d1` 缺省则不能建/修账号；`data` 缺省则不能 `ops_query` 与列成员；`browser.bin` 指定 ego-browser 路径（缺省 `~/.local/bin/ego-browser`）；`ops` 缺省则没有运营通道，`ops_operator_login` 返回 `not_configured`。`ops.resource` 是产品运营 audience（IdP 运营 client 的 `access_token_audience` 与之对应）。 运营 client 由 IdP 的受管资源动态注册端点 `POST {issuer}/connect/mcp/register` 自助登记（公开 client、`token_endpoint_auth_method=none`、`scope=openid`），返回的 `client_id` 与 `resource` 填入此块；registration token 不入库。`idp.ops` 缺省则 `ops_login` 的 `audience:"ops"` 返回 `not_configured`：该块配置的公开客户端走 authorize（`resource`=`audience` 值）→ login → 回调 code → 直连 `POST {issuer}/token`（`client_id`+`code_verifier`，无 client_secret），不走产品 `/api/auth/token`；`idp.ops.audience` 即 IdP 侧该 client 的 `access_token_audience`（须等于产品运营 audience）。DCR 登记的运营 client 带 `consent_policy=require`：login 返回的是 IdP consent 页 URL，代理携 login 设置的 `user_session` cookie 自动 approve（IdP 审计 `oidc.authorization.consent.granted`），再跟随 302 拿到 code。自动批准只对 `ops.clientId`（公司自有运营 client）生效；其它 client 或 customer 通道遇到 consent 要求一律 `login_failed(consent_required)`，绝不自动同意。

控制措施：
- **租约门**：每次调用由 `core.opsScope` 重新核验调用者的在手租约，项目取自任务所属目标；通道丢弃员工自带的 `taskId`，只用租约里的任务。任务所属目标没有关联项目返回 `invalid`，项目环境没配置运维代理返回 `not_configured`。
- **岗位门**：岗位不在 `roles` 里返回 `forbidden`。
- **配额**：按审计行统计项目内最近 24 小时的新建数，超出返回 `limit_reached`（workspace 与账号各自计数）。
- **审计**：账号创建/修复、workspace 创建/进入、成员增删、登录、浏览器登录、失败都写 `audit`（证据文本脱敏、限长）；只读调用、`ops_request`、`ops_query` 记为 `ops_call`，不进交接历史（其余进）。
- **脱敏**：返回给员工和写进审计的文本，都先抹掉会话 token、密码，以及 JWT/Bearer/密码形态的字符串；上游错误只透出错误码。
- **会话**：只在内存，按（员工、项目、环境）隔离，每个员工最多 8 个、最长 6 小时；token 临近过期时代理自动重新登录。租约结束、会话归档、插件重启即丢，下次重新 `ops_login`。
- **超时与重试**：IdP 与产品之间是跨公网链路，单个请求 5–10s 属于常态。登录流程每个 HTTP 步骤限 25s、全程预算 75s，遇超时/断连/5xx 从头重试一次（challenge 和 code 一次性，绝不重放单步）；拒绝类错误（密码错、MFA、回调不符）不重试。产品请求限 30s，只有 `POST /api/workspaces` 放宽到 90s（provisioning 是长任务；Cloudflare 边缘 120s 无响应即断，员工侧 `sck call` 120s 放弃，代理要在此之前给出结论）。写请求超时/断连的报错会注明「可能已生效，重复前先查」；workspace 创建类失败（超时、断连、5xx）统一提示用同一 slug 重试——产品在 owner+slug 相同的 provisioning/provisioning_error 记录上会断点续跑（见 surreal_ck `provisioning-saga.ts`），409 则说明 slug 归别人或恰好刚建完，再调一次 `ops_workspace_ensure` 即可分辨。
- **账号密码**：由代理随机生成，先密封入库再交给 IdP；IdP 里只存 pbkdf2 哈希。若 IdP 里的密码被带外改动，`ops_login` 会自动修复一次。
- **控制面凭证**：Cloudflare 令牌与账号 ID 取自插件进程的环境变量；想用权限更窄的令牌，在守护进程环境设 `SCK_OPS_CLOUDFLARE_API_TOKEN` / `SCK_OPS_CLOUDFLARE_ACCOUNT_ID`（优先于 `CLOUDFLARE_*`）。
- **环境清理**：员工会话是 Paseo 守护进程的子进程，会继承它的环境变量。插件的 `agent.session_open` 钩子（`plugin/server/scrub.ts`）在公司员工会话启动前（含 resume / refresh）把继承来的基础设施凭证变量（`CLOUDFLARE_*`、`SURREAL*`、`JEV_*`、`TYPESAFE_*`、`SCK_OPS_*`、`SCK_PRODUCT_ENV` 等）覆盖成空串。provider 自己的登录变量（`OPENAI_API_KEY` 之类）不动，否则会弄坏会话；`SSH_AUTH_SOCK` 和 `gh` 的本机登录也不动，工程要靠它们推分支、开 PR。要多清哪些名字或前缀，在 `private/service.env` 设 `SCK_SCRUB_ENV`（逗号分隔）后 `plugin reload`。老板自己的非公司会话不受影响。
- **zsh 启动文件垫片**：只清启动环境不够。老板在 `~/.zshrc` 里 `export` 的 token 会在每个交互式 zsh 里重新出现，而 codex 正是通过交互式 zsh 的 shell snapshot 执行命令（实测：只清环境时，codex 员工的 shell 里 token 仍然在；factory-droid、devin 走非交互 shell，不受影响）。所以钩子同时把公司员工会话的 `ZDOTDIR` 指到插件在 `<服务目录>/zdot` 生成的垫片目录：垫片里的 `.zshenv`、`.zprofile`、`.zshrc`、`.zlogin` 先原样 source 老板自己的同名文件（老板设了 `ZDOTDIR` 就用那个目录），再 `unset` 外部凭证名（上面的 `CLOUDFLARE_*`、`CF_API_*`、`SURREAL*`、`JEV_*`、`TYPESAFE_*` 和 `SCK_SCRUB_ENV`；`SCK_OPS_*` 这类公司自己的变量不会出现在启动文件里，不列入），PATH 等个人配置照常生效。垫片在每次插件启动时重写（先读 `private/service.env`，所以那里的 `SCK_SCRUB_ENV` 也生效）；写不出来只记警告，环境变量清理照常。
- **边界**：这两层是去掉员工环境里“顺手就有”的凭证，不是硬隔离。员工与老板是同一个系统用户，能直接读 `~/.zshrc`，也能 `ZDOTDIR= zsh -i` 绕开垫片；bash 的启动文件（`.bashrc`、`.bash_profile`）不在垫片范围内。要根治，就别把 token 明文写进任何 shell 启动文件，broker 要用的令牌放进 `private/service.env`，最好是权限更窄的 `SCK_OPS_CLOUDFLARE_*`。
- **环境清理的验证**：新开一个员工会话，在它的进程环境里应看到这些变量为空、`ZDOTDIR` 指向垫片目录（`ps eww <pid>`）；codex 员工的 shell 里 `zsh -ic 'echo ${CLOUDFLARE_API_TOKEN:+set}'` 应无输出。`tests/scrub.test.ts` 用真实 zsh 覆盖了 `-c`、`-lc`、`-ic`、`-lic` 四种启动方式。

## 公司命令

老板端的运维与管理操作（任务、消息、笔记、路由、员工定义、身份与云端、主机命令、发布安装等）都是网关命令。员工用两个工具调用，不直接访问网关：

```
sck call company_cmd_catalog '{}'
sck call company_cmd '{"command":"<命令名>","input":{...}}'
```

- `company_cmd_catalog` 列出本员工当前能调用的命令，附参数说明（网关 `cmd.catalog`）。员工看不到三类命令：仅老板命令、保护清单里标为仅老板的命令、员工策略的禁止清单或允许清单之外的命令；员工已停用时列表为空。按目标锁定的命令仍会列出，并附锁定说明，命中即拒绝。老板看到全部命令。目录只说明能用什么，每次调用仍要过网关判定。命令说明集中在 `owner-end/src/command-catalog.ts`，老板端「运维」页的命令面板与之共用。
- `company_cmd` 只在云端执行端可用。本机模式返回 `not_configured`，提示需要云端执行端。
- 调用必须持有任务。无有效租约直接以 `no_lease` 拒绝，不换取令牌。调用以员工身份和当前租约任务换取网关令牌。请求顶层的 `taskId` 被丢弃；`input` 里点名的 `taskId`（可带 `task:` 前缀）与 `messageId` 必须属于当前租约任务，否则拒绝。
- 执行端作业（如 `host.exec`）返回 pending 时，员工侧按作业号轮询，直到完成、失败或超过 15 分钟。员工只能取到自己发起的作业。
- 每次调用（含被拒绝的和只读的）写一条审计。老板用 `guard.protect` 把命令加入保护清单（`ownerOnly` 缺省为仅老板），用 `agent.policy.set` 停用员工或设允许、禁止清单。
- 令牌只在网关调用的局部变量里存在。返回与错误文本中出现的令牌一律替换，不写会话、comm 目录、证据或日志。

**风险（待审阅者决定）。** 网关不区分调用方是否老板。除写死的 5 条仅老板命令、员工不可见的 `ops.job.list` 与 `audit.list`、保护清单与员工策略外，持有有效租约的员工可以调用其余全部命令；按目标锁定的命令只拒绝锁定的目标。这包括替老板作决定（`decide`、`approve`、`reject`；`approve` 会写入标为老板签署的人工验收证据）、代老板下指示（`instruct`、`direction.add`）、改路由与派工模板（`route.save`）、暂停全部派工（`task.pause`）、用老板的 Cloudflare 令牌调用未锁定的账号资源（`cf.api`），以及执行端命令（`host.exec`、`task.create`）。执行端作业入队后，只有 `ops_*` 在认领时核对租约，其余作业即使租约已结束也会执行。上线前，老板应把这些命令加入保护清单，或由审阅者决定写死为仅老板。细节见 [owner-end 权限模型](../owner-end/README.md#权限模型)。

## 员工编制（SurrealDB）

- **员工定义** `employee_def`：`role`（任务岗位）、`provider`（codex / grok / devin）、`model`、`thinking`，可选 `max_instances`（默认 1）、`weight`（派工权重，默认 10）、`enabled`、`tracks`（岗位轨名单：非空则只接 `discipline` 在列的任务，缺省或空 = 全接）。可直接写库，例如：

  ```sql
  UPSERT employee_def:engineering-grok CONTENT { role: 'engineering', provider: 'grok', model: 'auto:grok', thinking: 'medium', max_instances: 2, weight: 25 };
  ```

  `model` 是槽位而非钉子：`auto:<族>`（`auto:sol` / `auto:grok` / `auto:swe`）表示跟随该 provider 该模型族的最新版——Paseo 插件每 5 分钟经 `providers.listModels` 刷新 `company_meta:model_slots`，调度器在派工前把槽位解析成具体模型 id（如 `auto:sol → gpt-6.1-sol`）再 spawn。厂家发布 `gpt-6.2-sol` 后：槽位更新 → 当 tick 先退役空闲旧模型实例（忙碌中的跑完当前会话）→ 下一个任务用新模型起新会话，全过程零人工。字面量（如 `gpt-6.1-sol`）则 pin 死。跨族/改名（`gpt-7`、新命名线）不会被 auto 匹配，等人工决策；槽位解析失败时该 def 不可新开并给老板发通知，存量实例继续跑上次的模型。首次采用新版本时插件发一条告知通知（不需要批准）。

  或 `pnpm run admin def set|list|weight|tracks|enable|disable`、`pnpm run admin seed-defs`（写入默认定义：各任务岗位 × codex/grok/devin 三订阅（不含 eval 岗位），另加 screenwriter-agy、story-author-agy（antigravity 单座）、cinematography-codex（codex 单座））。`def tracks <id> <轨,轨|->` 限定编制的岗位轨；`def set` 不带轨参数，不会清掉已设的 tracks。也可在 Paseo 编制页用「注册员工」表单：岗位/provider/模型/thinking 全部下拉自 Paseo 实时数据（`providers.snapshot` + `listModels`），服务端注册前再校验一遍，杜绝手填错字。def id 自动取 `<role>-<provider>`。

- **派工权重**：同岗位多个合格候选（空闲实例或可新开的定义）按 `weight` 加权随机选取；`weight=0` 不会被主动选中（同岗位所有候选都是 0 时才均匀分配）。员工绩效系数已于 0.5.0 删除，不再参与加权。调权：`pnpm run admin def weight <id> <n>`，或直接改 `employee_def.weight`——下一轮 tick 生效，无需重启。

- **绩效评分（0.5.0 已删除）**：`scorecard`、`record_score`、`get_model_evidence`、eval 岗位、每日 eval 批次与 Jev 评分均已删除，`eval_*`、`jev_*` 配置项同时失效。Jev 本身保留，用于通知分级与派工辅助。
- **员工实例**：`employee` 表中带 `def` 的记录，由调度器按需生成；`paseo_agent_id` 登记实际会话，是实例身份的权威绑定。新实例的凭证不落盘——由插件 sidecar 在内存中代持，`spawn` 环境只注入 `SCK_COMM_DIR`/`SCK_COMM_KEY`；`claim`/续租/提交由 sidecar 以该凭证程序化执行，agent 进程拿不到也不认识它。`retired=true` 或凭证撤销后所有调用即 401，实例随会话关闭退役。同一定义连续 3 次异常会自动停用并通知老板。`pnpm run admin inst list` 查看。
  旧的凭证文件会话（`credential_file` 非空的实例）继续按原方式收尾，但不再被通道代领新任务，自然淘汰。
- 旧员工（gm-01 等）以 `admin bind <员工编号> <agentId> <def>` 挂到定义上，继续保留身份和历史。

## 任务成本

每个任务在完成时结算成本，存入 `task_cost`。结算不依赖评分（0.5.0 起）：

- **来源**：VPS magpie 的用量接口 `usage/requests?q=<session>`，同一个专用 key 鉴权，按会话精确匹配。会话为 `sck-<digest(任务:员工)>`，与员工请求头 `x-magpie-session` 一致。
- **未定价**：未定价的请求单独计数（`unpriced`），不按 0 冒充；某个会话在 magpie 窗口里已无记录时 `complete=false`，金额是下限。
- **内容**：请求数、失败数、输入/输出/缓存读写 token、USD、模型耗时、建单到最后一次 accept 的总时长，再按员工和模型拆分。
- **查看**：`pnpm run company cost <任务ID>` 看单个任务；`pnpm run company cost --days 7` 列出近 N 天已结算任务。成本列表不再显示复杂度与评分。老板侧用 `get_task_cost`（仅老板可读）。

## 提交前系统检查

工程员工在 ops 仓提交 code 任务时，服务先在其工作树上做只读检查，不通过直接退回原员工（租约保留，不派评审），审计记 `submit_check_failed`：

- 改了 `src/`、`plugin/`、`scripts/` 时 `package.json` 版本必须高于 main，`plugin/package.json` 与 `company-release.json` 版本一致；
- `src/mcp/server.ts` 注册的每个工具都接到 sidecar 分发与工具表；`package.json` 测试脚本里列的文件都存在；
- `tsc --noEmit` 无类型错误（服务自带编译器，在员工沙箱内运行；工作树缺依赖或编译器无法运行时放行，由评审把关）。

`SCK_SUBMIT_CHECKS=0` 关闭。

## 管理工具（manage）

老板（owner，`capabilities` 含 `manage`）除常规任务工具外，还可通过 MCP 工具面或 `sck call` 调用三个仅限 manage 能力的编制管理工具——全部写审计，不带凭证值：

- `def_list`：只读列出全部 `employee_def`（`id`/`role`/`provider`/`model`/`thinking`/`tracks`/`enabled`/`max_instances`/`priority`/`weight`）。任何岗位可读（只要能力里有 manage 即可调用，不写库）；无 manage 能力的岗位调用返回 `forbidden`。
- `def_ensure`：创建或更新 `employee_def`，复用 `workforce.upsertDef` 的校验与写入逻辑；`tracks` 传 `[]` 清轨、不传则不动；`enabled=false` 停用（覆盖退役/收轨诉求）。`role` 必须是合法 `Role`（screenwriter 上线后含它）。调用者必须有 manage 能力，写入同时落审计（`actor`、`action=def_ensure`、参数摘要）。
- `project_disciplines_update`：只改写 `project.disciplines` 词表（名字唯一非空校验沿用 `ProjectStore`），不碰项目其它字段。调用者必须有 manage 能力，写入同时落审计（`actor`、`action=project_disciplines_update`、参数摘要）。

三次写入的审计条目可查：`SELECT * FROM audit WHERE action IN ('def_ensure','project_disciplines_update') ORDER BY at DESC`。owner console 与 admin CLI 继续可用，与 MCP 管理工具并存。

## 在途任务验收要求追加（task_acceptance_amend）

老板（owner）可把自己对在途任务验收范围的收窄/追加决定写成任务可读的修订，不必作废重建、也不等下一次派工：`{taskId, expectedVersion, ownerQuote, text, notify?, idempotencyKey}`。

- 范围：只接受 `ready` / `doing` / `review` / `blocked`；`done` / `void` 返回 `conflict`。非 owner 一律返回 `forbidden`。
- 只追加：不改 `state`、`blocked_to` / `resume_*`、依赖、`acceptance_criteria` / `acceptance_version`、独立性策略、worktree 与租约字段（持有人、delivery、fence、到期时间），不放宽验收机器项、独立验收、额度或依赖。任务版本也不移动——版本是持有人租约证明的一部分，移动会让持有人在通道心跳重新同步前（最多 60 秒）的 checkpoint/submit 撞上租约失效；`expectedVersion` 仍做 compare-and-set，读到过期任务即 `conflict`。
- 落库：单事务把修订追加到 `task.context`——拼接在事务内由被锁的行算出（`$t.context + 修订块`），不在事务外读旧值再整体覆写；同一版本并发两次修订两条都落地（输的一方拿到可重试的写冲突后整笔重跑，重跑会读到对手的正文）。追加后总长上限 20000 字符（与创建时一致），超限整笔回滚并返回 `invalid`，检查也在同一事务内。审计 `action=acceptance_amend`（`evidence` 为 JSON：`ownerQuote` 逐字原话、`text`、`notify` 入参、`expectedVersion`）与 outbox 同事务写入。
- 通知：`notify` 缺省为「当前活租约持有人 + 最近 submitter」去重；显式传入以传入为准，`[]` 表示不通知（审计照写）。每条通知是一行 `outbound_message`（step=notice），老板可在控制台预览/扣留；送达由调度器在下一次唤醒或回包补发，标记 sent 只在外部发送成功之后。
- 幂等：同一 `idempotencyKey` 同载荷回放首次结果（不重复追加、不重复通知），异载荷 `conflict`。

## 任务输入上限

任务的编排字段：`type`（路由键）、`parent`（链上前驱；未完成前子任务保持 `planned`）、`proposed_in`（提议来源 submit 审计）、`tag`（自由分组）、`requirement`/`acceptance_text`（task.md 的两节）。显式 `dependencies` 与 `goalId` 已退役：入参带它们返回 `invalid`（`goalId is retired; use tag`）。asset 类 `workIntent.paths` 至多 50 条、每条至多 300 字符，非 assets 不接受 paths。判定在 core 统一完成：超限返回结构化 `invalid`，任务/审计/outbox/幂等零写入。

## 身份关联（identity_principal_set）

老板（owner，manage 能力）可登记 principal：把多个 employeeId 显式绑定为同一个人，用于独立性策略的同源判定（SYS-DISP IR02/Q3）。

- 这是唯一的跨员工身份键。编制（`employee.def`）是容量模板（可有多个独立员工），provider、模型、名字、目录都不是身份；两个同一编制的员工默认相互独立，`maxInstances` 不构成连坐。
- 字段：`principalId`（省略则新建）；`employees`（写入后该 principal 的完整员工集合，1–20 个，原始条数受检）；`reason`（必填，8–2000 字符，写审计）；`expectedVersion`（compare-and-set，新建时省略）；`idempotencyKey`。
- 写入：单事务完成，审计 + 幂等行同时落库；同一 `idempotencyKey` 同载荷回放原结果，异载荷冲突。任一被登记员工持有未到期租约时拒绝——不在任务运行中静默改身份。员工不存在、已注销、参数非法均拒绝。非 manage 能力返回 `forbidden`。
- 默认身份是 employeeId 本身：不登记任何 principal 时，同 def 不同 employee 允许，同 employee 换会话/agent/工作区仍拒绝。历史审计事实不因身份变更重写。

## 运行参数

`company_meta:config`（`pnpm run admin config <key> <json>` 或直接写库）：

| 键 | 默认 | 含义 |
|---|---|---|
| `max_running` | 4 | 同时运行的员工会话上限 |
| `provider_max` | `{codex:3, grok:2, devin:2}` | 每个订阅同时运行上限 |
| `poll_seconds` | 20 | 调度间隔 |
| `stall_minutes` | 90 | 无 checkpoint 多久视为卡死 |
| `redispatch_minutes` | 15 | 派工后多久未领取可改派（评审派工同样受该去重窗口约束） |
| `paused` | false | 暂停派工（也可用 `company pause`） |
| `quota_floor_pct` | 8 | 订阅短窗口/余额剩余低于该百分比即停止复用与新开；0 = 不熔断 |
| `quota_weekly_floor_pct` | 2 | 订阅周/月窗口剩余低于该百分比即停止复用与新开；0 = 不熔断 |
| `quota_warn_pct` | 20 | 订阅剩余低于该百分比但未触底时，给老板发一次「即将用尽」提醒；0 = 不提醒 |

## 排障

- 调度日志：`logs/stdout-dispatcher.log`、`logs/stderr-dispatcher.log`；只在有变化时写入一行 `tick {...}`。
- 订阅状态：`pnpm run company status`，或查询 `SELECT * FROM provider_health`。
- 手动让某订阅立即重试：`UPDATE provider_health:<provider> SET until = 0;`（下一轮只派一个探测任务）。
- 任务历史：相关员工或老板 `get_task_history`，或查询 `SELECT * FROM audit WHERE task = task:<id> ORDER BY at`。
- **Jev 接入**：在 `private/service.env` 加 `JEV_API_KEY`（也可用 `TYPESAFE_API_KEY`）即启用；可选 `JEV_BASE_URL`（默认官方 `https://api.typesafe.ai/v1/systemone`，托管计费网关为 `https://jevtypesafeai.com/api/v1/decide`）、`JEV_MODEL`（默认固定 `jev-1.13.0`，避免阈值漂移）。key 从 TypeSafe 早期访问 waitlist 或托管网关获取。验证连通性：`pnpm run admin jev-test`。Jev 只返回结构化判断（`probabilities`/`confidence`），不产生文本输出。Jev 用于通知分级与派工辅助。
- devin 订阅不接受 `thinking=low`（`paseo run` 报 AGENT_CREATE_FAILED）；devin 定义请用 medium/high。定义连续 spawn 失败 3 次会自动停用，修正后 `pnpm run admin def enable <id>` 恢复。
- 不想让某类员工再接任务但保留定义：`pnpm run admin def weight <id> 0`（软停用，全部候选为 0 时仍可能兜底）；彻底停用用 `def disable <id>`。
- **订阅额度从哪读**：Paseo 的用量列表只覆盖它自己驱动的订阅（本机是 claude/codex/grok）。0.5.0 起额度补充默认读取 VPS magpie（`https://data.maplayer.top/ofm`，带员工专用密钥）；配置了 `MAGPIE_ADDR` 时改读该地址。调度器读取 `GET <magpie 地址>/v1/magpie/quotas`，把 Paseo 没报的订阅补进来（`factory` → `factory-droid`），两边都报时以 Paseo 为准。读取失败、超时或 magpie 未运行，一律按“没有答案”处理，绝不当成“额度为 0”。该端点在 0.5.0 上线后需确认，见下文上线记录。
- **员工实例什么时候退役**：只有“这个会话不可能再接任何任务”才退役——凭证文件实例在 sidecar 模式下不可复用（通道轮换）、派工轮次或上下文超过 `session_max_wakes` / `session_max_input_k`（会话轮换）、Paseo 报会话已归档（正常结束）、启动绑定失效且会话还活着（通道隔离）、spawn 失败且不是额度类错误、claim 被拒或写权被占且未绑定实现人、任务现场销毁（场景回收），以及老板手工退役。
- **不因额度耗尽退役**：额度失败只把 provider 记进 `provider_health`（冷却按指数退避：30 分钟起、最长 6 小时），任务留在原实现人名下等待恢复，不再记员工定义的违规次数。长时间耗尽由额度下限熔断挡住派工（额度来源见上文“订阅额度从哪读”），不靠冷却时长兜底。
- **老板待办路由**：基础设施原因（配额、探测忙、席位满、主机资源、唤醒失败、候选为空、先前提交人、未知）导致的无法派工记为持久待办并升级成老板通知（同一 task+阶段+episode+reason 去重，理由变化或派工成功时收口并保留审计）。需要老板决定的问题走 `blocked_to='owner'` 进收件箱，由 `sck owner decide`/`task.reassign`/`task.void` 处置。

- **复核回避**：唯一排除规则是先前提交人——任务 `submit` 审计里的 actor 不能领该任务的复核；读不出按 `unknown` 等待。返工时上一轮提交人优先续做，claim-only 经手人按 `PRIOR_HAND_WEIGHT_FACTOR` 降权。没有自动接替：候选为空按 `no_candidate` 记无法派工。

- **按编制豁免额度限制**：`employee_def.quota_limited`（默认 true）设为 false 时，该编制不受额度下限熔断与额度类健康冷却影响：剩余额度为 0 也继续派工；停在 error 的会话按 5 分钟重试间隔就地重载后继续尝试。并发席位上限（`provider_max`）仍然生效。设置方式：编制页编辑「额度限制：不受限」、老板 `def_ensure` 的 `quotaLimited` 字段（`sck owner def.ensure`），或 `pnpm run admin def quota <id> unlimited`。
- **额度恢复后会话自动重启**：额度失败会把会话停在 Paseo 的 `error` 状态，而 Paseo 不会自己把它放出来；调度器只往 `idle` 会话派工，所以冷却结束后调度器用 `paseo agent reload` 就地重启该会话（agent、对话与通道绑定都保留），不退役、不重开新员工。重载失败按 5 分钟间隔重试。
- **不因模型漂移退役**：供应商可能在会话中途换模型（Factory 标准额度用尽后会切到更便宜的模型，恢复后再切回）。调度器读到 Paseo 报的实际模型与编制不符时，通过 Paseo daemon 的 `update_agent` 就地改回；改不动就留到下一轮，会话、上下文与席位都不丢。订阅还在冷却或低于额度下限时不做改回——那期间的改回不可能生效，调度器等订阅恢复后的第一轮再改。
- 订阅耗尽的排查顺序：`pnpm run company status` 看订阅状态 → `SELECT * FROM provider_health` 看冷却与 `last_error` → `GET <magpie 地址>/v1/magpie/quotas` 看真实剩余额度（含 Paseo 不报的订阅）。magpie 地址默认是 `https://data.maplayer.top/ofm`（需带员工专用密钥），配置了 `MAGPIE_ADDR` 时为该地址。

## v2 归档

`scripts/queue.py`、`agents/registry.json` 与 GitHub 标签队列只用于收尾 v2 旧工单（#23、#28 等），新工作一律进入任务服务。启动任务 #3—#16 已由老板决定取消。

## 上线记录

以下记录为历史事实。其中涉及绩效评分、模型排序、本机 magpie 与本机网关的条目已被 0.5.0 替代，仅保留原文供追溯。

- 0.5.0（待上线）：删除本机 18779 模型网关，员工 Claude 会话直连 VPS magpie `https://data.maplayer.top/ofm`。员工会话的环境变量由插件在会话打开时注入：`ANTHROPIC_BASE_URL` 指向 VPS；`ANTHROPIC_AUTH_TOKEN` 取自服务目录 `private/magpie-remote.key`，该文件缺失或为空则拒绝启动员工会话，不静默直连；`x-magpie-session` 头为 `sck-<digest(任务:员工)>`；模型为 `group/sck-haiku`、`group/sck-sonnet`、`group/sck-opus`，按任务档位选择。配置经 `--settings` 私有文件加载（员工通信目录下 `.claude/settings.local.json`，权限 0600），因为用户全局 `settings.env` 会覆盖进程环境变量。story-author 与老板手动会话不注入。
  会话归因改为换任务即换会话，reuse 与 oneshot 两种策略都是：同一任务内的返工、复审接续原会话。升级前已存在、没有绑定任务的旧会话，在下次派工时换新会话，因为旧会话环境里仍是已停用的网关地址。
  删除模型排序整套（ranking、aa 榜单、alias、inventory、health、roster、trends、urgency、weights、内置 benchmarks）、agent 模型指标页、模型切换时间线与 model_execution 台账。
  删除全部员工评分（scorecard、record_score、get_model_evidence、eval 岗位、每日 eval 批次、Jev 评分）。Jev 保留，用于通知分级与派工辅助。员工绩效系数不再影响派工权重，`weight` 基值保留。
  task_cost 改为按会话精确匹配 VPS magpie 用量（`usage/requests?q=<session>`，同一个专用 key 鉴权），任务完成时结算，不依赖评分。成本列表不再显示复杂度与评分。
  不再依赖本机 magpie 中转（127.0.0.1:3425）。额度补充与配额熔断改读 VPS magpie（带员工专用密钥），配置 `MAGPIE_ADDR` 时改读该地址。
  放弃项：员工思考等级（thinking）控件对组名模型不再传给 Paseo，因为组名模型未经 Paseo 验证。
  ops 的 magpie 证据采样只接受回环地址，默认指向 VPS 时报 blocked，需另行适配。
  schema 迁移 060：删除 model_execution、model_scorecard、scorecard 表，删除 task 与 employee 上的评分字段，新增 employee.session_task。
  回滚：切回 0.4.3。schema 降级不支持，060 删除的表数据丢失可接受。0.4.3 依赖本机 18779 网关与 127.0.0.1:3425，切回前需确认两者可用。
  上线验证项：Paseo 是否接受 `claude/group/sck-*` 模型名；VPS magpie 对 group 的处理；VPS 额度端点 `/v1/magpie/quotas` 可读；Factory 等供应商的配额熔断来源；员工密钥缺失时会话启动失败的表现；升级时旧会话的过渡。
- 2026-11-07：线的笔记与会话回收修复（v0.3.81）。新增 `lane_note` 与 `notes.md`，修复带范围的会话不轮转、不回收，等待中的会话占席位，路由模板不生效。设计见 [session-lanes-design.md](session-lanes-design.md)。

- 2026-11-02：运营客户端默认走 IPv4 建连上线，缓解 IdP AAAA 路径超时（来源 PR #2076 → main `a2c355f31114fd074dfde84c8683f487064631b2`，版本 v0.3.72，发布 `releases/a2c355f31114fd074dfde84c8683f487064631b2`；回滚目标 v0.3.71 `releases/caf84b5022d21f02efcc5e9ba5d1865e375baa5e`）。依据诊断 `4e2c6f94`（本机到 IdP/Cloudflare 真实 AAAA 路径超时；vendored undici 默认 6 次 4 失败，connect family:4 为 6 次 0 失败）。改动：`src/ops/fetcher.ts` 的 `OpsFetchOptions` 增加严格类型 `family?: 4|6`，ops 私有 undici dispatcher 的 connect 默认 family=4（显式 6 仅供受控探测）；主连接池与 `freshConnection()` 共用同一份 connect（timeout/ca/family），TLS 校验、AbortSignal、重试上限与 close 逻辑不变。不改主机 IPv6/DNS/TUN/代理，不用全局 NODE_OPTIONS，不增加登录次数/预算，不对一次性 token exchange 新增重试，无数据库迁移与新环境变量。CI：Quality gate run 41454420216、Channel quality run 41454420374 在 `a2c355f` 上均 success。升级（老板已开启自动升级通道）：装前根/插件双 typecheck 退出 0，两道本机门禁 comm-slow-pipe 与 sidecar-review 均 pass（记录在 `gates/<sha>.json`）；审计 `company_upgrade_verified` 记固定快照、双门禁、active、健康/ready、插件来源与 schema/vendor 核验通过。双面核验：`active` → `releases/a2c355f…`；插件来源 → `releases/a2c355f…/plugin`；`schema/` 与 `plugin/server/vendor/schema/` 无差异；`plugin/server/vendor/src/ops/fetcher.ts` 去首行 `@ts-nocheck` 后与 `src/ops/fetcher.ts` 逐行一致且含 `family: options.family ?? 4`；本机 MCP `127.0.0.1:38473/health` 与 `/ready` 均 200（ok/ready），真实员工通道 `sck call get_context` 可用。生产健康：产品 `https://l.maplayer.top/health` 返回 200（status=ok，surrealdb=up，探测 9.0s）；本机实测到 Cloudflare 的 IPv6(AAAA) TCP 不通、IPv4 TCP 通，佐证诊断。局限：IPv4 只缓解已证实的 AAAA 路径问题，不承诺消除全部网络超时；真实登录仍失败须按 hop 与 errno 区分，不以公开 health 200 签收登录可用。回滚：切回 v0.3.71 固定发布 `releases/caf84b5022d21f02efcc5e9ba5d1865e375baa5e`（升级作业验证失败时自动恢复上一固定发布）。生产实测（`ops_login` LCA04_ADMIN 与 `ops_operator_login` LCA04_OPS 各一次、成功即 logout）由 QA 在任务 `b4eee43c-1599-4ba2-b88a-49a828d57f11` 独立签署。

- 2026-10-28：老板交接型升级卡可达与旧版本待办自动收口（PR #1788 → v0.3.14 `9fe224d`，PR #1789 → v0.3.15 `e43a7d6`，现役 `releases/e43a7d6…`）。SYS05 的 `owner_handoff` 等待会把任务的 `blocked_to` 清空登记到 `task_wait`，而升级卡只从 `inbox.gates`（review + 复核人 owner）与 `inbox.questions`（blocked + `blocked_to=owner`）生成，于是「请老板点升级」这条待办既不是关口也不是提问、卡片渲染不出来；即使补上按钮，`start()` 状态门、runner 装前重校验与装完的 `owner.decide(reply)` 三道门也会全部拒绝。生产任务 `0029e642`（v0.3.13 部署腿）正卡在这里。改动：`state()` 从 `inbox.handoffs` 一并生成卡片并把低于现役版本的卡标 `retired`（两面都不再给可点动作）；`start()` 与 runner 接受 `wait_kind='owner_handoff' AND wait_owner_role='owner'`；`finish()` 在该状态下走 `WaitStore.resolve` 解除等待（老板点升级即该等待 `pendingAction` 要求的决定），不再走会失败的一拍；新增 `closeSuperseded()` 在现役版本之上收口所有更老版本的待办并整批审计，v0.3.14 只挂在升级作业的 `finish` 之后，实测发现手工 `company-service.sh install` 或重启后不收口，v0.3.15 因此把同一收口接进调度循环（每 10 分钟，判定依据改成现役实际版本，新增 `CompanyUpgrades.installed()` 与 `upgrade-closure` 计时阶段）；低于现役版本的安装请求给出独立提示。顺带修正 `release-gate.test.ts`（`sidecar-review` 门禁自 v0.3.12 起已跑第 4 个文件 `effective-policy.fork.test.ts`，用例清单未同步，两例在 origin/main 上本就失败）。`e43a7d6` 验收：根/插件 typecheck 退出 0；test:comm 19 通过/1 跳过；test:service 55 通过/0 失败；test:bridge 1217 通过/59 跳过/0 失败；升级 fork 套件 14 通过/0 失败（新增 3 例：交接卡可达并装完解锁、装机后更老卡片收口、retired 卡拒绝再装）；两道本机发布门禁 comm-slow-pipe 与 sidecar-review 在 bun 1.4.2 下 pass。上线后用生产代码对真实数据实测：收件箱 current=v0.3.15，`0029e642` 的 v0.3.13 卡标为「已被 v0.3.15 替代」并退出收件箱；交接等待 `released`（actor 记 `system:dispatcher`）；任务回到 `ready` v10；审计落 `wait_released` 与 `company_upgrade_cards_closed`（现役 v0.3.15；关闭旧版本待办 1 张：0029e642@0.3.13）；MCP `/health`、`/ready` 均 200，插件 running 且来源指向新 release，调度心跳继续。说明：本次安装为人工执行（工程会话有 releases/active 写权），因此收口由调度循环兜底触发，正是 v0.3.15 修的场景。

- 2026-10-21：额度耗尽误判修复上线（老板批准范围：修复顺序 2、3、4——magpie 额度接入、额度预警、事故收尾；另含模型漂移改回与退役标准梳理）。来源 PR #1503 → main `6b6a0be`，发布 `releases/6b6a0be…`；随后发现额度行读取的前缀谓词漏掉带连字符的 provider（`factory-droid` 恰好不可见），来源 PR #1507 → main `2ac720d`，发布 `releases/2ac720d…`；再以 PR #1508 → main `6003e2c` 发布 `releases/6003e2c…`（漂移等待日志按周期节流并补前两条记录；active 与插件来源同为该 SHA）。同日再以 PR #1510 → main `3d19cb7` 发布 `releases/3d19cb7…`（额度下限日志按变化节流；active 与插件来源同为该 SHA，双面一致；CI 两个工作流均 success）。随后以 PR #1512 → main `4f01a1d` 发布 `releases/4f01a1d…`（过期额度快照不再触发预警，防止 15 分钟前的旧数字上收件箱；active 与插件来源同为该 SHA，CI 两个工作流均 success）。上线后 `quota-warn:grok` 旧提醒已清除，`quota below floor` 每轮只写一次。再以 PR #1514 → main `2849dcf` 发布 `releases/2849dcf…`（花名册实例载荷只带 id/def/agentStatus，编制按「启用且有在线实例」优先排序后再截断；active 与插件来源同为该 SHA，CI 两个工作流均 success）。上线后 44 条编制显示 35 条（全部 35 条启用编制在内），34 个在线实例全部显示。再以 PR #1516 → main `cc5cab2` 发布 `releases/cc5cab2…`（员工定义新增 `quota_limited`，默认受额度限制；设为 false 的编制在剩余额度为 0 时仍可派工，schema 升到 22；active 与插件来源同为该 SHA，CI 两个工作流均 success）。上线后将工程 4 条启用编制设为不受限，工程派工恢复。`2ac720d` 验收：根/插件 typecheck 退出 0；test:service 12 通过；test:channel 153 通过/14 跳过/0 失败；test:bridge 403 通过/23 跳过/0 失败；fork 套件 46 通过/0 失败；全量 `--all` 1019 通过/33 跳过/12 失败，与基线 `6b6a0be` 的 14 个具名失败逐名比对为真子集（无新增）。pnpm-lock `94ec54e8…`，plugin/pnpm-lock `1e9c48f5…`，vendor 摘要 `fefa7b35…`（106 个文件）。上线后插件日志出现 `quota below floor: … factory-droid 额度不足（周/月额度 0%<2%）`，为额度行读取修复的直接证据。再以 PR #1518 → main `b0d8dc7` 发布 `releases/b0d8dc7…`（编制编辑表单不再把未知的额度开关写成「受限」：表单状态保留 undefined、提交时原样回传，界面判定改为 `quotaLimited !== false`；active 与插件来源同为该 SHA，CI 两个工作流均 success）。`b0d8dc7` 验收：根/插件 typecheck 退出 0；test:bridge 410 通过/23 跳过/0 失败；test:channel 159 通过/14 跳过/0 失败；fork 套件 46 通过/0 失败。再以 PR #1520 → main `d815ba8` 发布 `releases/d815ba8…`（实现人会话失效时系统自动接替：与经理 `implementer_takeover` 同一笔比较并交换事务，审计 actor 记为 `system:dispatcher`、事件标记 `[implementer_takeover:auto]`，不带凭证、不暴露为员工工具；新增原因码 `implementer_unavailable`，负责方写「系统」，文案不再指向经理；active 与插件来源同为该 SHA，CI 两个工作流均 success）。`d815ba8` 验收：根/插件 typecheck 退出 0；test:bridge 411 通过/23 跳过/0 失败；channel fork 定向 62 通过/0 失败；其余 channel fork 文件 51 通过/0 失败。上线后线上实测：07:24:46Z 系统自动接替 `58042591`（实现人 `engineering-grok-fecf2b` 会话已归档 → `engineering-fable-12c5e9`，审计 actor `system:dispatcher`）；07:26:02Z 死会话员工退役；07:26:21Z 接替者领取任务并唤醒，任务转 `doing`；「无法派工」通知随之消警。再以 PR #1523 → main `9854fe0` 发布 `releases/9854fe0…`（修复 schema 22 把 `quota_limited` 定义成非可选布尔、使 40 条旧员工定义一经写入即报 `Expected bool but found NONE` 的问题：原地改为 `DEFINE FIELD OVERWRITE … TYPE option<bool>`，不新增 schema 版本；新增 `scoring.rescoreAggregates` 与 `admin rescore` 可重复重算入口；active 与插件来源同为该 SHA，CI 两个工作流均 success）。`9854fe0` 验收：根/插件 typecheck 退出 0；channel fork 定向（quota-store + dispatcher-sidecar）11 通过/0 失败。生产处理：回填 44/44 条定义（缺失 0）；重算 915 名员工与 40 条编制，三条落后编制已与评分卡一致；线上字段已显示为 `none | bool`（option<bool>），`admin rescore` 从发布目录返回 `{employees:915, defs:40}`。事故回执：`eval-codex-6dd001` 对 `0565ac1b` 的 `record_score` 因该字段失败，但 5 张评分卡与 `evaluated_at` 已落库，本轮汇总已由重算补齐。再以 PR #1536 → main `b1a8968` 发布 `releases/b1a8968…`（自动接替覆盖派生实现人：无显式 `implementer` 的旧任务按执行门派生的唯一作者判定，员工退役/撤凭证、不在册或会话不可恢复时系统直接改派；忙、空闲、额度冷却不触发；接管事务照旧把新实现人显式写回。active 与插件来源同为该 SHA，CI 两个工作流均 success）。`b1a8968` 验收：根/插件 typecheck 退出 0；channel fork 定向 63 通过/0 失败。上线后线上实测：10:14:10Z 系统自动接替 `1c7544fa`（派生实现人 `engineering-factory-droid-7ef5c9` 已于 10-20 会话轮换退役 → `engineering-claude-2860a2`，审计 actor `system:dispatcher`）；10:16:02Z 接替者领取并唤醒，任务转 `doing`。
- 2026-09-28：v3 上线，发布 `af63565`（`releases/<sha>`，`active` 指向当前版本）。写入 18 个默认员工定义；gm-01、product-01、eng-01、eng-02、ai-01、qa-01、cs-01 挂到各自的 `*-codex` 定义上，身份与历史保留。旧 Paseo 定时巡检 `d747edb8` 已到期，额度巡检 `cc85bb8f` 已暂停，由调度器取代。启动任务 #3—#16 已按老板决定取消（not planned）。
- 演练 A（GitHub #34）：调度器派 qa-01 执行 → checkpoint → submit → 自动派 eng-01 独立验收 → done。
- 演练 B（GitHub #35）：codex 并发临时设为 0，调度器按定义新开 `cs-grok-9d59da`；它存下 ALPHA 进度后会话被强制归档。约 25 秒内调度器退役该实例并撤销凭证、收回租约并附交接包、新开 `cs-grok-580043` 接手；接手者读到 ALPHA 与交接包，跳过已完成步骤存下 BETA 并提交；`qa-grok-5dfd5a` 独立验收通过。旧凭证调用返回 401。
- 未在真实环境演练的路径：真实订阅额度耗尽（错误文本分类、冷却与探测恢复由集成测试用模拟网关覆盖），所有订阅耗尽时的充值提醒。
- 2026-10-26：GitHub 计费拒绝不再算 CI 失败（来源 PR #1713 → main `fcbc828`，发布 `releases/fcbc828…`，active 与插件来源同为该 SHA）。GitHub 因账户付款失败或触及支出上限而拒绝启动作业时，检查以 `failure` 结束但**一个步骤都没跑**，两道门禁此前只看结论，于是交付被一个与代码无关的原因永久卡住。现在 `pr-gate` 判定前先向 GitHub 问该检查是不是它自己拒绝启动的：只有同时满足「检查带 job 链接」「该 job `steps` 为空」「注解确为 GitHub 的拒绝文案（account payments / spending limit / Billing & plans）」才豁免；没有 job 链接、跑过任何步骤、注解或作业读不到一律照旧按失败处理（工作流无法伪造：打印注解必须跑步骤）。验收适配器对「全部作业都没启动」的 run 放行通用 CI criteria，并把拒绝事实写进证据 `source.infrastructure{reason,message,jobs}`；**声明 environment 的 criteria 永不豁免**——环境是部署事实，从未启动的 run 证明不了任何部署。同时按老板指示简化员工提示词：`src/flows.ts` 与 `agents/engineering.md` 不再要求员工确认 PR 的 CI 通过、等 CI 发布完成或复核 CI，门禁只保留在公司系统里。CI 两个工作流因计费仍未启动，如实记录，未改账单、未动检查状态。`fcbc828` 验收：根/插件 typecheck 退出 0；test:comm 19 通过/1 跳过；test:service 53 通过/0 失败；test:bridge 1079 通过/58 跳过/0 失败；新增用例覆盖豁免与三个负例（跑过步骤的作业、不含计费文案的注解、声明 environment 的 criteria 均仍拒绝）；两道本机发布门禁 comm-slow-pipe 与 sidecar-review 在 bun 1.4.2 下 pass。上线后用**生产代码**对 PR #1713 的真实计费拒绝数据实测：插件面 `createSubmitCheck` 返回 head 而非拒收；核心适配器对通用 CI criteria 返回 `ok` 并记 `source.infrastructure{reason:billing}`；对声明 `production` 的同一 run 仍拒绝；对照（不向 GitHub 询问）仍以「CI 未通过（channel、quality）」拒收——豁免只在真的读不到拒绝时失效，方向安全。上线后 MCP 进程 `state = running`，插件已重指到新 release，派工 tick 持续（10:05:37Z 仍有 owner notice 落库）。

## 远程 VPS 授权（remote grant）

给远程 VPS 上的 AI 发一次性兑换码：VPS 用它换到某个测试账号的 IdP token（access ≤1h、refresh 可续期、绝对期 ≤31 天），读写测试 workspace 并可直接写/发布平台内容。VPS 不拿任何数据库/root 凭证；checkpoint/submit 仍走本地。

### 配置

`admin project broker <project> <env> <file.json>` 的 broker 配置加 `remote` 块（写入时校验）：

```json
{ "remote": { "clientId": "<remote public client_id>", "testManagerAlias": "QA_MGR", "codeTtlHours": 168 } }
```

`testManagerAlias` 是已建好的运营账号别名（有 test.manage 能力，经 `PLATFORM_OPERATOR_TEST_MANAGERS` 或 ops API 授予）。`codeTtlHours` 兑换码有效期，默认 168h、上限 168h。

### 命令

```bash
# 签发（url 只打到 stdout 一次，含一次性码，绝不写审计/日志/密封库）
pnpm run admin remote-grant issue <taskId> --alias QA_X [--days 30] [--content] [--env production] [--attach]
# 撤销（--purge 同时清测试主体/到期账号）
pnpm run admin remote-grant revoke <grantId|--task <taskId>> [--purge]
pnpm run admin remote-grant list [--task <taskId>]
```

- `--alias`：测试账号别名；若对应 IdP 用户已存在且非测试账号（`expires_at IS NULL`）会拒绝，防止误伤正式账号。
- `--content`：给测试主体授 `content.read/submit/publish`，可直写/发布平台内容。
- `--attach`：把「远程会话说明块」（链接 + `bun scripts/remote-session.ts redeem '<链接>'` 用法）追加到任务 `context`；注意该块持久化且含一次性码明文（码一次性、TTL ≤7 天）。

### 生命周期

签发时 IdP `users.expires_at = now+days`（已有更晚值取 max、封顶 31 天）、`test_origin = taskId`；测试主体创建的 workspace 自动标记同到期。到期后 IdP 每日 cron 删账号、origin reaper 每 6h 删 workspace 库与索引；平台内容保留。撤销：`revoke` 置 grant revoked（remote 族 refresh 重放亦触发整 grant 撤销）；`--purge` 再立即清测试主体并把账号到期设为 now 交给 IdP cron。

### 红线

- 链接只发给老板独占的 VPS；码一次性，泄露即失效但也等于让渡该测试账号权限到 TTL。
- 派工调度目前不支持远程主机 Paseo 会话（`src/dispatcher/host.ts` 仅本机资源、`src/dispatcher/paseo.ts` 仅本机插件），故不做自动 issue + wake 注入，用 `--attach` 显式写入任务 context。
