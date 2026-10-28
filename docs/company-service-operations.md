# 本机公司任务服务运维与员工接入（#27）

## 固定版本和边界

本服务从 #24 核心 `7fc39c3`、#25 adapter `5f06b793` 集成，另纳入 [#29 官方 MCP 接入准备](./mcp-integration-preparation.md)和 [#26 QA 验收矩阵](./qa/mcp-company-acceptance.md)。代码发布为独立只读版本目录；运行中的 `active` 链接仅指向已提交、已安装依赖的 release，不指向工程或 QA worktree。服务权威是 SurrealDB 独立 `sck_agent_company/control_plane`；新建任务投影为带 `sck-company-task` marker 的 GitHub Issue。旧 #23—#29 的 v2 票仍由中央 `scripts/queue.py` 管理，不能用新 MCP 修改。

## 私有目录和进程

默认服务目录：`~/Library/Application Support/SurrealCKCompany`，权限 0700。目录结构：`releases/<commit>/` 为固定程序与 pnpm 依赖，`active` 为当前版本链接，`private/service.env` 为 0600 的路径/端口配置，`private/credentials/*.token` 为各员工独立 0600 文件，`private/gh-projection.json` 为 0600 持久投影进度，`logs/` 为仅本人可读日志。root 密码仅由现有产品 `.env` 在进程内加载；日志、Issue、客户端和提交不携带其值。

用户级 launchd label 为 `org.surrealck.company-mcp`（任务服务）与 `org.surrealck.company-dispatcher`（v3 调度器，同一发布目录）。脚本 `scripts/company-service.sh` 默认只操作 `mcp`；v3 的调度器已迁入 Paseo 插件 `sck-company`（连同员工通道与运维代理），不要再装 launchd 调度器，否则会重复派工。`SCK_COMPONENTS=dispatcher`（或 `"mcp dispatcher"`）仅为旧部署保留；安装时同时把员工工具 `bin/sck` 复制到服务目录。旧版 launchd 调度器需要 `private/service.env` 中的 `SCK_AGENT_CWD`（员工工作目录，运营仓库 checkout），可选 `SCK_PASEO_BIN`、`SCK_NOTIFY=0`（关闭 macOS 通知）。Plist 位于 `~/Library/LaunchAgents/org.surrealck.company-<组件>.plist`，`KeepAlive` 在进程异常退出后重启。停止后不会删除数据库、凭证、日志或发布目录。卸载只去掉本服务 plist 与进程，不动数据。

发布按下文双面流程先固定集成提交、生成快照并安装依赖。首次安装才由获授权的配置管理方将 `.env.example` 复制到上述 `private/service.env`，登记现有产品 env **路径**、空闲端口、GitHub 仓库和私有 GM 凭证**路径**，文件权限 0600；后续发布沿用现有私有配置，不复制覆盖或读取凭证。`rtk proxy sh scripts/company-service.sh install '/absolute/release/path'` 安装并立即启动。常用命令（在任意固定版本目录执行）：

```sh
rtk proxy sh scripts/company-service.sh status
rtk proxy sh scripts/company-service.sh restart
rtk proxy sh scripts/company-service.sh stop
rtk proxy sh scripts/company-service.sh start
rtk proxy sh scripts/company-service.sh uninstall
```

`GET http://127.0.0.1:<port>/health` 是进程存活探针；`GET /ready` 检查实际目标库 ownership marker 可读，200 为 ready、503 为不可用。两者仅本机可访问，且同样应用 Host/Origin 检查；MCP `/mcp` 仍须每次 Bearer 鉴权。检查时用 `rtk proxy curl --fail http://127.0.0.1:<port>/ready`，`rtk proxy lsof -nP -iTCP:<port> -sTCP:LISTEN`，`rtk proxy sh scripts/company-service.sh status`。日志在 `logs/stdout.log` 和 `logs/stderr.log`（调度器为 `logs/stdout-dispatcher.log`、`logs/stderr-dispatcher.log`），只记录监听端口、投影数量和不含原始错误的重试消息；不要把完整日志上传到 Issue。启动失败先检查私有配置路径、文件权限、端口占用、现有 SurrealDB 可达性与本机 gh 登录。回滚须按下文「双面回滚」同时恢复 launchd 与插件来源；仅运行 `install <previous-release>` 不足以完成回滚。卸载如上。

## 插件面同步（基线集成 + 固定 release 双面发布）

任务系统有两个部署面：launchd `org.surrealck.company-mcp` 从 `active` 指向的 release 运行；员工 comm 通道（sck → sidecar → vendored core）、运维代理、调度器与交付预览运行在 Paseo 插件 `sck-company` 内。**两面必须使用同一个集成基线的固定 release**。只切 `active` 或只 reload 旧来源，会让两面 core/schema 不一致（曾出现新岗位被旧 ROLES 拒为 `invalid: Invalid role`）。

**部署只用 main 分支**：自 2026-10-10 起取消"生产基线任务分支"模式——所有变更必须先经 PR 合入 `origin/main`，release 一律从 `main` 的合并提交切出，`company-service.sh install` 会强制校验 release SHA 可达自 `origin/main`，不在 main 上的提交一律拒绝安装。历史上 `task/d7697420`、`task/b7fdaa55` 等生产基线分支曾让部署面与 main 漂移（双面跑过不同版本），该模式已废止；`/Users/y/IdeaProjects/surreal-ck-operations-v3`（`ops/v3-paseo-dispatch`）保留为 **protected 历史工作树**，不再是生产插件来源。

固定 release 内的 `plugin/server/vendor/` 仍是 `src/` + `schema/` 的生成拷贝，每次打包都须重生成。

### 1. 合入 main 并固定提交

以下操作仅由已获上线批准的部署腿在其登记任务分支/工作目录执行，不在共享 main checkout 直接写代码，不自行建树或切分支。先记录 `active` 的完整路径和插件 SOURCE/DIRECTORY，保留上一版双面回滚目录及依赖。

变更在登记任务分支完成、通过评审后，按正常流程 PR 合入 `origin/main`（不允许把未合并的基线/任务分支直接切 release）。

**SYS02 验收基线守卫**：安装、回滚与远程切换在 active、插件、MCP 或 ssh 任何副作用前，用当前健康 release（或部署树）的脚本读取目标 release 自身的 `src/acceptance.ts`/`core.ts`/`database.ts` 与 `schema/*acceptance*.surql`，要求其内容（已由 `release-content.sh` 绑定提交）证明不可移除的 required 机器 AC + 真实独立签署基线。旧版、不完整、注释冒充或不可读目标一律拒绝，不以“当前无 gated 行/先关 gate”开窗；无兼容回退目标时保留健康版本或受审前修。回滚必须用当前健康 release 的脚本，不能用目标自带的旧 installer 绕过。合入后 `rtk git fetch origin`，取 `origin/main` 的完整 SHA 作为本次 `SCK_BASELINE_SHA`——release 快照即该提交的内容。

部署记录应包含来源 PR/SHA、最终 main SHA 与批准范围。该 SHA 须通过根与插件 typecheck、该变更要求的回归；本地数据库测试只用公司 fork。根/schema 与插件/vendor 来自这同一个 main 提交。

### 2. 从提交生成固定 release

下例变量须在同一个 shell 会话设置；`SCK_DEPLOY_REPO` 是当前登记部署工作目录，`SCK_BASELINE_SHA` 填已提交的完整集成 SHA，`SCK_PLUGIN_DEPS` 填上一步记录的上一固定 release 的 `plugin/node_modules`（首次切换时才用已核实的 v3 依赖目录）。不读取凭证或私有 env；不覆盖已存在的 release。所有占位符须替换后执行。

```sh
SCK_DEPLOY_REPO='/absolute/registered/deploy/worktree'
SCK_BASELINE_SHA='<full-integrated-commit-sha>'
SCK_RELEASE_ROOT="$HOME/Library/Application Support/SurrealCKCompany"
SCK_RELEASE_DIR="$SCK_RELEASE_ROOT/releases/$SCK_BASELINE_SHA"
SCK_PREVIOUS_RELEASE='/absolute/previous/release'
SCK_PLUGIN_DEPS="$SCK_PREVIOUS_RELEASE/plugin/node_modules"
PASEO_CLI='/Applications/Paseo.app/Contents/Resources/bin/paseo'
rtk proxy test ! -e "$SCK_RELEASE_DIR"
rtk proxy mkdir -p "$SCK_RELEASE_DIR"
rtk git -C "$SCK_DEPLOY_REPO" archive --format=tar --output="$SCK_RELEASE_DIR/source.tar" "$SCK_BASELINE_SHA"
rtk proxy tar -xf "$SCK_RELEASE_DIR/source.tar" -C "$SCK_RELEASE_DIR"
rtk proxy rm "$SCK_RELEASE_DIR/source.tar"
rtk proxy cp -RL "$SCK_PLUGIN_DEPS" "$SCK_RELEASE_DIR/plugin/node_modules"
rtk proxy sh "$SCK_RELEASE_DIR/plugin/scripts/vendor.sh"
rtk proxy pnpm --dir "$SCK_RELEASE_DIR" install --frozen-lockfile
rtk proxy pnpm --dir "$SCK_RELEASE_DIR/plugin" install --frozen-lockfile --ignore-scripts
rtk proxy pnpm --dir "$SCK_RELEASE_DIR" typecheck
rtk proxy pnpm --dir "$SCK_RELEASE_DIR/plugin" typecheck
```

逐条检查退出码，任何一步失败都停止，保留当前生产版本。依赖拷贝要解引用，避免 release 指向会被回收的开发树；随后以该基线锁文件安装校准，不能以旧 `node_modules` 代替 frozen-lockfile 校验。预安装与 vendor 生成完才允许切换；上线后 release 不再原地修改。同 SHA 已有目录只可在核对完整快照、依赖和 vendor 后复用，不盲目覆盖。

### 3. 安装 launchd 与重注册现有插件

先安排短暂维护窗口，记录在办任务/编制状态并暂停新增派工；由经理使用现有管理通道处理受影响编制，不新建员工或 dispatcher。不要重启整个 Paseo 守护进程。现有私有配置由运行脚本加载，安装命令只传固定 release 路径。

```sh
rtk proxy env SCK_COMPONENTS=mcp sh "$SCK_RELEASE_DIR/scripts/company-service.sh" install "$SCK_RELEASE_DIR"
# MCP ready / bootstrap 成功后再切插件（端口用已登记配置）
rtk proxy curl --fail 'http://127.0.0.1:<mcp-port>/ready'
rtk proxy "$PASEO_CLI" plugin install "$SCK_RELEASE_DIR/plugin" --id sck-company
rtk proxy "$PASEO_CLI" plugin reload sck-company
rtk proxy "$PASEO_CLI" plugin ls sck-company
```

`install` 校验 main 祖先关系、切 `active`，并在插件已登记于本服务目录时自动执行 `plugin remove` + `plugin install <release>/plugin --id sck-company` 完成重指——daemon 只在登记时解析来源路径，`reload` 不重读 config、`install` 不允许覆盖既有 ID，所以重指只能走 remove+install（插件进程重启，sidecar `adopt()` 会恢复在编通道与活租约）。已指向本次 release 时 install 只做 reload。插件登记在服务目录之外的路径（如开发树）时 install 不干预，只提示。不要继续加载 v3 checkout，也不要另装 launchd dispatcher。任何一步失败，按第 5 节恢复两面后再修复。

### 4. 双面验证与恢复派工

- `rtk proxy readlink "$SCK_RELEASE_ROOT/active"` 必须等于本次 release；`rtk proxy sh "$SCK_RELEASE_DIR/scripts/company-service.sh" status` 应显示 MCP running；`/health`、`/ready` 都返回 200。
- `paseo plugin ls sck-company` 必须为 running、enabled、无 error，**SOURCE 和 DIRECTORY 都必须等于 `$SCK_RELEASE_DIR/plugin`**。只看 running 不足以证明已切版本。
- 比对 release `schema/` 与 `plugin/server/vendor/schema/`：`rtk proxy diff -qr "$SCK_RELEASE_DIR/schema" "$SCK_RELEASE_DIR/plugin/server/vendor/schema"` 无差异。vendor 的 TypeScript 多一行 `// @ts-nocheck`，核对 core 时去掉该首行再比对源文件，记录基线 SHA 与生成物哈希。
- 用真实已登记员工通道 `rtk proxy "$SCK_RELEASE_ROOT/bin/sck" call get_context '{}'` 验证 core 可用；恢复维护前的编制状态后，由经理安排一次实际派工，核对 spawn/claim 与任务记录，不能把命令成功当成已验证派工。无分页参数的 `get_context` 默认不含公司块（答复中 `companyIncluded` 为 false），所以公司块再大也不会让它超限。若它返回 `response_too_large`，说明匹配的任务本身超过 48 KiB 整包预算，即旧的全量任务查询过宽，应视为需要分页的查询问题，而不是可忽略的正常结果：改用 `'{"pageSize":25}'`，并把返回的 `page.nextCursor` 作为 `cursor` 逐页读取，直到 `page.hasMore` 为 false；需要收窄时加 `state`、`goalId`、`role` 或 `since`。公司方向、目标与项目用 `'{"scope":"company","pageSize":25}'` 分页读取（`companyRead` 字段给出同样的参数），按段的长度与 SHA-256 重组。`response_too_large` 时核心仍在运行，可用分页调用复验。预览健康与监听进程按下节检查。公司块中的项目环境（`envs`、凭证别名与角色）只对 gm 与持有该项目有效任务租约的员工返回；其它员工看到项目身份，并得到 `envsWithheld: true`。老板控制台仍是完整视图。

证据分别记录两面路径、SHA、进程状态、探针与真实派工结果/时间；若真实派工尚未验证须明确标注，不能宣布部署完成。

目标会话布局的切换还执行 `goal-workspace-guard.sh`：核心与插件 vendor 必须同时携带目标绑定领取检查。旧版会忽略员工 `workspace_scope`，因此被拒绝；上线后发生问题保留健康版本并前向修复，不能用旧调度器接管已绑定目标的会话。布局与迁移边界见 [工程、目标与会话](./goal-workspaces.md)。

### 5. 双面回滚

**兼容目标是回滚的前提（RW06）**：切换（install 与远端 deploy）在内容绑定之后、任何副作用（bin 复制、`active` 链接、插件重指、MCP 重启、快照清理、远端上传）之前，用 `scripts/review-wait-guard.sh` 读取**目标自身的代码**判定兼容性：目标必须带 `src/review-wait-capability.ts` 的协议标记、`src/core.ts` 中的“按原阶段解锁”语句（`$restore_phase`）与 `src/contracts.ts` 的 resume 视图字段；本地 install 还要求插件 vendor 同源，远端 deploy 只查核心。不兼容、不可读或无法证明的目标一律拒绝，**没有“当前没有等待项所以放行”的例外**（检查之后并发产生的等待会绕过这种检查）；拒绝发生在任何切换副作用之前，并输出目标、原因与 `waiting items=unknown`（切换脚本没有受权的公司数据读取接缝，不能据此声称没有等待项）。
只有证明兼容的目标才能切换；旧版本（如 9854fe0、475b5c2 及其后的旧快照）不是固定可回退版本。没有可用兼容目标时，保持当前健康版本、受控 hold，或走受审的前向修复，不得把破坏复核阶段的旧版当成可用性恢复，也不得以伪 accept 或改库换取回滚条件。窗口内切换前仍须按第 4 节采样并证明没有活复核租约（或使用已独立部署验收、支持复核 adopt 的版本）。

**已写策略的数据不能切到不执行策略的代码（IR06）**：切换守卫在 RW06 之外再用 `scripts/independence-guard.sh` 读取目标自身代码，确认它带 `src/independence.ts` 的协议常量、`src/core.ts` 的来源版本守卫（`INDEPENDENCE_GUARD_SQL` 与 `independenceGate`）与 `src/contracts.ts` 的策略及身份视图；本地 install 还要求插件 vendor 同源，远端 deploy 只查核心。线上数据可能已带有独立性策略（`independence_set`），把这份数据切到没有该契约的目标上，被排除的来源经手人、其登记 principal 同伴与点名员工会被直接放行认领——这正是 IR06 拒绝回滚旧 release 的原因。拒绝同样发生在任何切换副作用之前，并输出 `excluded tasks=unknown`；没有可用兼容目标时，保持当前健康版本、受控 hold，或走受审的前向修复（换回带该契约的代码即可让同一份数据重新生效，无需改数据）。守卫只读目标树并匹配声明，只能证明目标带有这份契约，不能证明其行为：它与 RW06 同属标记式探针，不执行目标代码，不能替代真实派工与隔离演练证据。

**已写策略的数据不能切到不执行策略的代码（SYS06）**：切换守卫在 RW06/SYS02/IR06 之外再用 `scripts/policy-guard.sh` 读取目标自身代码，确认它带有效策略执行层：`src/policy.ts` 的判定（`resolveEffective` / `checkWriteAuthority` / `dispatchVerdict`）、`src/policy-store.ts` 的读取层、`src/core.ts` 的 `policyPlan` / `policyEnforce` 与 `policy_blocked` 审计、`src/workforce.ts` 的 `policyDispatchVerdict` 派工接缝、`src/contracts.ts` 的试算契约与任务视图事实，以及 `schema/*effective-policy*.surql` 的 `policy` 表与任务/租约登记字段（并要求 `src/database.ts` 真的加载这一版迁移）；本地 install 还要求插件 vendor 同源，远端 deploy 只查核心。线上数据可能已带策略行与任务上的 `policy_*`/`lease_policy_*` 登记，也可能已有 `blocked + blocked_to=gm` 的隔离任务：把这份数据切到不执行策略的目标上，等于把派工判定交回给一个看不见它们的 release——当前契约已不再授权的在办任务会被当普通 ready 任务派出去（新版拒领、旧版照派），隔离过的任务也丢掉说清原因的字段。拒绝同样发生在任何切换副作用之前，并输出 `affected tasks=unknown`；**不设「零行例外」**——「现在还没有策略行」不是安全证明（写策略随时会紧随其后），这样判也会漏掉那批已经写下的数据。没有可用兼容目标时，保持当前健康版本、受控 hold，或走受审的前向修复（换回带该契约的代码即可让同一份数据重新生效，无需改数据）。与 RW06/SYS02/IR06 一样，守卫只读目标树并匹配声明，只能证明目标带着这份契约、不能证明其行为，不代替真实派工与隔离演练证据。

**先停用受影响编制再回滚**：由经理通过现有管理通道暂停这些编制，记录原 enabled 状态，防止旧 core 对新岗位/策略继续派工；核对在办任务并保留租约、comm、登记与审计。回滚目标须同时兼容当前岗位与 WT01/WT02 登记，不能任意选更早版本；不删除 schema、历史或任务数据。

```sh
# 用当前（受审、带守卫）release 的 installer 安装回滚目标：守卫与内容/门禁校验都在这一步完成。
rtk proxy env SCK_COMPONENTS=mcp sh "$SCK_RELEASE_DIR/scripts/company-service.sh" install "$SCK_PREVIOUS_RELEASE"
rtk proxy curl --fail 'http://127.0.0.1:<mcp-port>/ready'
# 插件面由上面的 install 自动重指（登记在服务目录内时）；这里只核对，不重复 install。
rtk proxy "$PASEO_CLI" plugin ls sck-company
```

**不得调用旧 release 自带的 installer**：旧版本的 `scripts/company-service.sh` 没有 RW06 守卫（也没有 SYS02/IR06/SYS06 守卫），实测对不兼容目标会直接 `rc=0` 切 `active` 并复制 bin（全新 installer 对同一目标则拒绝且零副作用）。回滚命令固定用 `$SCK_RELEASE_DIR/scripts/company-service.sh`（`$SCK_RELEASE_DIR` 为当前受审 release）。若 install 输出 `warning: plugin repoint failed`（插件登记在服务目录之外），按第 3 节 R3 手工 `remove` + `install` 指向**已被守卫放行的同一目标**，顺序不得颠倒。

回滚恢复的是上一版完整固定 release（含集成过的在途功能、依赖与 vendor），不能只改 `active` 或只 reload。 SYS02 的回滚边界：新增内容只有可选 `acceptance_*` 字段、`acceptance_evidence` 表与 gate 记录，没有新 task 状态；旧 release 会绕过门禁 accept。存在启用 criteria 的在办任务时不得回滚，必须排空或保留新 release；演练须覆盖“新版写入 gated 数据 → 固定旧 release（a925222）dispatcher/core → 拒绝恢复”，且新守卫拒绝旧目标。重做第 4 节的双面验证；仅恢复与回滚版本兼容的编制，其余保持停用并报经理。旧 release 不完整/不兼容或回滚失败时保留现场并报阻塞，不回退到 v3 历史树作为生产源。

内部AI证明契约（`src/ops/proof-*.ts`，含 `reviewed-token-plan` 配额型证据类型，字段契约见 [internal-ai-proof-contract.md](./internal-ai-proof-contract.md)）同样只经 vendor 拷贝进入员工通道面与调度器：契约变更随固定 release 安装上线，但 `vendor.sh` 重新生成 + `paseo plugin reload sck-company` 完成前，员工侧仍按旧契约校验证据文档与 enable 配额语义，不能跳过插件面同步。

## 交付预览服务（插件内嵌正式版 · LAN/公网双面）

交付预览 HTTP 服务正式版内嵌在 sck-company 插件 server 进程（`plugin/server/preview.ts` 生命周期层 + vendor 的 `src/preview-core.ts` 路由/安全），随插件启动、随 reload/卸载停止，不另起 daemon。**两个监听面分工明确**：

- **LAN 面** `0.0.0.0:$SCK_PREVIEW_PORT`（缺省 18777，保持已公布 URL）：无鉴权、无白名单，仅老板 Mac 局域网设备可达
- **签名面** `127.0.0.1:$SCK_PREVIEW_SIGNED_PORT`（缺省 18778）：仅当 `SCK_PREVIEW_SECRET` 已配置才起，所有 `/e/`、`/d/` 请求强制 `exp`+`sig` HMAC 签名（未签/坏签 401、过期 403）；本机回环绑定，公网只能经 VPS→SSH 反向隧道到达，LAN 侧无法直连

两面共用同一路由/安全核心：`/e/<taskId>[/<file>]`→`evidence/`、`/d/<taskId>[/<file>]`→`deliverables/`、目录/任务根可点击列表页（`../` 可回上级；签名面链接由服务端同密钥签发）、`/healthz`→`{ok,port,uptime}` 免签；mp4 等视频 Range/206 支持拖放。`..`/隐藏段/符号链接逃逸一律 403（词法 resolve + realpath 双重）。

**`private/service.env` 需配**（0600，不进仓库）：
- `SCK_PREVIEW_SECRET`：HMAC-SHA256 密钥（如 `openssl rand -hex 32`），签名面与插件 `company.attachments.url` 签发方共享；不配置则签名面不起（LAN 面不受影响）
- `SCK_PREVIEW_PUBLIC_BASE`：公网可达的 https base，插件校验必须 `https://` 前缀，示例 `https://data.maplayer.top/pv`
- `SCK_PREVIEW_TTL_MS`（可选）：签名有效期，默认 3600000；`SCK_PREVIEW_PORT`/`SCK_PREVIEW_SIGNED_PORT` 可选改端口

**公网暴露（推荐：复用现有 VPS + 域名，零新增付费）**：本机向远端主机开持久反向隧道，把本地**签名面** :18778 暴露为 VPS loopback 端口，再由 Caddy 路径前缀对外——公网流量必经签名门控，永远打不到无鉴权的 LAN 面：

```sh
# 本机（launchd 或 autossh 持久化，复用 deploy 用 SSH 通道）
ssh -N -F /dev/null -i <tunnel-key> -o IdentitiesOnly=yes -o UserKnownHostsFile="<known_hosts>" -R 127.0.0.1:18778:127.0.0.1:18778 scktunnel@<remote-host>
# VPS Caddyfile（data.maplayer.top 站点内追加）
handle_path /pv/* { reverse_proxy 127.0.0.1:18778 }
```

签名只覆盖 `pathname`（如 `/e/<taskId>/<file>`），Caddy 去前缀后一致，`SCK_PREVIEW_PUBLIC_BASE=https://data.maplayer.top/pv`。备选：cloudflared named tunnel 直指 :18778（需 CF 凭证经 ops_* 申请）。

签发链路：收件箱附件行按下 → 插件 `company.attachments.url` 校验文件确在 `evidence/<taskId>` 内 → 返回预览 URL → `openExternalUrl` 打开；老板任意设备浏览器直接消费，图片仍走 `attachments.read` data-URI 内联。URL 形态按老板口径为 LAN `http://<lanIP>:<port>/e/…`（无签名、无时效）；公网签名 URL 通道保留待用（签名面 :18778 + 隧道/Caddy），激活后此 RPC 如需恢复 `base+签名路径` 形态只需切回签发分支。

**员工交付发布工具 `deliverable_publish`**（sidecar 基础工具，`sck call deliverable_publish '{"files":[绝对路径…],"taskId"?}'`）：把文件/目录复制进 `$SCK_SERVICE_HOME/deliverables/<taskId>/` 并返回 `/d/` 路由的 LAN 可点 URL；taskId 缺省取在手租约。同名覆盖、隐藏名跳过、symlink 解引用；任一输入路径无效即整体报错不落半截包。员工证据里的预览链接一律用它返回的 URL。收件箱 `attachments.url` 当前按老板 LAN 口径直接返回 `/e/` 无签名 URL；公网签名通道（preview-sign + 签名面 :18778 + 隧道/Caddy）保留待用，配置 `SCK_PREVIEW_SECRET` 后插件 reload 即激活签名面。

**部署（插件面同步之外多一步退役桥接）**：先 `launchctl bootout gui/$(id -u)/org.surrealck.deliverable-preview` 退役旧桥接（plist 可留档），再走上文「插件面同步」的基线集成、固定 release 打包、launchd install 与 `paseo plugin install <release>/plugin` 重注册流程——插件侧 EADDRINUSE 每 2s 重试至 teardown，bootout 先行即无竞态。`lsof -nP -iTCP:18777 -sTCP:LISTEN` 与 `:18778` 确认监听进程已是 Paseo/插件而非独立 bun，`curl http://<lanIP>:18777/healthz` 200 即接管完成，旧 `/e/`、`/d/` URL 不变继续有效。

**状态观测**：`ops_info` 响应含 `preview` 段 `{lan:{running,port,lanUrl,uptime,lastError}, signed:{configured,running,port,uptime,lastError}, roots, lastError}`——loopback 探测 healthz 为准，失败回读插件写的 `$SCK_SERVICE_HOME/preview-status.json`。插件日志前缀 `[preview]`。

**应急兜底**：`src/preview-server.ts` 为同 core 的 bun 独立脚本（`bun src/preview-server.ts`，双监听与插件一致），插件整体不可用时可用 launchd 临时顶回；复制到 `bin/` 时连同 `preview-core.ts`、`preview-sign.ts` 一起（`cp src/{preview-server,preview-core,preview-sign}.ts $SCK_SERVICE_HOME/bin/`）。

## SYS05 时间与外部事件等待

员工不再用前台 sleep 等待时间或外部回执：`wait_task` 在**一个事务**里保存进度快照、清除持有人/租约并把任务移出派工队列，调度器在条件成立时只释放条件本身。等待期间任务不占员工、不占 provider 并发名额，也不产生人工「核时验收」链。

- **契约**：`kind` 固定为 `time` / `dependency` / `upstream_repair` / `customer_activation` / `owner_handoff` / `feedback`；`ownerRole`、非敏感 `reference`、`notBefore`、工具返回的精确 `expiresAt`、`nextCheckAt`、显示用 IANA `timezone`。时间必须是带时区偏移的绝对时刻（或毫秒数）；无偏移的本地时间直接拒绝，夏令时只改显示、不改判定。没有工具给出精确到期时 `expiresSource=unknown`，系统不算、不补。
- **一次释放**：`task_wait` 的 `state` 从 `waiting` 到 `released` 走版本 CAS；20 个并发 tick 只有一个能落地。`time` 到点只解除时间条件：依赖未完成、任务仍在 `blocked_to=owner`、`owner_handoff` 未收到 owner relay 决定时都保持 `held`，不自动放行。`held` 每个调度 tick 会重查：依赖或引用任务完成后自动回到队列，不会变成丢失事项；需要受信事件的外部等待不会被 tick 放行，仍走 `resolve_wait`/`extend_wait`/`cancel_wait`。精确到期已过且没有到期前受信事件的等待标为 `expired`，不自动恢复；过期等待会保留稳定复查提醒，直到有人取消或先延期再补受信事件；过期状态不能直接确认，不会从队列里静默消失。
- **受信事件**：`resolve_wait` 只接受经理（`authorized_person`）、依赖任务终态，或带 HMAC 签名的 `webhook`（`provider`+`eventId`+`signature`，密钥 `SCK_WAIT_WEBHOOK_SECRET`；未配置即拒绝）。事件必须写明 `objectWaitId`/`objectTaskId`，重复 `event_key`、过期、错误对象一律拒绝；模型自称「收到反馈」不算。签名只证明事件来源可信，不证明所等任务已完成：`dependency` / `upstream_repair` 等待无论是系统依赖事件还是签名 webhook，都必须在同一事务内确认引用任务为 `done|void`；只有显式 `authorized_person` 是人工豁免并留审计。`owner_handoff` 只能由 `record_owner_decision` 的 owner relay 路径解除。
- **安全解除**：`cancel_wait` / `extend_wait` 需要当前 `expectedVersion` 与理由；过期版本拒绝。`wait_migration_apply` 只按单个任务、带版本和理由迁移遗留 `quota_resets_at` 时间阻塞，owner 关口/仍被租约持有/没有未来时间边界一律拒绝，审计 `wait_migrated`；迁移保留遗留阻塞记录的 `resume_state`/`resume_role`，复核期阻塞到点仍回复核，不会变成可执行任务。`cancel_wait` 不给 `resume=true` 时任务留在经理门禁（`blocked_to=gm`），取消不等于条件已解决。`resume` 不能跳过等待；等待引用会做有界环检测，检测与写入在同一数据库咨询锁临界区（`company_meta:wait_enter_lock`，唯一创建获取、带过期回收），并发互相等待时最多一条成功，另一条返回 `conflict`。`wait_migration_preview` 只读，owner 关口永不批量迁移。
- **老板交接卡**：`wait_handoff_cards` 与收件箱给出已完成技术项、待老板动作、谁等谁、工具返回的精确到期或 `unknown`、下一触发条件；提醒按 wait+风险桶去重。邀请 secret 链接只留在受控 handoff 文件，卡片只给文件名；此功能不向客户发信、不代签客户采纳。
- **回收**：租约结束由 ops broker 丢弃本地会话句柄并在审计中注明「未调用远端注销」；ego-browser 空间按受控 closer 有界关闭，未配置或关闭失败记为待清理，绝不冒称已注销。
- **回滚隔离（RB01）**：新表为 `task_wait` / `wait_event`（旧版不读，忽略）；进入等待的任务同时置为 `state=blocked, blocked_to=NONE, resume_state=ready|review`，旧版派工队列不收 blocked，旧版依赖解锁 SQL 也被新版的 `wait_state='waiting'` 条件挡住。`tests/fault-rollback-isolation.fork.test.ts` 的旧 release 演练已包含 `rb01-sys05-wait`（新版写入未到点时间等待 → 旧版调度多轮 → 零认领、零会话）。
- **回归**：`tests/waits.test.ts`（纯规则）、`tests/wait-store.fork.test.ts`（真实 core/fork：原子进入、20 并发一次释放、重启、重复/错误对象/过期事件、owner relay、版本锁、依赖终态）、`tests/wait-dispatch.test.ts`（等待零派工、到点一次唤醒）、`tests/wait-cleanup.test.ts`（会话/浏览器回收失败待清理）。验收退回修复的回归：交接卡真实标题/等待方、`source=dependency` 与签名 webhook 在引用未终态时均拒绝、`held` 依赖完成后自动恢复、单任务迁移保留复核阶段与 owner 关口拒绝、过期等待保留复查提醒。

## SYS07 目标终验图、客户成果与经营指标

目标不再由「最后一个任务被接受」隐式关闭；`accept` 之后的完成判定改为显式重算，写不进证据的目标停在 `needs_repair`。

- **新增状态**：`goal.state='needs_repair'`。终验关口作废/被新版本替代/缺失、终验完成但缺真实 owner relay 批准、required 客户证据未到、依赖成环或悬空、终验关口早于未完成工作、实现任务被 retire 且没有已完成的继任修订时，`goal_finalize` 只写 `needs_repair`、`needs_repair_reason`、`needs_repair_at`，不写 `done`，不改任何历史任务或老板决定。修复后再次 `goal_finalize` 才回到 `active`/`done`；`goal_final_gate_repair` 只允许 gm 按预览快照 + goal/task 版本 CAS 替换终验引用；替换后目标仍停在 `needs_repair`，等新关口真实验收并由 `goal_finalize` 重算，不释放租约、不代替验收；旧关口同时写 `goal_final_gate_replaced` 审计，不再被当成无继任的作废实现。普通实现/发布任务被 retire 时，只有 required `implementation` 才形成 `implementation_void` 缺口；授权 outcome 变更若确实不再要求 implementation，可清除该缺口，否则只能显式取消目标，不留无出口的 needs_repair。
- **成果契约**：`goal_outcome` 每个目标一行，字段 `expected`、`required_evidence`、`responsible_role`、截止绝对时刻与 IANA 时区、版本、授权人/来源/理由。证据词表：`implementation` / `release` / `deploy_qa` / `customer_activation` / `customer_adoption` / `feedback`；`final_acceptance`/`owner_final` 只由真实终验关口与 owner relay 推导，不接受手工填一行就当作批准；required `owner_final` 必须由 `reviewer_role=owner` 的终验关口且 `accepted_by=owner` 满足，gm 终验不能替代老板终验。triage 会为每个新目标写入默认契约，后续变更需 gm 以当前 `expectedVersion` 作版本 CAS，审计留 `goal_outcome_registered`。
- **客户证据**：`goal_evidence` 不可变，一条一回执；`kind`、`summary`、`source`、`confirmed_by`、`evidence_type`（`external_receipt` / `production_record` / `manual_signoff`）、`at`、digest 留档。测试账号、`localhost`/合成来源、模型或 AI 自称确认人一律拒绝；`owner_final` 不能作为证据类型写入。缺客户激活/采纳等 required 证据时，即使终验关口已完成也只能 `needs_repair`。记录动作只代表人已提供回执，不向客户发信、不代签客户采纳。
- **只读看板**：`goal_console` 按目标分页给出截止（未知则 `unknown`，不猜）、阶段（实现/发布/部署 QA/客户激活/客户采纳/owner 终验）、多个并行阻点、依赖路径、责任岗位/当前持有人、已等时长、下一触发条件、有效终验及其证据、`needs_repair` 缺口和源任务 id；卡片对阻塞与源任务做上限，完整任务用 `get_context(goalId, pageSize, cursor)` 翻页。`goal_governance_scan` 是只读演练，只列缺口，不批量撤销/关闭/批准任何历史目标。老板简报和插件目标页读同一张卡，不另算一套完成口径；SYS05 `expired` 等待显式标为已过期并给出取消/延期后的下一动作，不伪装成正常等待。
- **指标（`goal_metrics`）**：窗口左闭右开，按 IANA 时区分日，返回目标/任务周期时间、首验通过率、同一 task+phase 段内的重复阻塞、同一 episode 的重复唤醒且无 checkpoint/submit/accept、可归因到验收任务的 token 用法与每目标用量、客户证据覆盖；窗口内完成的目标按 cutoff 前已存在回执计算，回执早于窗口不误报缺失。初始基线只覆盖本窗口内可见的审计/用量行；系统不承诺可观测的成本下降，成本未知时也不编造趋势。分母、排除项、`cutoffAt`、覆盖行数和未知项随结果返回；没有 provider 实际计费时成本一律 `unknown`，绝不按 token 或时长倒推。通道 release/revoke、系统迁移与人工 return 分列，不混算。
- **工具**：`goal_console`（分页看板）、`goal_governance_scan`（只读缺口扫描）、`goal_metrics`（经营指标）、`goal_outcome_register`/`goal_evidence_record`（成果契约与客户回执）、`goal_finalize`、`goal_final_gate_preview`/`goal_final_gate_repair`（终验重算与 CAS 修复）。
- **权限**：上述读/写都要求 gm 的 `manage` capability；员工只能读自己的任务上下文。目标治理写操作全部带 idempotency key、审计与 outbox；并发同版本变更只有一个成功，其余返回 `conflict`。
- **回滚隔离（RB01）**：旧版不认识 `needs_repair`，其目标关闭 SQL 只匹配 `active`，依赖/修复路径也拒绝非 active 目标，因此回滚后不会静默完成停修目标；`goal_outcome`/`goal_evidence` 是旧版从不读取的新表，`deadline`/`version` 等字段是可忽略的可选字段。本版不改任务状态、依赖、租约或老板决定，回滚不新增派工来源。`tests/goal-rollback-isolation.fork.test.ts` 用 `git archive` 提取真实上一版，在 A/B 两个隔离 namespace 做「新版写入 → 旧版 bootstrap + 三轮调度」：A 阳性对照仍派工普通任务，B 目标任务版本/持有人/goal 状态不变、新表摘要不变，旧版源码不出现新表名。
- **限制**：真实供应商账单未接入时「实际成本」只能是 `unknown`；真实 GM 渠道同快照对账、客户激活/采纳的线下回执与发布后生产 QA 由上线验证腿完成；跨目标依赖会明确标成 `dependency_cross_goal`（不再是笼统的悬空边），但不做跨目标自动修复或批量改写。
- **回归**：`tests/goal-governance.test.ts`（纯规则：终验作废/替代、owner 批准、required 证据、依赖环、阻点分类、DST/成本未知）、`tests/goal-governance.fork.test.ts`（真实 core/fork：权限/分页、只读扫描、卡与简报同源、证据 CAS、终验修复 CAS、并发版本、指标对账）、`tests/goal-rollback-isolation.fork.test.ts`（RB01 真实旧版演练）。

## 员工客户端

> **v3 更新（sidecar/comm 通道）**：员工实例由 Paseo 插件 `sck-company` 注册代管，agent 进程零凭证——spawn env 只注入 `SCK_COMM_DIR` 和 `SCK_COMM_KEY`，实例凭证与租约证明留在插件进程内。claim/heartbeat/submit/review/blocker 由 sidecar 程序化代执行，租约证明自动注入，员工参数只写业务字段，`claim_next` 在员工侧不可用。comm 文件协议：`claim.json` 下发任务上下文，`report.md` 落盘即提交，`blocker.md` 上报阻塞（回合结束时由 sidecar 回收为 submit/report_blocker），`req/`+`res/` 原子转发 `sck call`。`get_secret`/`put_secret` 等凭证工具已下线，需要账号、workspace、生产登录走 `ops_*` 运维工具（先 `ops_info` 查能力清单）。legacy `credential_file` 实例不再被代领新任务，自然淘汰。架构、调用路径、安全边界与排障详见 [sidecar 通道](./sidecar-channel.md)；本节下述的凭证文件方式（`SCK_EMPLOYEE_CREDENTIAL_FILE` 与 `private/credentials/*.token`）仅为旧部署与 legacy 实例保留。

实际员工身份由公司库的 `employee` 凭证记录确定。七个固定身份为 `gm-01`(gm)、`product-01`(product)、`eng-01`/`eng-02`(engineering)、`ai-01`(ai-content)、`qa-01`(qa)、`cs-01`(cs)（concept-design、asset-production 等内容产线岗位由调度器按 employee_def 动态生成实例，不走固定身份）。令 `SCK_MCP_URL=http://127.0.0.1:<port>/mcp` 和 `SCK_EMPLOYEE_CREDENTIAL_FILE=<对应私人路径>`，执行 `rtk proxy pnpm run mcp:client -- list`、`rtk proxy pnpm run mcp:client -- call get_context '{}'`。客户端初始化和调用使用官方 MCP SDK；身份仅由 Bearer 凭证决定，不能在工具参数中伪装。`claim_next` 可传 `{"taskId":"..."}`；返回的 `deliveryId`、`fence`、`task.version` 构成后续 heartbeat/checkpoint/submit 的 proof。提交的 `idempotencyKey` 在网络丢响应重试时保持相同。

首次真实员工接入任务由 GM 管理工具创建，执行岗位 cs、验收岗位 qa。cs-01 必须在**自己的真实会话**用自己的凭证领取、heartbeat、checkpoint、submit；qa-01 在自己的会话领取 review 并 accept/return。工程的合成轮换凭证测试仅证明实现，不替代该交接。回执说明应含实际岗位、允许动作、四个操作的脱敏命令摘要和遇到的问题，不能包含凭证。任务 ID 与各自凭证**路径**交 #28；不要在 Issue 写值。

## QA 对接

按 [#26 B01—B12](./qa/mcp-company-acceptance.md) 独立执行，尤其 B09 重启持久化、B11 非目标库与日志、B12 两位真实员工。#29 的 SDK/Bun 探针属于前期资料，#25 的合成三 token 联调也不等于 B12。QA 应记录本集成提交、`pnpm-lock.yaml` 哈希、URL、目标库、进程状态和脱敏日志路径。当前核心与 adapter 的准确 DTO、错误码、工具参数参见 `src/contracts.ts`、`src/mcp/server.ts` 和 [adapter 文档](./mcp-adapter.md)；本说明不修改已冻结的业务权限与租约语义。


## WT01 登记、分配与上线验证

物理工作目录以任务服务的 `worktree` 登记为准，任务分支与物理树分开：每仓一个 shared（QA/经理/产品/CS/内容默认只读），串行工程在无活动引用且干净时复用它、每项独立 `task/<id8>` 分支/PR（基线优先仓库已取回的 origin/defaultBranch，未配置 remote 时用默认主线）；已有引用或 dirty 时新代码写手用 exclusive，原现场不切分支。内容写任务由管理方在 `create_task.workIntent` 显式授予 `{kind:"assets",paths:["assets/characters"]}`；重叠目录排队（大小写保守视为相同），互不重叠可共用，路径穿越/凭证目录/符号链接目录拒绝。GM/eval 无租约唤醒用 `workspace.json` 的 shared 只读登记与会话引用。附件保持 `evidenceDir`。

仓库身份由 realpath + git common-dir 确定，未绑定 project 使用 `SCK_AGENT_CWD` 的规范仓库身份。MCP 与插件共同使用 Git common-dir 下的 `sck-worktree-allocation.lock`，由系统 `/usr/bin/python3` 的 kernel flock 持有（进程退出释放）；机器已有 Python，不安装全局工具。领取事务同时更新 task assignment、worktree_ref、employee active_task 和租约，失败不会落有效引用；网络丢响应重复 claim 保留 fence/路径。Git 树先登记，异常中断后未知树受保护，已存在的 task 分支现场就地接管，不 reset。引用有效性实时由任务 current_employee/delivery/fence/状态对账；撤销交接与被阻塞的写现场继续保护。main、常驻插件、active/回滚 release 均登记 protected。

WT02 在 WT01 登记之上启用按归属回收：持久引用是唯一删除依据；租约过期/交接只释放员工 fence，非终态保留 recovery；done 后 exclusive 干净树可事件触发删除，shared 与保护树保留；脏树与未合并分支不强制删除。孤儿宽限默认 7 天（`SCK_WORKTREE_ORPHAN_GRACE_DAYS` / `company_meta:config.worktree_orphan_grace_days`），时钟用 last_released_at → last_used_at → created_at。调度器沿用既有 10 分钟 sweep，不新建定时器。紧急关闭：`SCK_WORKTREE_RECLAIM=0`。审计表 schema 012 `worktree_audit` 可查。细节与演练见 [WT02 生命周期手册](./qa/worktree-lifecycle.md)。

查询入口：员工 `sck call list_worktrees '{"taskId":"当前任务ID"}'`，权限沿用 get_task；GM 可不传 taskId 查询全局。非 gm 不带 taskId 一律 `forbidden`，通道不回退到当前租约任务。released 引用默认只计数，加 `"includeReleased":true` 才列出。返回规范路径、稳定 ID、project/repo、mode、实际/登记 branch 状态、创建/最后使用时间、各引用持有人/任务/时间、`deletable` 与 reasons；不含凭证。不带 `pageSize`、`cursor` 时返回完整数组，超出 48 KiB 预算则报 `response_too_large`，不截尾；带分页参数时返回 `{worktrees, page}`，按 `page.nextCursor` 逐页读完再统计（见 [query-paging.md](./query-paging.md) 第 3、4 节）。GM 另可 `reclaim_worktrees`（支持 dryRun）与 `list_worktree_audits`。branch 漂移或丢失只报告，不自动修复。

管理查询分页与预算（SYS01，v25）：运营需要知道以下行为。

- `get_context`、`get_task_history`、`list_worktrees` 的每个响应不超过 48 KiB，即 49152 字节（UTF-8）。计量为 MCP 结果的 JSON 字节加 256 字节帧预留（`answerBytes`），答案的文本副本与 `structuredContent` 两份都计入。不带 `pageSize`、`cursor` 的旧调用返回完整结果，超出则报 `response_too_large`，不截尾。
- 需要统计或遍历全部条目时，带 `pageSize`（1 至 100，缺省 25）逐页读取，直到 `page.hasMore` 为 false，并累加每页的 `returned`。`page.total` 为快照内的总数，可用于核对。每页条数由预算决定，可能少于 `pageSize`。
- 分页快照由数据库统一计数，MCP 与插件 sidecar 共用上限：每身份 4 个，全库 64 个，合计 64 MiB；单个快照最多 5000 行或 8 MiB，有效期 6 小时。上限在代码中固定，没有运营配置项。
- 全库快照已满时返回 `temporarily_unavailable`，可重试。同一身份的快照全部仍在写入时，请求最多等待 5 秒，且不超过本次构建的 10 秒截止。构建超过 10 秒截止，或排队超过 2 秒仍拿不到构建连接，都返回可恢复的 `temporarily_unavailable`；答复最迟在 13 秒内返回。已预留的配额在截止后 2 秒内释放，来不及释放的标记为待清扫，下一次清扫释放一次。50 KiB/s 等受限链路上，超过 10 秒可传输量的大工作集会以该错误返回，这是可恢复的拒绝而不是数据损坏，应按答复指引收窄 `state`、`goalId`、`role`、`since` 或投影字段后重试。超过 5 分钟仍未完成的快照视为遗弃并删除。持续出现容量错误时，核对 `query_snapshot` 表的行数与 `query_snapshot_quota:global` 的 `listings`、`bytes` 计数是否一致。
- 长文本用 `read_task_text` 按字节段读取，每段默认 16 KiB、最大 24 KiB。第二段起必须带首段返回的 `expectSha256`，若原文已变，返回 `conflict`，须从 `offset: 0` 重读。
- 写入先于回显提交。回显先裁切超长列表（依赖、意图路径，标注 `listsTruncated`，完整列表用 `read_task_text` 读取），再裁切正文（标注 `contextTruncated`）；其余顶层文本字段超过 2 KiB 时同样裁切并标注。只有整条应答仍超过 49 152 字节时，调用方才会收到 `response_too_large`。此时写入已经提交，用 `get_context`（带 `taskId`）核对状态，不得重复提交。
- 全局库存只有 gm 可读，即不带 `taskId` 的 `list_worktrees`。非 gm 角色必须带 `taskId`，缺省或 null 一律返回 `forbidden`。
- `reclaim_worktrees` 参数严格（经理裁定 v44）：`dryRun` 只接受 true、false 或省略（省略即回收）；整包 null、`dryRun` 为 null 或字符串、`repos` 不是路径列表，一律返回 `invalid`，不触碰任何工作树。

QA 步骤对应如下。统计工作树数量时，先以 gm 身份执行 `list_worktrees` 分页读取，或对具体任务带 `taskId` 读取。遇到 `response_too_large` 时改用 `'{"pageSize":25}'` 并按 `page.nextCursor` 逐页读完。`get_admin_summary` 为 gm 专用的只读汇总，口径与完整性标志见 [query-paging.md](./query-paging.md) 第 5 节。发布后的真实员工 sck 最终验收由 QA 任务 `6b6cb5b9` 执行。

本链实现提交只创建 PR，不发布。上线申请批准后的部署腿执行以下验证，具体演练见 [WT01 分配手册](./qa/worktree-allocation.md) 与 [WT02 生命周期手册](./qa/worktree-lifecycle.md)：

1. 记录 MCP active release 提交、插件 SOURCE/DIRECTORY 对应的固定 release 基线、vendor 的 core/schema 哈希及进程 running；在已批准提交建立固定 release，运行依赖安装和本地 fork 回归。MCP bootstrap 新增 schema 011/012（只新增结构，无数据删除/改写）；插件必须在 bootstrap 成功后同步相同 src/schema。
2. 按上文双面流程把生产基线、v3 在途提交与已批准主线集成为固定 release，重生成 vendor/schema，安装 launchd，再用 `paseo plugin install <release>/plugin` 重注册并 reload **现有** `sck-company`；v3 checkout 保留为 protected 历史树，不另起 dispatcher。
3. 验证 MCP `/ready`、插件 running、真实员工 `get_context` 与真实派发恢复；记录两面实际提交/时间。经理安排真实串行 QA/工程及并行代码写手演练，QA 用普通通道读登记，不取得凭证、不自行建员工。证据含任务 ID、实际路径/branch、audit ID/时间、登记/有效引用 before/after，区分本地与生产。
4. 回收需要关闭时两面设置 `SCK_WORKTREE_RECLAIM=0`（`SCK_WORKTREE_STRATEGY` 已移除：代码任务始终独占任务树或所属线的树）。restart MCP + reload 现有插件。保留 schema 011/012、登记、审计与在办现场。两面代码回滚也须保留 WT01/WT02 登记兼容版本。

新业务环境变量：可选 `SCK_WORKTREE_RECLAIM`、`SCK_WORKTREE_ORPHAN_GRACE_DAYS`；系统 Python 和现有 Git 是本机准备项。

## 老板提醒：老化升级与每日简报

调度器每个周期都会检查等老板的东西（待批关口、待回答的问题），不再只在出现时提醒一次：

- **老化升级**：等待满 4 小时、24 小时、72 小时各再提醒一次，之后每天一次；提醒写明已等多久、属于哪个目标、卡住多少下游任务。24 小时起的提醒强制弹通知（不再经 Jev 判断是否打扰）。老板处理后提醒自动消失。检查每 5 分钟一次。
- **每日简报**：每天本地时间 9 点后的第一个周期发一条：等你处理的事（最久的排前面）、异常卡滞（依赖已完成却仍 blocked、就绪超过 1 小时没人领）、近 24 小时完成/退回/驳回/作废数、在办目标、供应商额度。调整时刻 `pnpm run admin config owner_brief_hour <0-23>`，关闭用 `-1`。重启不会重发。
- **手机推送**：桌面通知在电脑前才看得到。要推到手机，在 `private/service.env` 里加 `SCK_NOTIFY_WEBHOOK=<地址>`（任何接受 JSON POST 的中继，Bark/Gotify 等；地址含密钥，只放私有配置），重载插件后所有通知同时 POST 到该地址（字段 `title`/`body`/`message`/`text`）。不配置则只有桌面通知和收件箱。

集成测试用受控本地 fork 运行：`pnpm test`（全部）或 `bun scripts/test-worktrees.ts [tests/xxx.test.ts …]`（指定文件）。直接 `bun test` 读 `surreal_ck/.env` 会连到生产 SurrealDB 服务器，所以 `loadDatabaseConfig()` 在测试环境（`NODE_ENV=test`）下遇到非本机地址会直接报错拒绝。

## 产线与岗位契约

不同产线流程不同（软件交付、视频、长篇故事），所以目标模板按产线选，不再全公司一套。

- **产线**：`software`（默认，原流程）、`video`（拆解 → 老板最终验收，不含运营验收）、`story`（只有一个拆解任务，不自动收尾——靠 [展开下一层] 任务接力递归）。目标创建时指定：`pnpm run company goal --pipeline story --project <项目> "<目标>"`，或在插件「新目标」里选产线；不指定则取项目默认产线（`project set` 的 `pipeline` 字段），都没有则走软件线。
- **岗位契约**：项目岗位轨词表里每条轨可写 `roles: [...]`，限定能承接它的岗位。建单（`create_task` / `create_delivery`）时校验：派给轨不允许的岗位会被拒绝；任何出现在某条轨 `roles` 里的岗位都是产线岗，建单必须挂轨。没有出现在任何 `roles` 里的岗位（gm、product、qa 等）仍可建不挂轨的协调任务。契约写在项目记录里，改项目配置即生效，不需要改代码。
- `screenwriter` 仍保留原有的"必须挂 编剧 轨"硬规则。

## 老板改派命令

任务被派错岗位时（例如岗位或产线调整后，存量任务还挂着旧岗位），不要直接改库：

```sh
pnpm run company reassign <任务ID> [--executor <岗位>] [--reviewer <岗位|owner>] "<原因>"
```

只改还没开工的任务：状态必须是 blocked 或 ready，没有有效租约，也从未提交过。改派前会按创建时同样的规则校验——项目岗位契约（轨限定的承接岗位）和必配轨岗位（screenwriter、story-author、cinematography）——并写一条 `reassign` 审计，任务版本加一。同一请求重放是幂等的。已开工、已提交或已完成的任务会被拒绝。

## 每日简报里的产能与员工流动

- **产能**：按岗位列出"当前可用编制/总编制"——供应商额度低于下限或处在冷却期的编制算不可用，并写明原因（例如 codex 额度不足、grok 402 欠费）。有岗位一个可用编制都没有时会明说。派工本来就会跳过这些编制，权重在可用的编制之间重新分配；这一段是给老板看的：该充值、换模型还是加编制。
- **员工流动**：近 24 小时新建与退役的员工实例数，以及其中"认领失败"的数量。正常情况下认领失败应接近 0；持续偏高说明调度在反复新建又丢弃实例（2026-10-10 曾因共享 worktree 争用每天上百次，worktree 按线分配后已降到 0）。

## 提交前检查（PR 门）

工程的实现任务（kind=task）提交时，系统会读 submit 证据里链接的 GitHub PR（`gh pr view`），只检查**头分支就是本任务登记分支**的那个 PR：与主干冲突、已关闭未合并、或有失败的 CI 检查，提交会被直接拒收（`invalid`，任务仍是 doing），员工修好后重新提交，不再占用一次验收。CI 还在跑不算失败；GitHub 因账户付款失败或触及支出上限而未启动作业的检查也不算失败——判定前会读该检查的注解（含 account payments / spending limit / Billing & plans 文案）与其作业，只有**一步都没执行**的作业才算基础设施拒绝，跑过步骤的失败、没有 job 链接的检查、读不到注解或作业一律照旧视为失败。证据里没有 PR 链接、链接的是别的分支、或 `gh` 查询出任何问题时一律放行，由验收人照常检查。上线申请、合入部署和其他岗位不受影响。`SCK_PR_GATE=0` 关闭（MCP 与插件两面都要设）。

简报里的"退回"只统计真正的验收退回；系统因工作区路径变化换会话产生的"通道回滚"单列。

## 往返熔断

同一个任务在员工与经理之间反复"阻塞 → 经理处理 → 再阻塞"（`block` 审计），达到 `block_loop_limit`（默认 5）次，调度器不再叫醒经理，而是把任务转成老板的问题：写明往返次数和最近三次阻塞原因，老板回复后任务按回复继续，并重新计数。`pnpm run admin config block_loop_limit <n>` 调整，`0` 关闭。起因：一个生产实测任务曾在 18 小时内往返 19 次、换了 18 个员工，每轮都在重复同样的失败。

## 终态产物回收与资源闸门自救

`evidence/<任务ID>/` 与 `deliverables/<任务ID>/` 是工作存储，不是长期档案。终态（done/void）任务的这两个目录按任务生命周期回收：宽限期 evidence 3 天、deliverables 7 天、作废任务 1 天，时钟取该任务最后一条审计，永远不取文件 mtime；只删大文件（媒体、压缩包、依赖/VCS 目录），保留小型文本与 `.reclaimed.json` 墓碑。派工闸门（`min_free_disk_mb`，默认 10240 MB）每轮先做一次压力回收，目标水位是 `min_free_disk_mb + artifact_headroom_mb`（默认共 20 GB）；水位达标后自动恢复派工。

**两级开关，语义不同**

| 开关 | 位置 | 作用 |
|---|---|---|
| `artifact_reclaim_enabled` | `company_meta:config` | 关闭**例行**回收（30 分钟惰性 sweep、普通 sweep 触发）。资源闸门触发的**紧急回收不受它影响**——否则磁盘一低就会把公司锁死。 |
| `SCK_ARTIFACT_RECLAIM=0` | 服务环境（两面都要设） | 硬停，连紧急回收一起停。此时闸门阻塞期间会发 `resources-reclaim-blocked` 通告（强制提醒），写明是哪一级开关停的。 |

**运维命令**

```sh
pnpm run admin reclaim-artifacts                      # 只读试算（dry-run，受配置开关约束以外的自动路径不适用）
pnpm run admin reclaim-artifacts 20480                # 压力模式试算：目标空闲 20480 MB
pnpm run admin reclaim-artifacts --execute            # 真的回收（人工运行不受配置开关限制）
pnpm run admin reclaim-artifacts <任务ID> --execute   # 只回收指定任务
```

参数里的裸数字一律是目标空闲 MB，不是任务 ID（任务 ID 是 UUID）。回收台账在 `<服务目录>/logs/artifact-reclaim.jsonl`，每次运行一行汇总，被删目录各一行。目标目录只接受 `<根>/<任务ID>` 这一层普通目录：符号链接不跟随、不删除，越界与非法 ID 直接拒绝。

2026-10-20 事故：`artifact_reclaim_enabled` 被人工置为 false（无审计记录），磁盘降到 8.8 GB 后闸门连续阻塞全部派工十余小时，两个 ready 任务无人接手。修复后紧急回收绕过配置开关，闸门不会再被软开关死锁；此后该开关只影响例行清理频率。

**工作树、员工通道与冷归档的保留期**

四类回收器看不到的残留，由同一轮 GC（30 分钟）按保留期清理：

| 对象 | 判定 | 默认保留 | 配置键 |
|---|---|---|---|
| 工作树 | `git status --porcelain` 里纯依赖/构建产物（未跟踪的 `node_modules`、`.venv`、`dist`、`build`、`target` 等）不算脏；**已跟踪文件的任何修改仍然算脏**，绝不自动删除 | 沿用 WT02 的孤儿宽限期 | `worktree_orphan_grace_days` |
| `comm/<实例>` | 实例不在插件应答集合（`liveInstanceIds()`）里，且目录 mtime 超期 | 48 小时 | `comm_dir_grace_hours`（0 = 关闭） |
| `scratch/<实例>` | 员工临时目录（克隆、构建、转码、抽帧、下载）；员工拿到的 `SCK_SCRATCH_DIR` 与 `TMPDIR` 都指向它，实例不在应答集合且 mtime 超期即清 | 24 小时 | `scratch_grace_hours`（0 = 关闭） |
| `archive/<批次>` | 只认 `evidence-YYYY-MM-DD`、`deliverables-YYYY-MM-DD`、`*.tar.gz` 三类命名；其他内容留给人 | 7 天 | `archive_retention_days`（0 = 关闭） |

GC 只删目录本身，不碰 `evidence/`、`deliverables/` 与任何已跟踪内容；结果打印在插件 stdout（`artifact reclaim` 台账只记 evidence/deliverables 的裁剪）。GC 与资源闸门无关，水位正常时也照常运行。

删除工作树前，GC 先清掉未跟踪的依赖/构建目录（`junkPathsFromPorcelain`），再执行**不带 `--force`** 的 `git worktree remove`；已跟踪文件的任何修改仍会让删除被拒并记 `git-remove-failed`。登记行指向的目录已消失、任务已终态（引用全部 released）且该分支没有未终态任务时，扫描直接摘除这一行（审计 `drop_stale_row`），只对 `exclusive` 生效，`shared`/`protected` 行留给人工判断。审计事件名是 `worktree_audit.event` 的 ASSERT 白名单：新增事件必须同时在 `schema/021-worktree-audit-events.surql` 放行，否则审计写入被拒、仓库级 catch 会中断整轮扫描（2026-10-21 事故）；`tests/audit-event-whitelist.test.ts` 在 `test:channel` 里校验两边一致。

## 老板作废、解锁与取消目标

```sh
pnpm run company revoke <任务ID> ["<原因>"]      # 终止在途执行：撤当前持有人租约回 ready，任务保留等下一位
pnpm run company void <任务ID> "<原因>"          # 作废：只等它的下游自动解锁；终验关口作废不会关闭目标
pnpm run company unlock <任务ID>                 # 补跑依赖解锁：依赖都完成了任务却还是 blocked 时用
pnpm run company cancel-goal <目标ID> "<原因>"   # 作废目标下全部未完成任务并关闭目标（cancelled）
```

`revoke` 与 `void` 的区别：revoke 只撤在途租约（员工换人或路线变更时用，任务本身继续），void 是把任务整个作废。两者在插件「目标进展」页（任务详情与目标卡按钮）和网页审核台（/o/<token>/，目标页与待办关口按钮）也能直接操作，不用开终端。

都带审计和幂等键，规则与经理的 `retire_task` 一致：已完成的任务不能作废，还有活下游的老板关口不能作废。**不要再直接改库改任务状态**——绕过解锁逻辑会让下游一直卡在 blocked（2026-10-11 的小说目标就这样卡过一次）。

## 媒体生成（ElevenLabs）

ElevenLabs 的 key 只存在于 `sck-vault` 里。它是一个独立的小程序，key 保存在登录钥匙串中，钥匙串只信任这一份二进制。插件和员工进程都拿不到 key，员工只调用 `media_*` 工具，拿回的是文件路径和大小。`private/service.env` 里不再配置 `ELEVENLABS_API_KEY`。

**安装（老板在终端做，一次性）**

```sh
sh <release>/vault/build.sh                        # 在固定 release 目录里构建（与插件同一提交），装到 <服务目录>/bin/sck-vault，并生成 plist
<服务目录>/bin/sck-vault setup                     # 先用 Touch ID 确认，再隐藏输入 ElevenLabs key，只写入钥匙串
cp <服务目录>/vault/org.surrealck.vault.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.surrealck.vault.plist
```

首次录入后正常不会弹窗。签名决定信任粒度：

- 登录钥匙串里存在 `SCK Vault Code Sign` 签名身份时，`build.sh` 自动用它签名，钥匙串信任锚在证书上，**重建二进制不再弹窗**。创建一次即可：生成自签名代码签名证书（代码签名 EKU）导入登录钥匙串。
- 没有该身份时回退 ad-hoc 签名：信任绑定这份二进制的确切哈希，**每次重新执行 `build.sh` 后钥匙串弹窗一次**。确认弹窗来自 sck-vault 后选择「始终允许」，然后执行 `launchctl kickstart -k gui/$(id -u)/org.surrealck.vault` 重启。

`build.sh` 与插件必须使用同一个服务目录：构建时用 `SCK_SERVICE_HOME` 指定，插件启动时使用同样的环境变量。

`private/service.env` 中的 `ELEVENLABS_API_KEY=` 一行，在新插件生效并验证之后删除，然后轮换该 key（旧 key 以明文存在过，员工可能读到过）。

**调用（无需授权）**

```sh
<服务目录>/bin/sck-vault status   # {"configured": true} 表示密钥就绪
```

操作种类：`tts`、`dialogue`、`sfx`、`music`、`voice_design`、`voice_create`、`voices`、`subscription`。密钥录入后员工即可调用，不需要老板批准——vault 的职责只有一条：密钥不出进程。员工侧的租约、角色与项目每日配额由插件代码判断。

**安全边界**

- 员工进程、插件和 TypeScript 代码都没有 key。vault 的回复里也不含 key：上游回显的 key 会被替换成 `[已遮盖]`。
- vault 只访问 `api.elevenlabs.io` 的固定端点，不跟随重定向，调用方不能指定 URL 或请求头。
- 钥匙串只信任这一份二进制。副本放在别的路径运行时，会拒绝读取密钥。
- 加固运行时，且没有调试权限，同用户的其它进程拿不到 vault 的内存。
- 同一台 Mac 上的任何本地进程都能调用固定端点操作。vault 分辨不出调用者身份，员工级的租约和角色检查仍在插件里；绕过插件直调 socket 无法拿到 key，但能发起上游调用，这是已接受的残余面。
- 同一时间只能有一个 sck-vault 监听 socket。

**配额与审计**

- 每个项目每日的上限（tts 1500、dialogue 600、sfx 300、music 60、voice_design 30）仍由公司侧计数，可用 `SCK_MEDIA_DAILY_*` 调整。`media_info`、`media_voices` 不计次数。
- 成功生成写 `ops_media_*` 审计。
- vault 另有哈希链审计 `<服务目录>/vault/audit.log`，只记录事件、操作种类、次数和字节数，不含 key。

## 远程部署（VPS MCP 服务）

`sh scripts/deploy-mcp-remote.sh <main 提交 SHA>` 把指定提交部署到 VPS 的 `sckcompany` 服务，并校验 `/ready`。部署认证只用专用密钥 `~/.ssh/sck-deploy-ed25519`：密码短语保护、不进 ssh-agent、不存钥匙串，`SCK_DEPLOY_KEY` 可换路径。`IdentitiesOnly` 固定身份，全部连接复用一条控制通道，每次部署只需输一次密码短语。VPS 的 `authorized_keys` 只保留这把部署密钥；日常使用或已加载到 agent 的钥匙一律不得授权，否则任何同用户进程都能登录 VPS。

发布门禁（SYS01 AC-B）：慢管道回归与 sidecar review 回归只在本机 macOS 上执行，不用托管 macOS 作业，也不新增付费资源。发布某个提交前，把该提交导出到以 40 位提交 SHA 命名的目录，分别运行 `SCK_SERVICE_HOME=<服务目录> sh scripts/release-gate.sh slow-pipe <该目录的绝对路径>` 和 `SCK_SERVICE_HOME=<服务目录> sh scripts/release-gate.sh sidecar-review <该目录的绝对路径>`。脚本按 `SCK_BUN`、`private/service.env` 中的 `SCK_BUN`、服务目录的 `runtime-bun`、`~/.bun/bin/bun` 的顺序选定 Bun，不查 PATH；慢管道运行包含红色对照，sidecar-review 运行真实 client-cli -> 临时 sidecar -> 公司 fork 的整组用例，并连同演练（deploy-drill）套件一起执行：Node 宿主端口探测与 Bun 解析、依赖安装来源、以及 `deployDrillRun`/`deployDrillStatus` 的角色与持有人守卫回归（`tests/deploy-drill{,-runner,-node-host}.test.ts` 与 `tests/deploy-drill-access.fork.test.ts`，后者由 `RUN_SCK_DRILL_ACCESS_TESTS=1` 打开）。这几项托管 CI 都跑不了——Node 探针需要真实 Node 二进制，权限与演练需要公司 fork 与真实 macOS 进程树——所以它们必须在这里挡住发布。门禁在跑之前逐个核对清单里的文件都在 release 内：`bun test` 对匹配不到任何文件的过滤参数会以 0 退出，缺一个演练测试而不核对，就会为一段从未执行的测试记下 pass。两项 `result` 都为 `pass` 时分别写入 `<服务目录>/gates/comm-slow-pipe/<SHA>.json` 与 `<服务目录>/gates/sidecar-review/<SHA>.json`，记录 `sha`、`bun`、`platform` 与 `result`。`company-service.sh install` 与 `company-service.sh check-gate <SHA>` 在切换前核对两项记录；任一缺失、失败、SHA 不符或 Bun 版本不符都拒绝。这两项不读调用方 shell 中的 `SCK_BUN`：launchd 启动的服务不继承它，门禁只核对服务实际会运行的运行时（`private/service.env` 中的 `SCK_BUN`、`runtime-bun`、`~/.bun/bin/bun`）。显式指定的 pin 缺失时拒绝，不回落到其它 Bun。

已披露的残留（SYS01 复核）：`deploy-mcp-remote.sh` 安装远端 Bun 时直接执行 bun.sh 的安装脚本，未做 sha256 校验；`scripts/release-content.sh` 的清单比较只看文件内容，不看权限位。前者列为后续跟进。`release-gate.sh` 按目录名取 SHA 一项已关闭：`release-gate.sh` 与 `company-service.sh install` 都调用 `scripts/release-content.sh`，把目录内容与提交归档逐文件比较（依赖、生成的 `plugin/server/vendor`、`vault/build` 与 `.runtime/` 不计入），内容不符即拒绝。

`deploy-mcp-remote.sh` 在任何远端步骤前核对同一记录（Bun 版本取 `SCK_BUN_VERSION`，缺省 1.4.2）。随后在远端执行 `runtime-bun/bin/bun --version`，实际版本与门禁不符时在上传载荷前拒绝，不复用旧二进制。两项都通过后才上传 release、写入 `service.env`、切换 `current` 并重启。`SCK_REMOTE_HOME` 只供测试覆盖：`tests/ci-gates.test.ts` 以桩化的 ssh 与 scp 运行脚本，不触及真实主机；生产路径不设置。最终集成提交若与审查过的提交不同，必须对该集成 SHA 重新生成门禁记录，不能复制旧记录或改写 JSON。

## Magpie 四档模型与最终绩效路由

故事作者保持原有编制、客户端和模型。其余角色各保留一个 Claude 编制，合并原岗位轨；产品默认 `group/sck-sonnet`，GM 默认 `group/sck-opus`，其他岗位（含 QA、eval）默认 `group/sck-haiku`。Fable 仅作为老板手动入口，不进入员工请求；员工网关把旧会话残留的 Fable 模型名映射到岗位默认档位，老板个人通过 Magpie 手动使用 Fable。旧客户端编制停用，已有任务及历史身份保留；旧会话完成任务、解除实现人绑定后按既有退役保护正常回收。

四个公开入口为 `group/sck-fable`、`group/sck-opus`、`group/sck-sonnet`、`group/sck-haiku`。员工网关把每个请求改写成一个 magpie 档位分组：租约档位是上限，手动选择可以降到更便宜的档，不能升档；任何具体模型名（含 Claude Code 自带的 `claude/claude-sonnet-5-5` 等）都改写成租约档位分组。网关从不发送具体模型 ID：2026-10-23 曾因固定了一个下架的具体模型，被 magpie 改由 Claude 订阅的 sonnet 应答并继续固定，越出档位。岗位不再拆分能力档和绩效排名。请求名含 Haiku 也属于任务工作，只有 count_tokens 为辅助接口。老板个人配置和压缩窗口471000不改。

`src/model-routing/benchmarks.json` 保留 AA Intelligence Index 来源及采集时间。老板规则：任何档位的模型 AA 分数不得低于 38（`AA_FLOOR`），没有公开分数的模型不进入任何档位，新上架模型同样按此过滤。分界线以模型为锚（老板 2026-10-23 定，`TIER_ANCHORS`），锚模型被 AA 重新打分时分界线随之移动：分数不高于 deepseek-v4.1-flash 的进入 Sonnet，Haiku 与 Sonnet 共用同一组成员；高于 deepseek-v4.1-flash、不高于 claude-sonnet-5.5 的进入 Opus（含 gpt-6.1-sol、claude-sonnet-5.5）；高于 claude-sonnet-5.5 的进入 Fable。Fable 只供老板手动使用，其模型被排除时暂用 Opus 的成员；档位是能力分段，不等同于模型厂商品牌。空档只借用更强档。模型绩效采用统一排名、八任务先验、30天半衰期；相同规范模型名跨账号共享证据。`tierOverrides` 和 `disabledModels` 允许维护时校正和排除。首次四档迁移清除旧三档覆盖，重新按快照初始化。

派工器只处理角色/岗位轨、仓库与写入隔离、独立验收、实现人连续性、租约和本机总并发。受管员工复用空闲会话，保留返工接续，不再按订阅额度/账号并发/配置模型漂移或员工分数挑模型，也不再调用 Jev 做二次员工选择。故事作者维持原派工策略。Magpie 负责模型/账号可用性、额度、顺序回退和档内隔离；公司代码只维护 Fable、Sonnet、Haiku；Opus 的成员、顺序和组内配置由老板在 Magpie 手动维护。

四个入口为 magpie 分组 `sck-fable/opus/sonnet/haiku`。Opus 完全交由老板在 Magpie 手动维护：公司不创建、重建、删除、添加成员、归一化思考等级、恢复历史排序或改写任何组内配置，缺组或空组也不自动补建。以下自动管理规则仅适用于其余三组（`routing=order`、`stays=session`）。**分组成员归老板管**：自动分档只在 `GROUPING_VERSION` 变化时整体初始化一次，此后只把从未见过的新模型（AA ≥38）放进对应档位；老板在 magpie 里手动增删的成员不会被覆盖，手动移出的模型记入 `model-routing/membership.json` 的已知列表，不会被自动加回，手动加入的模型即使没有 AA 分数也保留。后台每五分钟只按 AA 先验与模型绩效重排各组成员顺序（读取 magpie `providers.json`，写入经 magpie 自身的保存接口）；同一租约用 `x-magpie-session` 由 magpie 保持在同一模型，额度或故障时由 magpie 在组内回退。不再有 magpie 选择中间件、best/explore 中间分组和网关模型固定；升级后首次同步会卸载旧的 `sck-performance` 中间件并删除 `sck-route-*` 分组。故事作者正在使用的旧组保留。请求热路径不查询远端数据库：租约来自 sidecar 内存，执行元数据经本地 fsync+rename 队列入库，不保存提示词/回复/密钥。

有效员工会话的模型调用资格与任务写入租约分开：submit/review 成功会立即消耗任务租约，随后 Claude 仍需处理工具结果、输出收尾；工程、产品等已登记会话此时按岗位默认档位继续调用，记录 task 为空、phase=idle，不进入任务模型绩效。GM/eval 的 planning 行为不变。新任务写入和供应商操作仍须原有有效租约；未登记、隔离或过期的在途租约不会获得任务权限。插件重载恢复期间模型网关返回503及 Retry-After:1，恢复完成后才核对会话；未登记会话仍拒绝409。

任务经过所有提交、退回和修复，最终达到 done 后才进入 eval。普通返工中不结算。eval 使用 `get_task_history` 和 `get_model_evidence` 关联 employee、实际 model、fence、阶段和时间，分别评价返工责任与修复贡献。`record_score.scores[].modelScores` 为实际模型独立的 overall/notes；单模型可继承该员工的最终综合分，多模型缺少独立判断时不虚构质量分。每模型按1/模型数量分配参与者样本权重，请求数量不决定质量。历史记录写 actual_models，配置保留 configured_model。已重新打开的任务不进入排序，重新结算按确定ID替换旧样本。上线测试中的模型选择与评分证据来自隔离公司 fork，不制造生产绩效。

发布从 main 固定提交生成快照，运行加法迁移033。暂停新派工后、切换生产代码前执行新 main release 的迁移入口（此时旧租约继续有效）：

```sh
"$HOME/Library/Application Support/SurrealCKCompany/runtime-bun/bin/bun" "$SCK_RELEASE_DIR/scripts/model-routing-admin.ts" migrate
```

迁移先备份完整编制到私有 model-routing/employee-defs-four-tier-before.json，准备四档分组和插件，再停用非故事作者的旧客户端编制、更新 Claude 编制/员工默认模型，最后启用。切换双面 release 后，仅空闲无租约会话更新 Paseo 模型默认和 v2 网关配置；忙会话先完成当前工作。`model-routing-admin.ts status` 查看计数。恢复维护前的 paused 状态，核对真实派工与实际模型执行。

回滚：先暂停新派工，用本 release 的 `model-routing-admin.ts disable` 恢复编制和员工私有网关设置并停用插件；等待 pendingSessionReloads 清零，再按双面回滚流程恢复前一 release。历史证据不删除。


### Jev 组内排序

老板工作台「编制 → 模型排序」提供自然语言规则与 2/5/10 分钟下拉选项（默认 5）。自然语言规则默认为「智能程度和速度综合优先」，未设置或保存空白时也使用该规则；已有非空规则保持不变。每组最近一次 Jev 调用前保存实际请求体（model/state/questions）及调用开始时间到 company_meta:model_ranking_request_<tier>，Sonnet、Haiku 各保留一条；旧 Opus 请求及评分保留为历史但不再展示或应用。界面可折叠查看结构与完整 JSON，失败尝试也保留，不含 HTTP 认证头。旧调用没有快照时显示尚无记录，不用当前数据补造历史。保存只更新这两个设置并重置触发时钟，下一次有效员工模型请求（含 count_tokens）到达公司网关后，后台启动一次刷新；同一时刻只有一轮，前台请求不等待数据库、额度查询或 Jev。到期且没有新请求时不调用 Jev。重启后首个请求会刷新。

每轮共用一次数据采集，仅对 `sck-sonnet`、`sck-haiku` 各独立调用一次 Jev。Opus 不采集排序事实、不调用 Jev、不参与公司置顶操作；在 Magpie 编辑其成员、顺序与组内配置。输入包含组内每个模型的订阅标签（不传邮箱）、最紧窗口剩余额度百分比、AA 排名和分数、每百万 token 输入/输出/缓存命中价格（Magpie 标注免费时为 0）、近 7 天缓存命中率与输出 tokens/s、首 token 延迟，以及已最终验收任务的模型绩效和样本权重。缺失数据保持未知；调用失败、答案不完整或分数越界时保留该组顺序，界面显示刷新结果。保存期间旧轮次作废，关闭插件停止发布结果。

完整老板规则会写入每个独立评分问题及每个评分档位，明确排最后条件不能被其他综合优势抵消；首 token 延迟额外换算为秒直接提供，未知数据不被视为满足或违反条件。阈值来自老板自然语言规则，不在代码中写死 10 秒；最终仍按 Jev 返回的分数排序，实测通过不代表所有未来规则都必然正确。

实时使用统计取自本机 Magpie `GET http://127.0.0.1:3425/v1/magpie/usage?period=7d`，每轮排序在调用 Jev 之前重新读取一次，不缓存到下一轮。严格按原生 `provider/model` 路径匹配；供应商内嵌路径（如 `remote-magpie/codearts/...`）完整保留，不再用去供应商的模型简称。原生统计按通道汇总历史各思考等级，提示词明确说明该范围；无本通道样本时保持未知，不用别的供应商或远端分组的统计补齐。输出速度直接使用 Magpie 已筛选的 `decode_out / (decode_ms / 1000)`，不从 CSV 的总输出 token/耗时另算；首 token 延迟使用原生平均值。Jev 的 usage 数据同时带来源、7d 窗口及起点、采集时间、测速与延迟样本数；原生 API 失败或格式不符则终止本轮并保留原排序，不用旧快照继续刷新。接口返回的账号、host、key 与会话信息不进入 Jev 数据。

AA 榜单与价格保存在服务目录 `model-routing/aa.json`，每日刷新，失败保留最后可用快照；锚模型不齐或页面解析异常时不替换数据。自动分组版本不变，仅初始化及首次出现的新模型参与分组，仍遵守 AA≥38 和现有锚模型规则；手动增删成员不会因重新评分而重置。Jev 只能排列当前组内成员，不能跨组添加模型。Fable 不参与 Jev 或绩效排序，保留老板顺序。Magpie 自己提供组内回退与会话粘性，网关始终发送原生组名；不设置 effort 上限。

### 思考等级与模型对应（老板 2026-10-23 定）

AA 按思考等级分别打分（显示名括号里的 Max/Xhigh/High…，slug 常省略最高档），因此分档用的是**该成员实际发送等级**下的分数：自动管理的 Fable/Sonnet/Haiku 组中，自动入组或成员写成裸 ID 时，控制器按 Magpie 目录 `reasoning_levels` 中能发送的等级，选该模型分数最高的等级，并把成员写成 `provider/model:<等级>` 固定（如 `codex/gpt-6-luna:max`，38.1 分才达门槛）。Magpie 发不出 AA 测分等级的不入组（如只提供 low/high/xhigh 的 deepseek-v4.1-flash）；厂商在模型 ID 里已写死等级的（`gpt-6-luna-max`，无可选等级）按 AA 显示名匹配，不加后缀。老板手动写上的等级保持不变。各组成员若在其发送等级下无分数、低于 38 或分数落在别的档，记入 `company_meta:model_routing_status.issues` 并在「编制 → 模型与 AA 榜单对应」提示，只提示不移除。

名称匹配：AA slug 与显示名（去括号再拼等级）都参与精确匹配；去掉厂商前缀（`zai_glm-5.3-flash`）和 Magpie 上下文变体后缀（`grok-4.7@500k`）；日期快照后缀照旧。规则仍对不上的新模型，每个只问一次 Jev（选择题：按名称相近取 8 个 AA 候选加「都不是」），置信 ≥0.7 才采用，否则只记为建议；结果存 `model-routing/aliases.json`，老板可在同一页面改为某个 slug 或设为不对应，尚未进组的模型下次同步按新分数分组。远端 Magpie 新增模型需要本地重新拉取清单：控制器每天对 `preset=remote-magpie` 的供应商执行一次 `magpie provider refresh`。

本地 `model-routing/inventory.json` 是持久模型处理台账：按供应商完整模型 ID 记录当前目录、当前分组与历史裁决（规则精确匹配、Jev、人工或既有分组接纳）。首次部署扫描全量可调用模型，之后仅处理台账尚无裁决且未在组内的 ID；已裁决无对应/未达准入线的模型不会再次询问 Jev，分组版本升级、重启与暂时下架不清空历史。旧 `aliases.json` 自动迁入；该文件仍保留为映射兼容文件，必要时从台账恢复。每个 Jev 有效答案立即原子保存，后续请求或组同步失败不重问已完成的答案；无效答案不标为完成。台账损坏时停止同步，避免从空状态重新付费裁决。

编制页分别显示「已入组」「已裁决但未入组」「待裁决/待人工确认」，已完成映射默认收入历史；既有组成员不会再次进入待裁决。人工修改与后台目录同步串行执行并更新台账；名称确认不代表移动已有组成员，分档警告单独展示。

设置和结果分别位于 `company_meta:model_routing` 的 `ranking_rules`/`ranking_refresh_minutes` 与 `company_meta:model_ranking`。设置 RPC 只允许老板上下文。发布后通过界面保存当前规则，再对一个已登记的空闲员工调用 `count_tokens` 触发后台刷新，检查 Sonnet/Haiku 两组结果和 Magpie 顺序，同时确认成员集合、Fable 顺序及 Opus 的完整分组配置未变。


### Factory 优先的原生员工编制

编制保留 Claude、Factory（`factory-droid`）及故事作者特例；删除其他 provider 的非故事作者定义。Factory 保留原生 provider、模型与思考设置，并恢复额度门禁；Claude 继续使用岗位默认的 Magpie 组。老板编制列表把 Factory 排在前面。

派工选人不调用 Jev。资格检查（岗位/轨道、项目、额度与健康、席位与并发、原实现人绑定、验收回避及独立性）通过后，先复用 Factory，再使用可新建的 Factory 席位；Factory 没有可用候选时复用或新建 Claude。候选排序在本机执行，不为派工产生 Jev 调用。组内模型排序、最终验收绩效和上线判断仍使用各自原有机制。

从已合入 main 的固定 release 执行 `bun scripts/model-routing-admin.ts roster` 前暂停新增派工。该模式备份原编制后新增/更新保留定义并物理删除其余非 Claude 定义，不重建 Magpie 分组或改写排序规则。旧实例、任务和绩效历史保留；删除定义的实例不得接新任务，在途租约照常收尾，空闲且不再被未完成任务保护时退休。完成后检查 Factory 模型/provider 未变、非保留定义为零、故事作者前后相同，再恢复原派工开关。

## 源站主机：受限账号与只读运维工具

员工不持有源站 SSH 账号。源站上有两个专用账号，各绑一把只在本机的无口令密钥（`$SCK_SERVICE_HOME/private/origin/`，0600，连同固定的 `known_hosts`）：

| 账号 | 密钥 | 能做的唯一一件事 |
|---|---|---|
| `scktunnel` | `tunnel-ed25519` | 开状态面反向转发 `127.0.0.1:18778`；无 shell、无本地转发、无命令（`launchd` 任务 `org.surrealck.status-tunnel`） |
| `sckops` | `ops-ed25519` | 运行强制命令 `/usr/local/bin/sck-origin-agent`：`status`/`health`/`logs` 三个只读操作；无 sudo，经 `systemd-journal` 组读日志 |

限制两层叠加：`authorized_keys` 的 `restrict,command=…`/`permitlisten=…`，以及 `sshd_config` 末尾 `# sck-origin begin…end` 的 `Match User` 块（`PermitOpen none`、`ForceCommand`）。部署/重装由老板用自己的 deploy 密钥执行（幂等）：

```sh
scp scripts/origin-agent/{sck-origin-agent.py,install-remote.sh} <owner>@<host>:/tmp/
ssh <owner>@<host> 'sudo sh /tmp/install-remote.sh "$(cat tunnel.pub)" "$(cat ops.pub)" < /tmp/sck-origin-agent.py'
```

broker 侧在项目环境配置加 `origin: {host, user:"sckops", keyFile, knownHosts}`（本机绝对路径）即开放 `ops_origin_*`；`ops_info.can.originHost` 反映是否已配置。服务白名单在 agent 与 `src/ops/origin.ts` 两处保持一致。写操作（重启、改配置、升级 SurrealDB）不在此通道内。

## 员工沙箱

员工与老板、插件同是 macOS 用户 `y`，文件权限挡不住员工读公司凭证。所以公司会话一律在 Seatbelt 沙箱（`scripts/sandbox/employee.sb`）里启动，子进程会继承：

- **不可读写**：`<服务目录>/private`、`~/.ssh`（只放行 `config`、`known_hosts`、`id_ed25519.pub`，git 经 ssh-agent 推送）、`~/.paseo`、`~/.config/magpie`、Cloudflare/wrangler 配置。
- **不可连接**：Paseo daemon `localhost:6767`（员工会话里的 Paseo MCP 因此失效，公司流程不依赖它）、`~/.ssh` 与 `~/.paseo` 下的 unix socket、`sck-vault` socket。
- **不可执行**：`launchctl`、`osascript`、`open`、`crontab`/`at`、Paseo CLI；同时禁止 AppleEvents 和 LaunchServices。
- **不可写**：插件发布与运行时目录、沙箱自身、`~/Library/LaunchAgents`、shell 启动文件、`~/.gitconfig`、`~/.claude` 的全局设置/hooks/skills/plugins、`~/.local/bin`、`~/.local/share/claude`、`~/.bun/bin`、`~/node/bin`、`/Applications`、`/opt/homebrew`。

接线方式：插件在 `agent.session_open` 给公司会话加 `SCK_SANDBOX=employee`（resume 的会话按 label 识别后同样加上）。Paseo 的 `claude`、`factory-droid`、`antigravity` provider 命令替换成 `<服务目录>/sandbox/bin/*` 包装脚本，经 `launch.sh` 处理：有标记或 `SCK_COMM_DIR` 的会话进沙箱，profile 缺失时拒绝启动（exit 78）；老板自己的会话和 Paseo 的版本/登录探测原样运行。安装或更新（幂等，会备份 `~/.paseo/config.json` 并执行 `paseo reload`）：

```sh
sh scripts/sandbox/install.sh
```

插件每次打开公司交互会话时都会重读 `~/.paseo/config.json`。provider 不在 claude、factory-droid、antigravity 之列（codex 由多个 agent 共用同一个 app-server 进程，无法按会话进沙箱），或配置没有指向包装脚本时，直接拒绝打开会话（fail closed）；只读历史不受影响。已在运行的会话会沿用旧的启动方式，要重新打开会话才进沙箱：空闲时执行 `paseo agent reload <id>`。沙箱挡不住的同用户风险：埋进共享仓库、留给老板日后运行的代码（`.git/hooks`、依赖脚本），`~/.claude.json` 里的 MCP 配置（claude 本身要写这个文件），以及钥匙串里允许 `security` 读取的条目。要彻底隔离，只能让员工改用独立的 macOS 用户运行。

### 代码仓改绑后的实现人恢复

经理通过 `bind_task_code_repo` 明确改绑代码仓后，旧实现人会话仍可能绑定在原仓，仓库隔离与实现人连续性会共同挡住派工。调度器把这一明确错配纳入既有自动接替：仅在执行阶段，从任务当前仓库选择符合岗位、轨道、额度、独立性及策略约束的空闲工程员工，走版本校验与 `system:dispatcher` 接替审计，保留历史贡献及验收回避；下一轮正常领取。没有合法候选时等待并明确展示原因，不放宽跨仓隔离、不清实现人或作者记录。仅项目变化而无明确代码仓绑定不触发此恢复；同仓原实现人继续接续。
