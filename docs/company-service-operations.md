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

变更在登记任务分支完成、通过评审后，按正常流程 PR 合入 `origin/main`（不允许把未合并的基线/任务分支直接切 release）。合入后 `rtk git fetch origin`，取 `origin/main` 的完整 SHA 作为本次 `SCK_BASELINE_SHA`——release 快照即该提交的内容。

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

### 5. 双面回滚

**兼容目标是回滚的前提（RW06）**：切换（install 与远端 deploy）在内容绑定之后、任何副作用（bin 复制、`active` 链接、插件重指、MCP 重启、快照清理、远端上传）之前，用 `scripts/review-wait-guard.sh` 读取**目标自身的代码**判定兼容性：目标必须带 `src/review-wait-capability.ts` 的协议标记、`src/core.ts` 中的“按原阶段解锁”语句（`$restore_phase`）与 `src/contracts.ts` 的 resume 视图字段；本地 install 还要求插件 vendor 同源，远端 deploy 只查核心。不兼容、不可读或无法证明的目标一律拒绝，**没有“当前没有等待项所以放行”的例外**（检查之后并发产生的等待会绕过这种检查）；拒绝发生在任何切换副作用之前，并输出目标、原因与 `waiting items=unknown`（切换脚本没有受权的公司数据读取接缝，不能据此声称没有等待项）。
只有证明兼容的目标才能切换；旧版本（如 9854fe0、475b5c2 及其后的旧快照）不是固定可回退版本。没有可用兼容目标时，保持当前健康版本、受控 hold，或走受审的前向修复，不得把破坏复核阶段的旧版当成可用性恢复，也不得以伪 accept 或改库换取回滚条件。窗口内切换前仍须按第 4 节采样并证明没有活复核租约（或使用已独立部署验收、支持复核 adopt 的版本）。

**先停用受影响编制再回滚**：由经理通过现有管理通道暂停这些编制，记录原 enabled 状态，防止旧 core 对新岗位/策略继续派工；核对在办任务并保留租约、comm、登记与审计。回滚目标须同时兼容当前岗位与 WT01/WT02 登记，不能任意选更早版本；不删除 schema、历史或任务数据。

```sh
# 用当前（受审、带守卫）release 的 installer 安装回滚目标：守卫与内容/门禁校验都在这一步完成。
rtk proxy env SCK_COMPONENTS=mcp sh "$SCK_RELEASE_DIR/scripts/company-service.sh" install "$SCK_PREVIOUS_RELEASE"
rtk proxy curl --fail 'http://127.0.0.1:<mcp-port>/ready'
# 插件面由上面的 install 自动重指（登记在服务目录内时）；这里只核对，不重复 install。
rtk proxy "$PASEO_CLI" plugin ls sck-company
```

**不得调用旧 release 自带的 installer**：旧版本的 `scripts/company-service.sh` 没有 RW06 守卫，实测对不兼容目标会直接 `rc=0` 切 `active` 并复制 bin（全新 installer 对同一目标则拒绝且零副作用）。回滚命令固定用 `$SCK_RELEASE_DIR/scripts/company-service.sh`（`$SCK_RELEASE_DIR` 为当前受审 release）。若 install 输出 `warning: plugin repoint failed`（插件登记在服务目录之外），按第 3 节 R3 手工 `remove` + `install` 指向**已被守卫放行的同一目标**，顺序不得颠倒。

回滚恢复的是上一版完整固定 release（含集成过的在途功能、依赖与 vendor），不能只改 `active` 或只 reload。重做第 4 节的双面验证；仅恢复与回滚版本兼容的编制，其余保持停用并报经理。旧 release 不完整/不兼容或回滚失败时保留现场并报阻塞，不回退到 v3 历史树作为生产源。

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
ssh -N -R 127.0.0.1:18778:127.0.0.1:18778 ubuntu@<remote-host>
# VPS Caddyfile（data.maplayer.top 站点内追加）
handle_path /pv/* { reverse_proxy 127.0.0.1:18778 }
```

签名只覆盖 `pathname`（如 `/e/<taskId>/<file>`），Caddy 去前缀后一致，`SCK_PREVIEW_PUBLIC_BASE=https://data.maplayer.top/pv`。备选：cloudflared named tunnel 直指 :18778（需 CF 凭证经 ops_* 申请）。

签发链路：收件箱附件行按下 → 插件 `company.attachments.url` 校验文件确在 `evidence/<taskId>` 内 → 返回预览 URL → `openExternalUrl` 打开；老板任意设备浏览器直接消费，图片仍走 `attachments.read` data-URI 内联。URL 形态按老板口径为 LAN `http://<lanIP>:<port>/e/…`（无签名、无时效）；公网签名 URL 通道保留待用（签名面 :18778 + 隧道/Caddy），激活后此 RPC 如需恢复 `base+签名路径` 形态只需切回签发分支。

**员工交付发布工具 `deliverable_publish`**（sidecar 基础工具，`sck call deliverable_publish '{"files":[绝对路径…],"taskId"?}'`）：把文件/目录复制进 `$SCK_SERVICE_HOME/deliverables/<taskId>/` 并返回 `/d/` 路由的 LAN 可点 URL；taskId 缺省取在手租约。同名覆盖、隐藏名跳过、symlink 解引用；任一输入路径无效即整体报错不落半截包。员工证据里的预览链接一律用它返回的 URL。收件箱 `attachments.url` 当前按老板 LAN 口径直接返回 `/e/` 无签名 URL；公网签名通道（preview-sign + 签名面 :18778 + 隧道/Caddy）保留待用，配置 `SCK_PREVIEW_SECRET` 后插件 reload 即激活签名面。

**部署（插件面同步之外多一步退役桥接）**：先 `launchctl bootout gui/$(id -u)/org.surrealck.deliverable-preview` 退役旧桥接（plist 可留档），再走上文「插件面同步」的基线集成、固定 release 打包、launchd install 与 `paseo plugin install <release>/plugin` 重注册流程——插件侧 EADDRINUSE 每 2s 重试至 teardown，bootout 先行即无竞态。`lsof -nP -iTCP:18777 -sTCP:LISTEN` 与 `:18778` 确认监听进程已是 Paseo/插件而非独立 bun，`curl http://<lanIP>:18777/healthz` 200 即接管完成，旧 `/e/`、`/d/` URL 不变继续有效。

**状态观测**：`ops_info` 响应含 `preview` 段 `{lan:{running,port,lanUrl,uptime,lastError}, signed:{configured,running,port,uptime,lastError}, roots, lastError}`——loopback 探测 healthz 为准，失败回读插件写的 `$SCK_SERVICE_HOME/preview-status.json`。插件日志前缀 `[preview]`。

**应急兜底**：`src/preview-server.ts` 为同 core 的 bun 独立脚本（`bun src/preview-server.ts`，双监听与插件一致），插件整体不可用时可用 launchd 临时顶回；复制到 `bin/` 时连同 `preview-core.ts`、`preview-sign.ts` 一起（`cp src/{preview-server,preview-core,preview-sign}.ts $SCK_SERVICE_HOME/bin/`）。

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

工程的实现任务（kind=task）提交时，系统会读 submit 证据里链接的 GitHub PR（`gh pr view`），只检查**头分支就是本任务登记分支**的那个 PR：与主干冲突、已关闭未合并、或有失败的 CI 检查，提交会被直接拒收（`invalid`，任务仍是 doing），员工修好后重新提交，不再占用一次验收。CI 还在跑不算失败；证据里没有 PR 链接、链接的是别的分支、或 `gh` 查询出任何问题时一律放行，由验收人照常检查。上线申请、合入部署和其他岗位不受影响。`SCK_PR_GATE=0` 关闭（MCP 与插件两面都要设）。

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

发布门禁（SYS01 AC-B）：慢管道回归与 sidecar review 回归只在本机 macOS 上执行，不用托管 macOS 作业，也不新增付费资源。发布某个提交前，把该提交导出到以 40 位提交 SHA 命名的目录，分别运行 `SCK_SERVICE_HOME=<服务目录> sh scripts/release-gate.sh slow-pipe <该目录的绝对路径>` 和 `SCK_SERVICE_HOME=<服务目录> sh scripts/release-gate.sh sidecar-review <该目录的绝对路径>`。脚本按 `SCK_BUN`、`private/service.env` 中的 `SCK_BUN`、服务目录的 `runtime-bun`、`~/.bun/bin/bun` 的顺序选定 Bun，不查 PATH；慢管道运行包含红色对照，sidecar-review 运行真实 client-cli -> 临时 sidecar -> 公司 fork 的整组用例。两项 `result` 都为 `pass` 时分别写入 `<服务目录>/gates/comm-slow-pipe/<SHA>.json` 与 `<服务目录>/gates/sidecar-review/<SHA>.json`，记录 `sha`、`bun`、`platform` 与 `result`。`company-service.sh install` 与 `company-service.sh check-gate <SHA>` 在切换前核对两项记录；任一缺失、失败、SHA 不符或 Bun 版本不符都拒绝。这两项不读调用方 shell 中的 `SCK_BUN`：launchd 启动的服务不继承它，门禁只核对服务实际会运行的运行时（`private/service.env` 中的 `SCK_BUN`、`runtime-bun`、`~/.bun/bin/bun`）。显式指定的 pin 缺失时拒绝，不回落到其它 Bun。

已披露的残留（SYS01 复核）：`deploy-mcp-remote.sh` 安装远端 Bun 时直接执行 bun.sh 的安装脚本，未做 sha256 校验；`scripts/release-content.sh` 的清单比较只看文件内容，不看权限位。前者列为后续跟进。`release-gate.sh` 按目录名取 SHA 一项已关闭：`release-gate.sh` 与 `company-service.sh install` 都调用 `scripts/release-content.sh`，把目录内容与提交归档逐文件比较（依赖、生成的 `plugin/server/vendor`、`vault/build` 与 `.runtime/` 不计入），内容不符即拒绝。

`deploy-mcp-remote.sh` 在任何远端步骤前核对同一记录（Bun 版本取 `SCK_BUN_VERSION`，缺省 1.4.2）。随后在远端执行 `runtime-bun/bin/bun --version`，实际版本与门禁不符时在上传载荷前拒绝，不复用旧二进制。两项都通过后才上传 release、写入 `service.env`、切换 `current` 并重启。`SCK_REMOTE_HOME` 只供测试覆盖：`tests/ci-gates.test.ts` 以桩化的 ssh 与 scp 运行脚本，不触及真实主机；生产路径不设置。最终集成提交若与审查过的提交不同，必须对该集成 SHA 重新生成门禁记录，不能复制旧记录或改写 JSON。

## Magpie 模型分档与绩效路由

模型选择与员工身份分开。公司 Claude 执行通道通过本机 `127.0.0.1:18779` 网关调用 magpie，能使用 magpie 目录中的其他供应商模型；员工、岗位轨、实现人绑定、租约和独立验收规则沿用现有流程。其他客户端的存量会话不伪造实际模型证据。

`src/model-routing/benchmarks.json` 保存带来源与采集时间的公开 Intelligence Index 快照。精确版本匹配（含 `-1017` 这类日期快照后缀）按 >=48 / >=38 / 其余分高/中/低；没有公开数据、预览名和不透明别名明确标为 `estimated`，放中档并以 2.5 的先验排在该档末尾，由任务证据提升：未测出不等于能力弱（如 deepseek-v4.1-flash 实际任务表现较好）。某档为空时借用更高一档，只升不降。同一模型经不同账号提供（如 `codex/…` 与 `remote-magpie/codex/…`）共享任务证据，按规范模型名汇总。`company_meta:model_routing.tierOverrides` 可覆盖已核实的模型分档，`disabledModels` 可排除通道。更新模型目录每五分钟进行；不把模糊相似名称自动当作同一模型。

任务可在 `create_task` 指定 `modelTier=high|medium|low`；省略时，工程、经理、长篇/编剧、上线和老板关口默认高档，常规任务中档，明确的整理归档任务低档。每档按 engineering/writing/general 分别学习优先级。模型评分使用最近180天任务证据、30天半衰期和8个样本的公开排名先验；混合执行按成功请求份额分配一个参与者的任务权重。评分有真实模型、请求完成和HTTP状态的正面证据才归因；断流、额度错误及缺失模型标识不虚构成功记录。`scorecard.configured_model` 保留配置，`actual_models` 与 `model_scorecard.model` 记录实际模型ID，多模型显示 mixed，缺少实证显示 unknown。

选择插件是 `magpie/sck-performance.gateway.js`，使用 `onRequest`（250ms限额）读取 magpie 内存选项，选中一个完整的原生顺序回退组；避免从只有账号信息的 `strategies` 席位猜测模型。后台先生成完整分组，再发布插件选项。10% 的首次选择探索组内其他模型；网关按任务/参与者/租约fence/阶段固定成功模型，额度或通道失败时回到本档原生回退组。模型组整体额度拒绝会写入任务派工退避；原生 Claude 订阅额度不再代表整个分组的可用性，magpie 仍执行每个真实账号的额度上限。

Claude Code 的小模型辅助请求（模型名含 haiku：标题、命令前缀检查、摘要等）保留原模型，不进入分档组、不固定租约模型、不触发组退避，执行记录标 `phase=auxiliary` 且不计入模型评分。

网关运行在 `sck-company` 插件进程内：插件 reload（每次发布）会中断在途流式请求，Claude Code 按网络错误自动重试；插件启动失败时已切到网关的 Claude 员工无法推理，按下方回滚恢复直连 magpie。

推理请求路径不查询远端数据库：sidecar 的内存租约决定任务与档位，本地 fsync+rename 队列保存无提示词/回复/密钥的执行元数据，后台批量入库。队列按版本确认，远端写入期间的完成更新不会被误删；评分后迟到的完成记录会重算归因，不会重复增加样本。远端数据库不可用时保留最后一份路由策略与本地队列。lease 到期则本地拒绝新推理。

发布仍执行上述 main 双面流程。新 release 的 MCP bootstrap 完成加法迁移032后，在暂停新增派工的维护窗口执行：

```sh
"$HOME/Library/Application Support/SurrealCKCompany/runtime-bun/bin/bun" "$SCK_RELEASE_DIR/scripts/model-routing-admin.ts" enable
```

该操作先准备分组和插件，完成后才启用路由；备份 Claude 编制的模型/额度门禁配置，并将其模型显示设为分档组。插件 reload 后自动只为无租约且空闲的 Claude 会话刷新启动配置；忙会话先完成当前工作。员工私有目录的 `.claude/settings.local.json` 覆盖网关地址，保留其余设置与原值备份；老板个人的压缩窗口471000及个人会话不被改写。用 `model-routing-admin.ts status` 查看模型/分档计数，`company_meta:model_routing_status` 查看模型清单、证据来源和排序。

功能回滚：先暂停新派工，执行同一 main release 中的 `model-routing-admin.ts disable`，恢复编制与员工本地设置并停用选择插件。输出 `pendingSessionReloads` 非零时，等待这些忙会话完成并恢复其会话，再按前述双面流程切回旧代码；旧 release 没有18779网关，不能先切旧代码再恢复客户端。模型证据表和历史不删除。
