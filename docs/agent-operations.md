# 公司运行手册 v3

## 组成

| 组件 | 位置 | 作用 |
|---|---|---|
| 任务服务 | 远端 `data.maplayer.top/sck-mcp`（Caddy→`127.0.0.1:38473`，gate token），本机 launchd `org.surrealck.company-mcp` 兜底并兼跑 GitHub 投影 | 任务、租约、审计、目标、关口；admin/owner 通道 |
| 调度器 | Paseo 插件内（`plugin/server/dispatch.ts` tick 循环） | 不消耗模型 token：读队列、叫醒/新开员工、收回并改派、订阅健康、老板通知 |
| 员工通道 | Paseo 插件内 `plugin/server/sidecar.ts`（每实例一个） | 代持实例凭证、代领任务、自动续租、relay `sck call`、回收 `report.md`/`blocker.md` 为提交/阻塞；把 `ops_*` 转给运维代理。架构与排障详见 [sidecar 通道](sidecar-channel.md) |
| 运维代理 | Paseo 插件内 `src/ops/`（`OpsBroker`，由通道调用） | 持有密封凭证与 Cloudflare/IdP 权限，替员工建账号、建 workspace、管成员、登录、调产品接口、查 workspace 数据、给浏览器登录；员工只拿会话句柄，见下文「运维代理」 |
| 员工 | Paseo 会话 | 按 [协议](../agents/PROTOCOL.md) 执行、写 `.sck` 交付物；进程内无任何凭证，环境里的凭证变量在 spawn 前被清空 |
| 数据 | SurrealDB `sck_agent_company/control_plane` | 唯一事实来源 |

数据位于**产品同一台自托管 SurrealDB**（连接地址与 root 凭证读自 `SCK_PRODUCT_ENV` 指向的产品 `.env`，当前 `wss://data.maplayer.top/rpc`）；公司数据独占 `sck_agent_company` namespace / `control_plane` database，与产品 `main` namespace 隔离。换库或换实例改 `service.env` 的 `SCK_COMPANY_NS` / `SCK_COMPANY_DB` 或 `SCK_PRODUCT_ENV`。

服务目录：`~/Library/Application Support/SurrealCKCompany/`（`active` 指向固定发布目录；`private/` 为配置与凭证，0700；`logs/` 为日志）。安装、启停：发布目录内 `sh scripts/company-service.sh install|status|restart|stop|uninstall`，默认只管理 `mcp`（任务服务 + GitHub 投影）。调度器、员工通道和运维代理都跑在 Paseo 插件 `sck-company` 里，改了 `plugin/` 或 `src/` 后用 `$PASEO_CLI plugin reload sck-company` 重载（不要重启 Paseo 守护进程）；**不要再装 launchd 的 dispatcher**（`SCK_COMPONENTS=dispatcher` 仅为旧部署保留），否则会和插件重复派工。服务依赖本机 Paseo、SurrealDB、网络与 GitHub 登录；Mac 合盖或关机时公司暂停。

## 老板入口

三种方式等价，都会写入 `owner_command` 表，由调度器（或命令行本身）执行：

1. **命令行**（在发布目录 `~/Library/Application Support/SurrealCKCompany/active` 下）：

   ```
   pnpm run company goal "我要一个 B2C 商城"
   pnpm run company goal --tier quick --project surreal_ck "导出按钮在 Safari 下无效"
   pnpm run company inbox
   pnpm run company approve <任务ID> [意见]
   pnpm run company reject <任务ID> <意见>
   pnpm run company reply <任务ID> <回答>
   pnpm run company direction "先服务律师团队"
   pnpm run company pause | resume | status
   ```

2. **直接写 SurrealDB**（`sck_agent_company/control_plane`）：

   ```sql
   CREATE owner_command CONTENT { kind: 'goal', text: '我要一个 B2C 商城' };
   CREATE owner_command CONTENT { kind: 'goal', tier: 'quick', project: 'surreal_ck', text: '导出按钮在 Safari 下无效' };
   CREATE owner_command CONTENT { kind: 'approve', task: '<任务ID>', text: '同意' };
   CREATE owner_command CONTENT { kind: 'reject', task: '<任务ID>', text: '需要修改：…' };
   CREATE owner_command CONTENT { kind: 'reply', task: '<任务ID>', text: '回答：…' };
   CREATE owner_command CONTENT { kind: 'direction', text: '公司方向…' };
   CREATE owner_command CONTENT { kind: 'pause' };   -- 或 'resume'
   ```

   执行结果回写在同一行的 `status`（applied / failed）和 `result`。

3. **在 Paseo 里直接和经理说**：经理用 `create_goal` / `set_direction` / `record_owner_decision` 转录，并逐字记录你的原话，审计来源为 `gm-relay:<经理编号>`。

不指定 `tier` 时目标先处于「待分级」：Jev 高置信时直接选定 quick / standard / program，否则经理 `triage_goal`。quick 目标完成后只记录结果，不进老板收件箱；standard / program 只在 G3 找老板。

## 项目环境与凭证

项目环境告诉员工一个仓库怎么发布、在哪验证、哪些是红线；领取任务时随 `project` 字段下发（目标创建时用 `--project` 关联）。

```
pnpm run admin project set project.json                           # 写入或更新
pnpm run admin project list                                       # 查看（含凭证名，不含值）
pnpm run admin project broker surreal_ck production broker.json   # 配置该环境的运维代理（见下节）
printf '%s' "$VALUE" | pnpm run admin secret set surreal_ck production SOME_NAME - "用途"   # 角色写 - 表示无
```

`project.json` 结构：`{ id, name, repoPath, defaultBranch, release, rollback, redLines[], runbooks[], notes, envs: [{ name, url, healthUrl, verify }] }`。

凭证存在 `env_secret` 表，值用 AES-256-GCM 加密；密钥只在本机登录钥匙串（服务 `surreal-ck-company`，账号 `env-secret-key`，首次写入凭证时自动生成）。**员工读不到任何凭证值**：`get_secret` / `put_secret` 已下线（调用得到 `unknown_tool` 和指向运维工具的提示），claim 不再下发 `secrets`，`project` 只列凭证名。值只由运维代理在插件进程内解密使用。测试账号的密码 `<别名>_PASSWORD` 由运维代理在 `ops_account_ensure` 时生成并直接密封，不需要手工登记；沿用旧的 `QA_PASSWORD`（对应别名 `QA`）也行。部署密钥不放这里：代码发布走各仓库的 CI（例如 surreal_ck 的 SSH 部署密钥只在 GitHub `production` Environment）。

安全边界：员工、插件和老板命令行跑在同一个系统用户下。这套机制去掉的是「交到员工手里的凭证」和「继承进员工环境的凭证变量」，它不是沙箱：员工进程在操作系统层面仍读得到同用户可读的文件（产品 `.env`、服务 `private/`、钥匙串）。越界读取违反协议、会留在会话日志里，但不会被技术阻止；要强隔离需把员工会话放进独立系统用户或容器。数据库 root 与老板命令行没有密码学隔离；老板身份靠审计来源和协议约束，不是防伪机制。

## 运维代理（ops broker）

员工需要账号、workspace、登录这类凭证才能做的事，不自己动手，向插件里的运维代理（`src/ops/broker.ts`）提出请求：员工 `sck call ops_*` → 会话私有通道（req/res 文件）→ 通道把请求绑定到当前租约的任务 → `OpsBroker` 校验后执行 → 脱敏结果原路返回。员工用法见 [协议](../agents/PROTOCOL.md) 的「运维工具」，通道细节见 [sidecar 通道](sidecar-channel.md)。

能力：`ops_info`、`ops_health`、`ops_account_ensure`（建/修测试账号）、`ops_login`（按账号别名登录，得客户会话句柄；`audience:"ops"` 时经 `idp.ops` 公共客户端直连 IdP `/token` 换出运营会话，不列 workspace、不自动建账号）、`ops_operator_login`（按别名登录运营通道：独立 OIDC client、运营 audience、PKCE 公开客户端经 `/api/auth/ops/token` 兑换；登录时以 `GET /api/ops/quota/context` 实时校验运营身份）、`ops_workspace_ensure`、`ops_member_list|add|remove`、`ops_request`（以会话调产品 HTTP 接口；运营会话只许 `/api/ops/*`，客户会话不许 `/api/ops/*`）、`ops_query`（以会话在 workspace 库里查询）、`ops_browser_login`（把客户会话注入员工的 ego-browser 任务空间）、`ops_logout`。新增能力只需：在 `src/ops/` 实现，登记到 `OPS_TOOLS` 与 `OpsBroker` 的处理表，补测试（`tests/ops-broker.test.ts`，用 `tests/support/ops-world.ts` 的假 IdP/产品/D1），在协议表里加一行，再 `sh plugin/scripts/vendor.sh` 并 `plugin reload`；通道不用改，工具清单自动并入。

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

## 员工编制（SurrealDB）

- **员工定义** `employee_def`：`role`（八任务岗位 + `eval` 评审）、`provider`（codex / grok / devin）、`model`、`thinking`，可选 `max_instances`（默认 1）、`weight`（派工权重，默认 10）、`enabled`、`tracks`（岗位轨名单：非空则只接 `discipline` 在列的任务，缺省或空 = 全接）。可直接写库，例如：

  ```sql
  UPSERT employee_def:engineering-grok CONTENT { role: 'engineering', provider: 'grok', model: 'auto:grok', thinking: 'medium', max_instances: 2, weight: 25 };
  ```

  `model` 是槽位而非钉子：`auto:<族>`（`auto:sol` / `auto:grok` / `auto:swe`）表示跟随该 provider 该模型族的最新版——Paseo 插件每 5 分钟经 `providers.listModels` 刷新 `company_meta:model_slots`，调度器在派工前把槽位解析成具体模型 id（如 `auto:sol → gpt-6.1-sol`）再 spawn。厂家发布 `gpt-6.2-sol` 后：槽位更新 → 当 tick 先退役空闲旧模型实例（忙碌中的跑完当前会话）→ 下一个任务用新模型起新会话，全过程零人工。字面量（如 `gpt-6.1-sol`）则 pin 死。跨族/改名（`gpt-7`、新命名线）不会被 auto 匹配，等人工决策；槽位解析失败时该 def 不可新开并给老板发通知，存量实例继续跑上次的模型。首次采用新版本时插件发一条告知通知（不需要批准）。

  或 `pnpm run admin def set|list|weight|tracks|enable|disable`、`pnpm run admin seed-defs`（写入默认 27 个定义：九岗位 × 三订阅）。`def tracks <id> <轨,轨|->` 限定编制的岗位轨；`def set` 不带轨参数，不会清掉已设的 tracks。也可在 Paseo 编制页用「注册员工」表单：岗位/provider/模型/thinking 全部下拉自 Paseo 实时数据（`providers.snapshot` + `listModels`），服务端注册前再校验一遍，杜绝手填错字。def id 自动取 `<role>-<provider>`。

- **派工权重**：同岗位多个合格候选（空闲实例或可新开的定义）按 `weight × 绩效系数` 加权随机选取；`weight=0` 不会被主动选中（同岗位所有候选都是 0 时才均匀分配）。绩效系数 = `clamp(avg_score/3, 0.3, 2)`，尚无评分时为 1。调权：`pnpm run admin def weight <id> <n>`，或直接改 `employee_def.weight`——下一轮 tick 生效，无需重启。

- **绩效评分**：任务进入 done 后进入评审。默认走 **Jev**（TypeSafe System One 决策模型）：调度器进程内一次 HTTPS 调用（约 70–500ms，每任务一次往返），把任务审计时间线和行为指标作为 state，让 Jev 对每位参与者打 1–5 分 × 5 维度（quality / evidence / discipline / timeliness / overall），同时返回逐题**校准置信度**与概率分布，写入 `scorecard`（`judge='jev'`）并滚动更新 `avg_score`。
  - Jev 不信任自己拿不准的判断：任一题 confidence < `jev_min_confidence`（默认 0.7）→ 不记分，任务升级给 `eval` 岗位的 LLM 评审员做深审；Jev 调用连续失败 3 次（`eval_attempts`）同样升级。
  - Jev 对每位参与者另问一条风险 noul：概率 ≥ `jev_flag_threshold`（默认 0.65）→ scorecard 标 `flagged` 并给老板收件箱写一条提醒（是否弹窗再由 Jev 分诊）。
  - `eval_engine`：`auto`（默认，Jev 优先、LLM 兜底）/ `llm`（只用 LLM 评审员）/ `jev`（只用 Jev，低置信度也记录）。
  - 没有 Jev key 时整条 Jev 通道自动关闭，行为与原来一致（LLM 评审员兜底）。
  - 查看：`pnpm run admin scores [任务ID]`、`pnpm run company status`。关闭评审：`pnpm run admin config eval_enabled false`。
- **员工实例**：`employee` 表中带 `def` 的记录，由调度器按需生成；`paseo_agent_id` 登记实际会话，是实例身份的权威绑定。新实例的凭证不落盘——由插件 sidecar 在内存中代持，`spawn` 环境只注入 `SCK_COMM_DIR`/`SCK_COMM_KEY`；`claim`/续租/提交由 sidecar 以该凭证程序化执行，agent 进程拿不到也不认识它。`retired=true` 或凭证撤销后所有调用即 401，实例随会话关闭退役。同一定义连续 3 次异常会自动停用并通知老板。`pnpm run admin inst list` 查看。
  旧的凭证文件会话（`credential_file` 非空的实例）继续按原方式收尾，但不再被通道代领新任务，自然淘汰。
- 旧员工（gm-01 等）以 `admin bind <员工编号> <agentId> <def>` 挂到定义上，继续保留身份和历史。

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
| `eval_enabled` | true | 任务完成后是否自动评审打绩效分 |
| `eval_engine` | auto | `auto`=Jev 优先 LLM 兜底；`llm`=只用 eval 员工；`jev`=只用 Jev |
| `jev_min_confidence` | 0.7 | Jev 单题置信度下限，低于则升级 LLM 评审（auto） |
| `jev_flag_threshold` | 0.65 | Jev 员工风险标记阈值，达到则提醒老板 |
| `jev_notify_triage` | true | 系统提醒是否先经 Jev 分诊再决定弹窗（提醒始终进收件箱） |
| `jev_decisions` | true | Jev 是否参与目标分级、上线决定、老板升级路由（拿不准时交经理/运营） |
| `jev_release_threshold` | 0.8 | 上线申请「可以上线」概率 ≥ 该值且「触碰红线」≤ 1 − 该值时自动批准 |
| `jev_owner_threshold` | 0.3 | 升级给老板的问题「必须老板决定」概率低于该值时改派经理（每任务一次） |

## 排障

- 调度日志：`logs/stdout-dispatcher.log`、`logs/stderr-dispatcher.log`；只在有变化时写入一行 `tick {...}`。
- 订阅状态：`pnpm run company status`，或查询 `SELECT * FROM provider_health`。
- 手动让某订阅立即重试：`UPDATE provider_health:<provider> SET until = 0;`（下一轮只派一个探测任务）。
- 任务历史：经理员工 `get_task_history`，或查询 `SELECT * FROM audit WHERE task = task:<id> ORDER BY at`。
- 绩效记录：`pnpm run admin scores [任务ID]`；员工定义均分 `SELECT id, weight, avg_score, scored FROM employee_def`；想给某任务重新评审：`UPDATE task:<id> SET evaluated_at = NONE;`。
- **Jev 接入**：在 `private/service.env` 加 `JEV_API_KEY`（也可用 `TYPESAFE_API_KEY`）即启用；可选 `JEV_BASE_URL`（默认官方 `https://api.typesafe.ai/v1/systemone`，托管计费网关为 `https://jevtypesafeai.com/api/v1/decide`）、`JEV_MODEL`（默认固定 `jev-1.13.0`，避免阈值漂移）。key 从 TypeSafe 早期访问 waitlist 或托管网关获取。验证连通性：`pnpm run admin jev-test`。Jev 不产生文本输出，scorecard 的 `notes` 为空，判据与置信度在 `probabilities`/`confidence` 字段。
- devin 订阅不接受 `thinking=low`（`paseo run` 报 AGENT_CREATE_FAILED）；devin 定义请用 medium/high。定义连续 spawn 失败 3 次会自动停用，修正后 `pnpm run admin def enable <id>` 恢复。
- 不想让某类员工再接任务但保留定义：`pnpm run admin def weight <id> 0`（软停用，全部候选为 0 时仍可能兜底）；彻底停用用 `def disable <id>`。

## v2 归档

`scripts/queue.py`、`agents/registry.json` 与 GitHub 标签队列只用于收尾 v2 旧工单（#23、#28 等），新工作一律进入任务服务。启动任务 #3—#16 已由老板决定取消。

## 上线记录

- 2026-09-28：v3 上线，发布 `af63565`（`releases/<sha>`，`active` 指向当前版本）。写入 18 个默认员工定义；gm-01、product-01、eng-01、eng-02、ai-01、qa-01、cs-01 挂到各自的 `*-codex` 定义上，身份与历史保留。旧 Paseo 定时巡检 `d747edb8` 已到期，额度巡检 `cc85bb8f` 已暂停，由调度器取代。启动任务 #3—#16 已按老板决定取消（not planned）。
- 演练 A（GitHub #34）：调度器派 qa-01 执行 → checkpoint → submit → 自动派 eng-01 独立验收 → done。
- 演练 B（GitHub #35）：codex 并发临时设为 0，调度器按定义新开 `cs-grok-9d59da`；它存下 ALPHA 进度后会话被强制归档。约 25 秒内调度器退役该实例并撤销凭证、收回租约并附交接包、新开 `cs-grok-580043` 接手；接手者读到 ALPHA 与交接包，跳过已完成步骤存下 BETA 并提交；`qa-grok-5dfd5a` 独立验收通过。旧凭证调用返回 401。
- 未在真实环境演练的路径：真实订阅额度耗尽（错误文本分类、冷却与探测恢复由集成测试用模拟网关覆盖），所有订阅耗尽时的充值提醒。
