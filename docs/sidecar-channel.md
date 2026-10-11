# 员工 sidecar 通道架构与运维（v3）

员工会话不持有任何凭证。Paseo 插件 `sck-company` 里每个员工实例对应一个 **sidecar**（`plugin/server/sidecar.ts` 的 `SidecarPool`）：实例凭证、租约证明和续租都留在插件进程内，员工只看到一个会话私有的 **comm 目录** 和一把会话密钥，所有任务服务调用经 `sck call` 由 sidecar 代为执行。需要账号、workspace、生产登录这类凭证能力的 `ops_*` 调用，再由 sidecar 转给同进程的运维代理 `OpsBroker`（`src/ops/broker.ts`）执行。

```
调度器 ──spawn(wake)──▶ Paseo 员工会话（env: SCK_COMM_DIR, SCK_COMM_KEY）
   │                        │ sck call ──▶ req/<id>.json
   │                        ▼                    │
   └─▶ SidecarPool ◀─ sweep(400ms) ──────────────┘
        │  ├─ CompanyCore：claim / heartbeat / checkpoint / submit / review / block
        │  └─ OpsBroker（ops_*）：租约门 → 岗位门 → 配额 → 执行 → 脱敏 → 审计
        └─▶ res/<id>.json ──▶ sck 输出到会话
```

## 员工零凭证模型

凭证从铸造到撤销全程不进入员工进程：

- **铸造**：`Workforce.spawnInst` 调 `EnrollmentAdmin.enroll` 生成不透明 token（`sck_<32 字节>`），库中 `employee.credential_digest` 只存其 SHA-256；token 本体只返回给调用方（插件），不落盘、不进环境变量。
- **代持**：sidecar 把 token 放在进程内 `creds` map。员工 spawn 环境只注入 `SCK_COMM_DIR` 和 `SCK_COMM_KEY`（`sidecar.env`）；唤醒已有会话（`paseo send`）不再注入任何环境。
- **代领**：任务在叫醒员工之前已由调度器调 `sidecar.claim` 以实例凭证领取，`claim.json` 写进 comm 目录作为任务上下文；`claim_next` 在员工侧直接返回 `forbidden`。
- **续租**：sidecar 每 60s 用持有的凭证调 `core.heartbeat`（`HEARTBEAT_MS`）；员工调 `heartbeat` 是 no-op。
- **轮换**：插件重启或 `adopt` 重建时内存凭证丢失，`credentialFor` 经 `workforce.rotate` 重签——库中 digest 被换掉，旧 token 立即作废（`retired`/`revoked` 实例在此处失败）。
- **撤销**：实例退役或凭证撤销后所有调用 401；`credential_file` 非空的旧凭证文件实例不再被 sidecar 代领新任务，自然淘汰。
- **环境清场**：员工进程是 Paseo 守护进程的子进程，会继承其环境。`agent.session_open` 钩子（`plugin/server/scrub.ts`）把继承来的基础设施凭证变量清空（`CLOUDFLARE_*`、`CF_API_*`、`SURREAL*`、`JEV_*`、`TYPESAFE_*`、`SCK_OPS_*`、`SCK_PRODUCT_ENV` 等，`SCK_SCRUB_ENV` 可加名），并把公司员工会话的 `ZDOTDIR` 指向垫片目录，使交互式 zsh 重读启动文件后再 `unset` 同名变量。provider 登录变量（`OPENAI_API_KEY` 等）、`SSH_AUTH_SOCK`、`gh` 登录不动。
- **边界**：这套机制去掉的是「交到员工手里的凭证」和「继承进员工环境的变量」，不是沙箱——员工与插件、老板命令行跑在同一系统用户下，仍能读同用户可读的文件；越界读取靠协议约束与会话日志留痕。要硬隔离需独立系统用户或容器。详见 [运行手册](agent-operations.md#项目环境与凭证) 的安全边界段。

## comm 文件协议

每个实例一个目录：`$SCK_COMM_DIR` = `<服务目录>/comm/<员工编号>/`（根可用 `SCK_COMM_ROOT` 覆盖），插件启动时 `ensureCommDirs` 建出 0700 的 `req/`、`res/`。

| 文件 | 写者 | 含义 |
|---|---|---|
| `claim.json` | sidecar | 代领结果：任务详情、project、`history`、`predecessors`、`deliveryId`/`fence`/`leaseExpiresAt`；每次新领取原子覆盖 |
| `req/<id>.json` | 员工（经 sck） | `{ key, tool, args }`：`key` 是环境里的 `SCK_COMM_KEY`，`tool` 为工具名，`args` 为 JSON 参数 |
| `res/<id>.json` | sidecar | `{ ok: true, data }` 或 `{ ok: false, error: "<code>: <message>" }`，文件名与请求同名 |
| `report.md` | 员工 | 交付说明；回合结束（`agent.turn_ended`）时 sidecar 将其内容作为 submit 证据提交 |
| `blocker.md` | 员工 | 阻塞说明；同上时机作为 `report_blocker`（固定 to=gm）提交，优先级高于 report.md |

调用路径：员工执行 `sck call <tool> '<json>'`（`bin/sck` → `src/mcp/client-cli.ts`）→ 存在 `SCK_COMM_DIR` 时进入 comm 模式：原子写 `req/<时间戳>-<随机>.json`（`writeFileAtomic`，先写 `.tmp-<pid>` 再 rename），然后每 200ms 轮询 `res/` 同名文件，读到即打印 `data` 到 stdout 退出 0；`ok:false` 打 `error` 到 stderr 退出 1；120s 无响应报 `comm request timed out`。`sck list` 等价于 `call __list__`，返回基础工具加当前可用的 `ops_*` 清单。

sidecar 侧每 400ms（`SWEEP_MS`）扫一遍活跃实例的 `req/`：读到的请求文件立即删除（一次性消费），校验 `key` 与本次 spawn 签发的 `SCK_COMM_KEY` 一致——不一致回 `stale comm key; this session predates a plugin restart`（key 只在本进程内存，插件重启 adopt 后没有可比对的旧 key，该校验自然放开），然后按工具名分发：

- **写工具注入租约证明**：`checkpoint` / `submit` / `review` / `report_blocker` 不需要、也不接受员工传租约字段；sidecar 用在手租约组装 `LeaseProof`（`taskId`、`deliveryId`、`fence`、`expectedVersion`），每次写成功后用返回的任务 `version` 刷新 `expectedVersion`（乐观并发）。
- **消耗租约的写**：`submit`、`review`、`report_blocker` 成功后 `endLease`——停止续租、删除 live claim、释放该实例全部 ops 会话。`checkpoint` 不消耗。
- **读与管理工具**：`get_context`、`get_task_history`、`create_task`、`create_goal`、`triage_goal`、`create_delivery`、`record_owner_decision`、`set_direction`、`resume_task`、`defer_task_until`、`retire_task`、`record_score` 直接转发 `CompanyCore`，权限仍在服务端按凭证的岗位能力裁决。`task_project_update`（gm 专属，manage 能力）把 blocked 任务换绑登记项目；`bind_task_code_repo`（gm 专属）给 blocked 执行阶段任务显式绑定代码仓库——只影响 worktree 分配与下发 `cwd`/`repoHome`，业务项目（opsScope/claim.json.project）不变，目标限 opsRepo 或已登记项目仓库，规范化后拒绝 symlink/遍历逃逸与未登记路径。`retire_task`（gm/product，manage 能力）把任务置为终态 `void`：释放任何在持租约、清掉持有人的 `active_task`，并在同一事务内让 blocked 的下游重新评估依赖（`void` 视为已满足），只等被作废任务的链条当场解锁；重复作废幂等，`done` 任务拒绝。owner 关口例外：`reviewer_role='owner'` 的任务（原型 demo、验收 gate）作废不算批准，其下游不解锁且新建引用它的依赖仍视为未满足；该任务还有存活下游时退役被拒，须先把下游退役。锚点豁免：goal `anchors` 里的汇总锚点（运营验收/终验 gate）不算存活下游、其就绪评估把任何 `void` 依赖都视为已满足，否则退役 owner 关口原型会被锚点依赖永久锁死。
- **`ops_*`**：转运维代理，见下节。
- **`deliverable_publish`**：本地实现不转 core——把 `{files:[绝对路径…]}` 的文件/目录复制进 `$SCK_SERVICE_HOME/deliverables/<taskId>/`（目录递归保结构、隐藏名跳过、同名覆盖、symlink 解引用），返回 `{taskId,dir,baseUrl,urls,skipped,conflictPolicy}`，`urls` 为 `http://<lanIP>:<port>/d/<taskId>/…` 可点链接（lanIP/端口取 `preview-status.json` 实际监听，缺省 `SCK_PREVIEW_PORT`/18777）。taskId 缺省取在手租约任务，显式传值供经理代发/补发（免租约）；任一输入路径无效即整体报错，不产生半截交付包。
- **特殊**：`claim_next` 回 `forbidden`（任务已代领）；`heartbeat` 回 `{ok:true}`；`get_secret`/`put_secret` 已下线，回 `unknown_tool` 并提示改用 `ops_*`；其余未知名回 `unknown_tool`。请求 JSON 解析失败回 `malformed request`；无在手租约时写工具回 `no_lease`。

交付物回收：回合结束钩子调 `settle`，把 `report.md`/`blocker.md` 内容哈希与 claim 时记下的哈希对比——**领取前已存在的陈旧文件永远不会被当成提交**；一致或未变则不动作。提交成功后文件改名 `report.md.done-<ts>`；失败改 `.failed-<ts>`；无租约时残留的交付物改 `.orphaned-<ts>`。blocker 优先于 report；`blocker.md` 只能阻塞到 gm，要 owner 须显式 `sck call report_blocker '{"to":"owner",...}'`。spawn/wake 失败时调度器调 `releaseClaim` 以「【通道回滚】」退回任务；员工会话被归档时 `detachAgent` 丢弃绑定与内存凭证，租约自行到期。

## ops_* 运维工具边界

`ops_*` 不是给员工的凭证，而是「按名字请求一次受控操作」。链路：员工 `sck call ops_*` → sidecar **丢弃员工自带的 `taskId`**，改用在手租约的任务 → `OpsBroker.call` 每次用 `core.opsScope` 重新核验该租约（项目取自任务所属目标）→ 选环境（`env` 参数；缺省取唯一环境或 `production`）→ 岗位门（`broker.roles`，缺省 qa/engineering/product）→ 执行 → 脱敏返回。

| 工具 | 边界 |
|---|---|
| `ops_info` / `ops_health` | 不需要会话；只回非敏感配置（账号别名、前缀、配额）与探活结果 |
| `ops_account_ensure` / `ops_login` / `ops_logout` | 密码由代理生成、密封入库、只在代理侧使用；`ops_login` 返回的是不透明会话句柄 `s_<16hex>`，不是 token |
| `ops_workspace_ensure` / `ops_member_*` | slug 必须以项目 `workspacePrefix` 开头；成员按账号别名解析 |
| `ops_request` / `ops_query` | 以会话身份调产品 HTTP / 在 workspace 库执行 SurrealQL；响应经脱敏与限长（100K） |
| `ops_browser_login` | 把会话注入员工自己的 ego-browser 任务空间：客户会话落产品 `/`（原 `oidc.access_token`/`oidc.exp` 键）；运营会话落 `/ops/` 并按 ops 控制台 oidc-client-ts `UserManager` 契约写序列化 `User` 记录，注入前重探运营身份；`ops` audience 会话禁止注入 |
| `ops_idp_client_info` | 只读查看 IdP 已登记公开 client 的公开元数据（client_id、redirect、audience、consent_policy 等）及与代理配置的一致性；不返回任何密钥材料 |

- **会话**：仅存内存，按（员工、项目、环境）隔离，每员工最多 8 个、最长 6 小时；token 临过期自动重登。租约结束、会话归档、插件重启即全部失效，跨任务不复用。代理没有删除账号/workspace 的能力。
- **配额**：项目内按审计行统计最近 24h 新建数，超限回 `limit_reached`。
- **审计**：账号创建/修复、workspace 创建/进入、成员增删、登录、浏览器登录写实名 `audit` 行并进交接历史；只读调用与 `ops_request`/`ops_query` 记 `ops_call`，不进交接历史。
- **脱敏**：返回与审计文本都抹掉 token 字段名、JWT/Bearer/密码形态串，以及该员工全部在存会话 token；上游错误只透出机器码。
- **错误码**：`invalid`（参数）、`forbidden`（岗位/权限）、`not_configured`（环境未配代理或缺 D1/data/Cloudflare 凭证）、`not_found`、`limit_reached`、`conflict`、`login_failed`、`upstream_error`（超时/断连/5xx，`retryable`）。
- **扩能**：新能力在 `src/ops/` 实现并登记 `OPS_TOOLS` + 处理表 + 测试，协议表加一行，`sh plugin/scripts/vendor.sh` 后 `plugin reload`；通道无需改动。详见 [运行手册](agent-operations.md#运维代理ops-broker)。

## deliverables/ 交付包约定

员工用 `deliverable_publish` 发布给老板看的产物，落点为 `$SCK_SERVICE_HOME/deliverables/<taskId>/`，经插件内嵌预览服务 `/d/<taskId>/…` 路由以 LAN URL 呈现（无鉴权，局域网口径）；`evidence/<taskId>/` 则对应 `/e/` 路由（收件箱附件自动枚举呈现）。证据文本里给老板点开的链接必须来自 `deliverable_publish` 的返回 `urls`，本地路径与 `file://` 不算交付。

## 排障

- 员工侧 `sck call` 报 `comm request timed out`：插件未运行或 sidecar 未接管；确认 Paseo 插件已加载（`plugin reload sck-company`）。
- `stale comm key`：会话环境里的 key 与当前 spawn 不符，一般是插件重启后旧会话仍在写 req；该会话的租约状态以服务端为准。
- `no_lease`：租约已被收回/消耗（提交后、被改派后），先重读 `claim.json` 与任务状态。
- comm 目录残留 `.failed-`/`.orphaned-` 文件：分别是提交失败与无租约残留的交付物归档，看审计与插件日志定因。
- 插件日志（Paseo 插件进程 stdout）有 `sidecar claimed|submitted|blocked|adopted|releaseClaim`、`scrub <agentId>`、`heartbeat failed` 等行；任务侧看 `audit` 表。
