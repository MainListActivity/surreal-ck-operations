# 本机公司任务服务运维与员工接入（#27）

## 固定版本和边界

本服务从 #24 核心 `7fc39c3`、#25 adapter `5f06b793` 集成，另纳入 [#29 官方 MCP 接入准备](./mcp-integration-preparation.md)和 [#26 QA 验收矩阵](./qa/mcp-company-acceptance.md)。代码发布为独立只读版本目录；运行中的 `active` 链接仅指向已提交、已安装依赖的 release，不指向工程或 QA worktree。服务权威是 SurrealDB 独立 `sck_agent_company/control_plane`；新建任务投影为带 `sck-company-task` marker 的 GitHub Issue。旧 #23—#29 的 v2 票仍由中央 `scripts/queue.py` 管理，不能用新 MCP 修改。

## 私有目录和进程

默认服务目录：`~/Library/Application Support/SurrealCKCompany`，权限 0700。目录结构：`releases/<commit>/` 为固定程序与 pnpm 依赖，`active` 为当前版本链接，`private/service.env` 为 0600 的路径/端口配置，`private/credentials/*.token` 为各员工独立 0600 文件，`private/gh-projection.json` 为 0600 持久投影进度，`logs/` 为仅本人可读日志。root 密码仅由现有产品 `.env` 在进程内加载；日志、Issue、客户端和提交不携带其值。

用户级 launchd label 为 `org.surrealck.company-mcp`（任务服务）与 `org.surrealck.company-dispatcher`（v3 调度器，同一发布目录）。脚本 `scripts/company-service.sh` 默认只操作 `mcp`；v3 的调度器已迁入 Paseo 插件 `sck-company`（连同员工通道与运维代理），不要再装 launchd 调度器，否则会重复派工。`SCK_COMPONENTS=dispatcher`（或 `"mcp dispatcher"`）仅为旧部署保留；安装时同时把员工工具 `bin/sck` 复制到服务目录。旧版 launchd 调度器需要 `private/service.env` 中的 `SCK_AGENT_CWD`（员工工作目录，运营仓库 checkout），可选 `SCK_PASEO_BIN`、`SCK_NOTIFY=0`（关闭 macOS 通知）。Plist 位于 `~/Library/LaunchAgents/org.surrealck.company-<组件>.plist`，`KeepAlive` 在进程异常退出后重启。停止后不会删除数据库、凭证、日志或发布目录。卸载只去掉本服务 plist 与进程，不动数据。

发布需先固定提交，并在版本目录运行 `rtk proxy pnpm install --frozen-lockfile`；将 `.env.example` 复制到上述 `private/service.env`，填入现有产品 env **路径**、确认空闲端口、GitHub 仓库和私有 GM 凭证**路径**，文件权限 0600。`rtk proxy sh scripts/company-service.sh install '/absolute/release/path'` 安装并立即启动。常用命令（在任意固定版本目录执行）：

```sh
rtk proxy sh scripts/company-service.sh status
rtk proxy sh scripts/company-service.sh restart
rtk proxy sh scripts/company-service.sh stop
rtk proxy sh scripts/company-service.sh start
rtk proxy sh scripts/company-service.sh uninstall
```

`GET http://127.0.0.1:<port>/health` 是进程存活探针；`GET /ready` 检查实际目标库 ownership marker 可读，200 为 ready、503 为不可用。两者仅本机可访问，且同样应用 Host/Origin 检查；MCP `/mcp` 仍须每次 Bearer 鉴权。检查时用 `rtk proxy curl --fail http://127.0.0.1:<port>/ready`，`rtk proxy lsof -nP -iTCP:<port> -sTCP:LISTEN`，`rtk proxy sh scripts/company-service.sh status`。日志在 `logs/stdout.log` 和 `logs/stderr.log`（调度器为 `logs/stdout-dispatcher.log`、`logs/stderr-dispatcher.log`），只记录监听端口、投影数量和不含原始错误的重试消息；不要把完整日志上传到 Issue。启动失败先检查私有配置路径、文件权限、端口占用、现有 SurrealDB 可达性与本机 gh 登录。回滚到前一固定目录：在前一版本运行同一 `install <previous-release>`；卸载如上。

**插件面同步（每次 release install 必做）**：任务系统是双部署面——launchd `org.surrealck.company-mcp` 跑 `active` 指向的 release，而员工 comm 通道（sck → sidecar → vendored core）与调度器跑在 Paseo 插件 `sck-company` 进程内，插件加载自 `/Users/y/IdeaProjects/surreal-ck-operations-v3/plugin`（分支 `ops/v3-paseo-dispatch`），其 `plugin/server/vendor/` 是 `src/`+`schema/` 的**手工生成拷贝**，不随仓库提交自动更新。只切 active 不同步插件面会导致通道用旧 core 校验（曾出现新岗位 create_task 被旧 ROLES 拒 `invalid: Invalid role`）。每次发布执行：

```sh
cd /Users/y/IdeaProjects/surreal-ck-operations-v3
git fetch origin && git status          # 确认工作树干净、识别未推送/在途提交（不得丢）
git merge origin/main                    # 把 release 基线并入插件分支并推送
sh plugin/scripts/vendor.sh              # 重新生成 server/vendor/src 与 server/vendor/schema
paseo plugin reload sck-company          # 重载插件（短暂中断派工循环，避开密集时段）
paseo plugin ls                          # 确认 sck-company running、无 error
```

reload 后用 `sck call get_context` 与实际派工各验证一次恢复。其它生成物：`plugin/node_modules` 由 `cd plugin && npm install` 管理，仅当 `plugin/package.json` 依赖变化时才需重装，无其它需同步的生成物。

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

**部署（插件面同步之外多一步退役桥接）**：先 `launchctl bootout gui/$(id -u)/org.surrealck.deliverable-preview` 退役旧桥接（plist 可留档），再走「插件面同步」流程（v3 merge + vendor.sh + `paseo plugin reload`）——插件侧 EADDRINUSE 每 2s 重试至 teardown，bootout 先行即无竞态。`lsof -nP -iTCP:18777 -sTCP:LISTEN` 与 `:18778` 确认监听进程已是 Paseo/插件而非独立 bun，`curl http://<lanIP>:18777/healthz` 200 即接管完成，旧 `/e/`、`/d/` URL 不变继续有效。

**状态观测**：`ops_info` 响应含 `preview` 段 `{lan:{running,port,lanUrl,uptime,lastError}, signed:{configured,running,port,uptime,lastError}, roots, lastError}`——loopback 探测 healthz 为准，失败回读插件写的 `$SCK_SERVICE_HOME/preview-status.json`。插件日志前缀 `[preview]`。

**应急兜底**：`src/preview-server.ts` 为同 core 的 bun 独立脚本（`bun src/preview-server.ts`，双监听与插件一致），插件整体不可用时可用 launchd 临时顶回；复制到 `bin/` 时连同 `preview-core.ts`、`preview-sign.ts` 一起（`cp src/{preview-server,preview-core,preview-sign}.ts $SCK_SERVICE_HOME/bin/`）。

## 员工客户端

> **v3 更新（sidecar/comm 通道）**：员工实例由 Paseo 插件 `sck-company` 注册代管，agent 进程零凭证——spawn env 只注入 `SCK_COMM_DIR` 和 `SCK_COMM_KEY`，实例凭证与租约证明留在插件进程内。claim/heartbeat/submit/review/blocker 由 sidecar 程序化代执行，租约证明自动注入，员工参数只写业务字段，`claim_next` 在员工侧不可用。comm 文件协议：`claim.json` 下发任务上下文，`report.md` 落盘即提交，`blocker.md` 上报阻塞（回合结束时由 sidecar 回收为 submit/report_blocker），`req/`+`res/` 原子转发 `sck call`。`get_secret`/`put_secret` 等凭证工具已下线，需要账号、workspace、生产登录走 `ops_*` 运维工具（先 `ops_info` 查能力清单）。legacy `credential_file` 实例不再被代领新任务，自然淘汰。架构、调用路径、安全边界与排障详见 [sidecar 通道](./sidecar-channel.md)；本节下述的凭证文件方式（`SCK_EMPLOYEE_CREDENTIAL_FILE` 与 `private/credentials/*.token`）仅为旧部署与 legacy 实例保留。

实际员工身份由公司库的 `employee` 凭证记录确定。七个固定身份为 `gm-01`(gm)、`product-01`(product)、`eng-01`/`eng-02`(engineering)、`ai-01`(ai-content)、`qa-01`(qa)、`cs-01`(cs)（concept-design、asset-production 等内容产线岗位由调度器按 employee_def 动态生成实例，不走固定身份）。令 `SCK_MCP_URL=http://127.0.0.1:<port>/mcp` 和 `SCK_EMPLOYEE_CREDENTIAL_FILE=<对应私人路径>`，执行 `rtk proxy pnpm run mcp:client -- list`、`rtk proxy pnpm run mcp:client -- call get_context '{}'`。客户端初始化和调用使用官方 MCP SDK；身份仅由 Bearer 凭证决定，不能在工具参数中伪装。`claim_next` 可传 `{"taskId":"..."}`；返回的 `deliveryId`、`fence`、`task.version` 构成后续 heartbeat/checkpoint/submit 的 proof。提交的 `idempotencyKey` 在网络丢响应重试时保持相同。

首次真实员工接入任务由 GM 管理工具创建，执行岗位 cs、验收岗位 qa。cs-01 必须在**自己的真实会话**用自己的凭证领取、heartbeat、checkpoint、submit；qa-01 在自己的会话领取 review 并 accept/return。工程的合成轮换凭证测试仅证明实现，不替代该交接。回执说明应含实际岗位、允许动作、四个操作的脱敏命令摘要和遇到的问题，不能包含凭证。任务 ID 与各自凭证**路径**交 #28；不要在 Issue 写值。

## QA 对接

按 [#26 B01—B12](./qa/mcp-company-acceptance.md) 独立执行，尤其 B09 重启持久化、B11 非目标库与日志、B12 两位真实员工。#29 的 SDK/Bun 探针属于前期资料，#25 的合成三 token 联调也不等于 B12。QA 应记录本集成提交、`pnpm-lock.yaml` 哈希、URL、目标库、进程状态和脱敏日志路径。当前核心与 adapter 的准确 DTO、错误码、工具参数参见 `src/contracts.ts`、`src/mcp/server.ts` 和 [adapter 文档](./mcp-adapter.md)；本说明不修改已冻结的业务权限与租约语义。


## WT01 登记、分配与上线验证

物理工作目录以任务服务的 `worktree` 登记为准，任务分支与物理树分开：每仓一个 shared（QA/经理/产品/CS/内容默认只读），串行工程在无活动引用且干净时复用它、每项独立 `task/<id8>` 分支/PR；已有引用或 dirty 时新代码写手用 exclusive，原现场不切分支。内容写任务由管理方在 `create_task.workIntent` 显式授予 `{kind:"assets",paths:["assets/characters"]}`；重叠目录排队（大小写保守视为相同），互不重叠可共用，路径穿越/凭证目录/符号链接目录拒绝。GM/eval 无租约唤醒用 `workspace.json` 的 shared 只读登记与会话引用。附件保持 `evidenceDir`。

仓库身份由 realpath + git common-dir 确定，未绑定 project 使用 `SCK_AGENT_CWD` 的规范仓库身份。MCP 与插件共同使用 Git common-dir 下的 `sck-worktree-allocation.lock`，由系统 `/usr/bin/python3` 的 kernel flock 持有（进程退出释放）；机器已有 Python，不安装全局工具。领取事务同时更新 task assignment、worktree_ref、employee active_task 和租约，失败不会落有效引用；网络丢响应重复 claim 保留 fence/路径。Git 树先登记，异常中断后未知树受保护，已存在的 task 分支现场就地接管，不 reset。引用有效性实时由任务 current_employee/delivery/fence/状态对账；撤销交接与被阻塞的写现场继续保护。main、常驻插件、active/回滚 release 均登记 protected。WT01 停止在生产注入旧按任务分支删除物理树的 sweeper，**不启用新的删除策略**，`deletable=false` 及 reasons 可查询。

查询入口：员工 `sck call list_worktrees '{"taskId":"当前任务ID"}'`，权限沿用 get_task；GM 可不传 taskId 查询全局。返回规范路径、稳定 ID、project/repo、mode、实际/登记 branch 状态、创建/最后使用时间、各引用持有人/任务/时间及保护原因；不含凭证。branch 漂移或丢失只报告，不自动修复。

本链实现提交只创建 PR，不发布。上线申请批准后的部署腿执行以下验证，具体演练见 [WT01 操作手册](./qa/worktree-allocation.md)：

1. 记录 MCP active release 提交、插件分支提交、vendor 的 core/schema 哈希及进程 running；在已批准提交建立固定 release，运行依赖安装和本地 fork 回归。MCP bootstrap 新增 schema 011（只新增结构，无数据删除/改写）；插件必须在 bootstrap 成功后同步相同 src/schema。
2. 按上文双面流程切 fixed release、同步 `/Users/y/IdeaProjects/surreal-ck-operations-v3/plugin` 的受控源码与 vendor/schema，reload **现有** `sck-company`；保留插件在途提交，不另起 dispatcher。
3. 验证 MCP `/ready`、插件 running、真实员工 `get_context` 与真实派发恢复；记录两面实际提交/时间。经理安排真实串行 QA/工程及并行代码写手演练，QA 用普通通道读登记，不取得凭证、不自行建员工。证据含任务 ID、实际路径/branch、audit ID/时间、登记/有效引用 before/after，区分本地与生产。
4. 分配策略需要回退时，两面同时设置 `SCK_WORKTREE_STRATEGY=legacy`（只对后续新分配恢复独占，已有 assignment 优先），restart MCP + reload 现有插件。保留 schema 011、登记与在办现场，不运行旧清理、不降级到不认识 worktree 的旧 core。两面代码回滚也须保留 WT01 登记兼容版本。

新业务环境变量：无。可选策略开关仅用于受控回退；系统 Python 和现有 Git 是本机准备项。
