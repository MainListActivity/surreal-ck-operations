# 节点运维手册（0.7.0）

本文说明执行节点（老板的 Mac 或其他执行端）上需要运维的部分，并记录仍然有效的业务规则与运行约定。0.7.0 起，节点只运行两样东西：

1. **Paseo 插件 `sck-company`**：派工调度器、员工通道 sidecar、老板接口（端口 18777）、交付预览与运维代理都在插件进程内。
2. **节点更新器**：安装为定时任务，按最新正式 Release 把插件切换到新版本。

节点上没有独立的任务服务进程，也没有 MCP 端点。任务、租约与审计都在云端公司库（SurrealDB）。节点只通过插件访问它。升级与回退见 [company-upgrades.md](./company-upgrades.md)。

## 服务目录

默认服务目录为 `~/Library/Application Support/SurrealCKCompany`，可用 `SCK_SERVICE_HOME` 覆盖。目录权限为 0700。

| 路径 | 内容 | 来源 |
|---|---|---|
| `current` | 符号链接，指向现役插件目录 `plugin-releases/<sha>/plugin`。员工命令从这里运行。 | 节点更新器（`src/node-updater.ts` 的 `pointCurrent`） |
| `plugin-releases/<sha>/` | `release.json`、`plugin/`（含 node_modules）、`scripts/sck.sh`、`scripts/bun-runtime.sh` | 节点更新器从发行包解压 |
| `bin/sck` | `scripts/sck.sh` 的副本，权限 700 | 节点更新器（切换成功后） |
| `bin/bun-runtime.sh` | `scripts/bun-runtime.sh` 的副本，权限 700 | 节点更新器 |
| `updater/` | `node-updater.js`（600）、`run.sh`（700）、运行锁 `lock`、回退冷却记录 `rolled-back.json` | 节点更新器安装与运行 |
| `private/` | `owner-token`（0600，插件启动时生成）、`node-id`、`cloud/`（云端凭证文件）、`company-db.env`（本机库，若使用）、`service.env`（可选，路径与端口配置） | 插件与运维人员 |
| `logs/` | `node-updater.log`、插件与本机数据库的日志 | 各组件 |
| `runtime-bun/` | 可选，服务固定的 Bun 运行时 | 运维人员 |

`sck` 与 `bun-runtime.sh` 解析 Bun 的顺序为：环境变量 `SCK_BUN`，`private/service.env` 中的 `SCK_BUN=` 行，`runtime-bun/bin/bun`，最后是 `~/.bun/bin/bun`。不查找 PATH（见 `scripts/bun-runtime.sh`）。显式指定的 `SCK_BUN` 即使不存在也不会被替换。

`private/service.env` 只写路径与端口，权限 0600，不进仓库。常用项：

- `SCK_PREVIEW_PORT`：LAN 面端口，缺省 18777。老板接口 `sck owner` 也读这一项。
- `SCK_PREVIEW_SIGNED_PORT`：签名面端口，缺省 18778。
- `SCK_PREVIEW_SECRET`：签名面 HMAC 密钥，未配置则签名面不启动。
- `SCK_PRODUCT_ENV`、`SCK_AGENT_CWD`、`SCK_PASEO_BIN`、`SCK_NOTIFY`、`SCK_NOTIFY_WEBHOOK`：见仓库根 `.env.example`。

## 节点组成与首次安装

首次安装顺序：

1. 准备工具：Node.js 22 或以上、`tar`、`pnpm`、已登录的 `gh`，以及 Paseo CLI。
2. 准备云端凭证文件（只放路径，不复制内容）：`private/cloud/runner-client-secret`（权限 0600）；`COMPANY_DB_URL`、`IDP_ISSUER`、`RUNNER_CLIENT_ID` 可作为环境变量设置，也可写入 `private/company-db.env`。缺少 `COMPANY_DB_URL` 时节点更新器拒绝运行。
3. 在干净的 main 检出目录执行 `sh scripts/node-updater.sh install`。它下载最新正式 Release 的 `manifest.json` 与 `node-updater.js`，校验后注册定时任务，并立即运行一轮。这一轮会注册并启动插件。
4. 按 [company-upgrades.md](./company-upgrades.md#首次安装节点更新器) 的验证步骤确认插件状态与 `current` 指向。
5. 员工沙箱（`sh scripts/sandbox/install.sh`）按下文「员工沙箱」一节手工安装，节点更新器不负责它。

`scripts/node-updater.sh` 支持 `install`、`run`、`status`、`uninstall`。`install` 与 `uninstall` 的细节见 company-upgrades.md。

## 员工命令 `sck`

员工会话里的工具入口是 `bin/sck`（即 `scripts/sck.sh`）。它把请求交给 `current/server/vendor/src/sck-cli.ts` 运行。

```sh
"$HOME/Library/Application Support/SurrealCKCompany/bin/sck" list
"$HOME/Library/Application Support/SurrealCKCompany/bin/sck" call get_context '{}'
```

- `sck list` 与 `sck call <工具> '<JSON>'` 只走员工通道（comm）。需要环境变量 `SCK_COMM_DIR` 与 `SCK_COMM_KEY`。插件 sidecar 在会话启动时注入这两个变量。`sck.sh` 也会读取 `comm-agents/<PASEO_AGENT_ID>` 指针文件，以便插件重启后找到最新的通道。
- 缺少 `SCK_COMM_DIR` 时 `sck` 报 `missing_comm_dir` 并退出，不会回退到其他身份。
- 没有现役插件（`current` 不存在）时报 `missing_plugin`；Bun 运行时缺失时报 `missing_runtime`。
- 每次输出都是一行 JSON。失败时同时在 stderr 给出原因，退出码为 1。

员工的身份由插件通道决定，不能在参数里指定。员工凭证不落盘，也不进入环境变量（见 [sidecar 通道](./sidecar-channel.md)）。

## 老板接口 `sck owner`

老板命令走插件的老板接口，即 LAN 面上的 `/api/owner/<命令>`：

```sh
"$HOME/Library/Application Support/SurrealCKCompany/bin/sck" owner <命令> '<JSON>'
```

命令名以 `plugin/server/owner-api.ts` 的路由为准，例如 `task.create`。

- 端口读取 `private/service.env` 中的 `SCK_PREVIEW_PORT`，缺省 18777。请求发往 `127.0.0.1`。
- 鉴权使用 `private/owner-token`（由插件 `ensureOwnerToken` 在启动时生成，权限 0600）。命令行只读取该文件，不打印令牌。
- `X-Owner-Agent` 头取自环境变量 `SCK_OWNER_AGENT`，缺省为 `cli`。
- 服务端的 `/api/owner/*` 路由由 `plugin/server/owner-api.ts` 处理，要求 Bearer 令牌。

## 健康检查

| 检查 | 命令 | 正常结果 |
|---|---|---|
| 交付预览与老板接口端口 | `curl -sf http://127.0.0.1:18777/healthz` | `{"ok":true,"port":18777,"uptime":...}`（`src/preview-core.ts`） |
| 签名面（配置了 `SCK_PREVIEW_SECRET` 时） | `curl -sf http://127.0.0.1:18778/healthz` | 同上 |
| 插件注册 | `paseo plugin ls sck-company --json` | `status` 为 running，`enabled` 为 true，`path` 指向 `plugin-releases/<sha>/plugin` |
| 节点更新器 | `sh scripts/node-updater.sh status` | 定时任务已加载，日志最后 40 行 |
| 云端节点记录 | 见 company-upgrades.md 的 `node_release` 查询 | `checked_at` 为近期时间 |
| 预览状态 | 读取 `<服务目录>/preview-status.json` | 插件写入，记录两个监听面的状态 |

`/healthz` 不鉴权。0.7.0 的插件没有 `/health` 或 `/ready` 路由。

日志：节点更新器写 `logs/node-updater.log`；插件日志前缀为 `[preview]` 等。排查时先看 `node-updater.log` 的最后一行 `结果: …`。

## 数据库与云端迁移

- **云端公司库**：节点通过 runner 身份连接，凭证为 `private/cloud/runner-client-secret`。节点不执行 schema 迁移。
- **迁移**：只由 CI 的 release 作业执行一次，即 `bun scripts/company-migrate.ts`，使用 migrator 凭证。节点与运维人员不需要运行它。迁移只在 `v<版本>` 尚未发布时执行，见 company-upgrades.md。
- **本机 company-db（可选）**：在仓库检出目录执行 `sh scripts/company-db.sh install`，即可在本机启动公司 fork 的 SurrealDB（只监听 127.0.0.1，端口缺省 38480，可用 `SCK_COMPANY_DB_PORT` 覆盖），并安排每小时一次的 R2 备份与每周一次的恢复演练。它只用于本机测试或回放，不是节点运行的必要部分。待确认：0.7.0 后节点是否仍需要本机库，由老板决定。
  - 安装写入三个 launchd 任务：`org.surrealck.company-db`、`org.surrealck.company-backup`、`org.surrealck.company-verify`。
  - 工作目录与备份入口来自执行安装的检出目录：launchd 的 `WorkingDirectory` 为该仓库根目录，备份与 verify 使用该目录下的 `scripts/company-backup.ts`（见 `scripts/company-db.sh` 第 8 行）。不再使用 `$service/active`。
  - 移动或删除该检出目录后，需要在新位置重新执行 `sh scripts/company-db.sh install`，否则备份与恢复演练的入口会找不到。
  - 凭证写入 `private/company-db.env`（权限 600，随机生成）。运行入口 `bin/company-db` 通过环境变量读取凭证，不放在命令行参数里。
  - 数据目录为 `private/db`。
  - 内存预算（`scripts/company-db-runtime.sh`）：跟踪内存阈值 2 GiB（`SURREAL_MEMORY_THRESHOLD`），RocksDB block cache 512 MiB，write buffer 32 MiB，最多 4 个 write buffer。这些是准入控制，不是操作系统对进程 RSS 的硬上限。
  - 本地测试只用公司 fork（`~/.surrealdb/surreal`），不使用上游 SurrealDB。

## 交付预览

交付预览服务内嵌在插件进程中（`plugin/server/preview.ts`），随插件启动、随 reload 或卸载停止，不另起守护进程。

- **LAN 面**：`0.0.0.0:SCK_PREVIEW_PORT`（缺省 18777）。提供 `/e/`、`/d/`、`/healthz` 与 `/o/`、`/api/owner/` 等路径。除 `/api/owner/*` 外无鉴权，仅供老板局域网设备访问。
- **签名面**：`127.0.0.1:SCK_PREVIEW_SIGNED_PORT`（缺省 18778），仅在配置了 `SCK_PREVIEW_SECRET` 时启动。所有 `/e/`、`/d/` 请求必须带 `exp` 与 `sig`，未签名返回 401，过期返回 403。
- 签名面只监听回环地址。若要公网访问，需要自行配置隧道或反向代理，并以签名面为入口。此仓库中的代码不包含隧道配置。待确认：`SCK_PREVIEW_PUBLIC_BASE` 当前代码不读取，原文中的公网基址设置已删除。
- 绑定失败时每 2 秒重试，直到插件停止。

员工交付使用 `deliverable_publish` 工具，把文件复制到 `deliverables/<任务ID>/` 并返回可点击的 `/d/` 链接。

## 员工沙箱

员工与老板、插件是同一个 macOS 用户 `y`，文件权限挡不住员工读取公司凭证。所以公司会话在 Seatbelt 沙箱（`scripts/sandbox/employee.sb`）中启动，子进程会继承：

- **不可读写**：`<服务目录>/private`、`~/.ssh`（只放行 `config`、`known_hosts`、`id_ed25519.pub`，git 经 ssh-agent 推送）、`~/.paseo`、`~/.config/magpie`、Cloudflare/wrangler 配置。
- **不可连接**：Paseo daemon `localhost:6767`（员工会话里的 Paseo 自带 MCP 因此失效，公司流程不依赖它）、`~/.ssh` 与 `~/.paseo` 下的 unix socket、`sck-vault` socket。
- **不可执行**：`launchctl`、`osascript`、`open`、`crontab`/`at`、Paseo CLI；同时禁止 AppleEvents 和 LaunchServices。
- **不可写**：插件发布与运行时目录、沙箱自身、`~/Library/LaunchAgents`、shell 启动文件、`~/.gitconfig`、`~/.claude` 的全局设置/hooks/skills/plugins、`~/.local/bin`、`~/.local/share/claude`、`~/.bun/bin`、`~/node/bin`、`/Applications`、`/opt/homebrew`。

接线方式：插件在 `agent.session_open` 给公司会话加 `SCK_SANDBOX=employee`（resume 的会话按 label 识别后同样加上）。Paseo 的 `claude`、`factory-droid`、`antigravity` provider 命令替换成 `<服务目录>/sandbox/bin/*` 包装脚本，经 `launch.sh` 处理：有标记或 `SCK_COMM_DIR` 的会话进沙箱，profile 缺失时拒绝启动（exit 78）；老板自己的会话和 Paseo 的版本/登录探测原样运行。安装或更新（幂等，会备份 `~/.paseo/config.json` 并执行 `paseo reload`）：

```sh
sh scripts/sandbox/install.sh
```

插件每次打开公司交互会话时都会重读 `~/.paseo/config.json`。provider 不在 claude、factory-droid、antigravity 之列（codex 由多个 agent 共用同一个 app-server 进程，无法按会话进沙箱），或配置没有指向包装脚本时，直接拒绝打开会话（fail closed）；只读历史不受影响。已在运行的会话会沿用旧的启动方式，要重新打开会话才进沙箱：空闲时执行 `paseo agent reload <id>`。

沙箱挡不住的同用户风险：埋进共享仓库、留给老板日后运行的代码（`.git/hooks`、依赖脚本），`~/.claude.json` 里的 Claude 自身 MCP 配置（claude 本身要写这个文件），以及钥匙串里允许 `security` 读取的条目。要彻底隔离，只能让员工改用独立的 macOS 用户运行。

待确认：`scripts/sandbox/install.sh` 当前每次运行都会复制 `launch.sh`（第 15 行）。0.7.0 设计要求安装时不再刷新 `launch.sh`，代码尚未对齐。

## 媒体生成（sck-vault）

ElevenLabs 的 key 只存在于 `sck-vault` 里。它是一个独立的小程序，key 保存在登录钥匙串中，钥匙串只信任这一份二进制。插件和员工进程都拿不到 key，员工只调用 `media_*` 工具，拿回的是文件路径和大小。`private/service.env` 里不再配置 `ELEVENLABS_API_KEY`。

**安装（老板在终端做，一次性）**

```sh
sh vault/build.sh                                  # 构建，装到 <服务目录>/bin/sck-vault，并生成 plist（待确认：构建在 main 检出目录执行，vault/ 不在插件发行包白名单内）
<服务目录>/bin/sck-vault setup                     # 先用 Touch ID 确认，再隐藏输入 ElevenLabs key，只写入钥匙串
cp <服务目录>/vault/org.surrealck.vault.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.surrealck.vault.plist
```

`build.sh` 与插件必须使用同一个服务目录：构建时用 `SCK_SERVICE_HOME` 指定，插件启动时使用同样的环境变量。

首次录入后正常不会弹窗。签名决定信任粒度：

- 登录钥匙串里存在 `SCK Vault Code Sign` 签名身份时，`build.sh` 自动用它签名，钥匙串信任锚在证书上，**重建二进制不再弹窗**。创建一次即可：生成自签名代码签名证书（代码签名 EKU）导入登录钥匙串。
- 没有该身份时回退 ad-hoc 签名：信任绑定这份二进制的确切哈希，**每次重新执行 `build.sh` 后钥匙串弹窗一次**。确认弹窗来自 sck-vault 后选择「始终允许」，然后执行 `launchctl kickstart -k gui/$(id -u)/org.surrealck.vault` 重启。

`private/service.env` 中的 `ELEVENLABS_API_KEY=` 一行，在新插件生效并验证之后删除，然后轮换该 key（旧 key 以明文存在过，员工可能读到过）。

**调用（无需授权）**

```sh
<服务目录>/bin/sck-vault status   # {"configured": true} 表示密钥就绪
```

操作种类：`tts`、`dialogue`、`sfx`、`music`、`voice_design`、`voice_create`、`voices`、`subscription`。密钥录入后员工即可调用，不需要老板批准。vault 的职责只有一条：密钥不出进程。员工侧的租约、角色与项目每日配额由插件代码判断。

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

## 源站只读运维代理

源站（VPS）上有两个专用账号，各绑定一把只在本机的无口令密钥。它们存放在 `<服务目录>/private/origin/`（权限 0600）。

| 账号 | 密钥 | 能做的事 |
|---|---|---|
| `scktunnel` | `tunnel-ed25519` | 开反向转发 `127.0.0.1:18778`。无 shell、无本地转发。 |
| `sckops` | `ops-ed25519` | 运行强制命令 `/usr/local/bin/sck-origin-agent`，只提供 `status`、`health`、`logs` 三个只读操作。无 sudo。 |

限制两层叠加：`authorized_keys` 的 `restrict,command=…`/`permitlisten=…`，以及 `sshd_config` 末尾 `# sck-origin begin…end` 的 `Match User` 块（`PermitOpen none`、`ForceCommand`）。

源站的安装由老板在源站上用自己的 deploy 密钥执行（幂等）：

```sh
scp scripts/origin-agent/{sck-origin-agent.py,install-remote.sh} <owner>@<host>:/tmp/
ssh <owner>@<host> 'sudo sh /tmp/install-remote.sh "$(cat tunnel.pub)" "$(cat ops.pub)" < /tmp/sck-origin-agent.py'
```

项目环境配置中加入 `origin: {host, user:"sckops", keyFile, knownHosts}`（本机绝对路径）即开放 `ops_origin_*` 工具。`ops_info` 的 `can.originHost` 反映是否已配置。服务白名单在 agent 与 `src/ops/origin.ts` 两处保持一致。写操作（重启、改配置、升级 SurrealDB）不在此通道内。

待确认：原文记录的本机 `org.surrealck.status-tunnel` 任务当时已停用。0.7.0 是否仍需要它，由老板确认。

## 磁盘与产物回收

`evidence/<任务ID>/` 与 `deliverables/<任务ID>/` 是工作存储，终态任务的这两个目录会被定期回收。老板可手工运行：

```sh
pnpm run admin reclaim-artifacts                      # 只读试算
pnpm run admin reclaim-artifacts 20480                # 压力模式试算：目标空闲 20480 MB
pnpm run admin reclaim-artifacts --execute            # 真的回收
pnpm run admin reclaim-artifacts <任务ID> --execute   # 只回收指定任务
```

参数里的裸数字是目标空闲 MB，不是任务 ID。目标目录只接受 `<根>/<任务ID>` 这一层普通目录，符号链接不跟随。台账写在 `<服务目录>/logs/artifact-reclaim.jsonl`，每次运行一行汇总，被删目录各一行。回收的保留期、开关语义与资源闸门见下文「资源、产物与数据库」。

## 停用与卸载

| 动作 | 命令 | 说明 |
|---|---|---|
| 停用节点更新器 | `sh scripts/node-updater.sh uninstall` | 移除定时任务，保留 `plugin-releases`、`updater` 与日志。之后节点不会自动升级。 |
| 停用插件 | `paseo plugin remove sck-company` | 移除插件注册，插件进程随之停止。节点上不再有派工与员工通道。 |
| 停用本机库（若安装过） | `launchctl bootout gui/$(id -u)/org.surrealck.company-db` 等三个任务 | 待确认：`company-db.sh` 没有卸载子命令。停用后数据目录 `private/db` 保留。 |
| 停用旧公司 MCP 服务（0.6.x 节点若曾安装） | `launchctl bootout gui/$(id -u)/org.surrealck.company-mcp`，再删除 `~/Library/LaunchAgents/org.surrealck.company-mcp.plist` | 0.7.0 不会自动停用它。它若仍在运行，会继续从旧的 `active` 目录提供旧代码。 |
| 清理旧版遗留（0.6.x 节点） | 确认旧 MCP 已停用后：`rm "<服务目录>/active"`（只删链接），再 `rm -r "<服务目录>/releases"` | 节点更新器不删除它们，0.7.0 的 `sck` 与插件也不读取它们。`releases/` 只是旧 MCP 的源码快照，`private/` 中的凭证与配置不受影响。 |
| 停用员工沙箱 | 手工还原 `~/.paseo/config.json` 中 provider 命令（备份文件 `config.json.bak-sandbox-*`） | 之后公司会话不再进入沙箱。 |

停用与卸载都不删除数据库、凭证、日志或插件发行目录。

## 业务规则与运行约定

本节是仍然有效的业务规则与运行约定，与节点部署方式无关。节点切换到 0.7.0 不改变这些规则。

### 任务与目标

#### SYS05 时间与外部事件等待

任务等待语义已收敛为两件事：链上前驱未完成时子任务保持 `planned`（accept 同事务激活）；需要老板决定时任务 `blocked` 且 `blocked_to='owner'`（进老板收件箱）。结构化等待、处置账本与 CI 处置工具已随目标层一起删除。

#### SYS07 目标终验图、客户成果与经营指标

目标不再由「最后一个任务被接受」隐式关闭；`accept` 之后的完成判定改为显式重算，写不进证据的目标停在 `needs_repair`。

#### 产线与岗位契约

不同产线流程不同（软件交付、视频、长篇故事），所以目标模板按产线选，不再全公司一套。

- **路由**：任务唯一的编排单位。`route` 表把任务类型（`software` / `story` / `film` …）映射到执行岗、复核岗与消息模板，可选 `next` 后继类型在创建时展开为 `planned` 链（accept 同事务激活）。新任务经 `sck owner task.create '{"type":"<类型>","title":"…"}'` 创建，`task.plan` 先预演链；路由由 `route.list`/`route.save`/`route.disable` 管理（`route.save` 拒绝执行岗=复核岗与成环后继）。
- **岗位契约**：项目岗位轨词表里每条轨可写 `roles: [...]`，限定能承接它的岗位。建单（`create_task` / `create_delivery`）时校验：派给轨不允许的岗位会被拒绝；任何出现在某条轨 `roles` 里的岗位都是产线岗，建单必须挂轨。没有出现在任何 `roles` 里的岗位（gm、product、qa 等）仍可建不挂轨的协调任务。契约写在项目记录里，改项目配置即生效，不需要改代码。
- `screenwriter` 仍保留原有的"必须挂 编剧 轨"硬规则。

#### 老板改派命令

任务被派错岗位时（例如岗位或产线调整后，存量任务还挂着旧岗位），不要直接改库：

```sh
pnpm run company reassign <任务ID> [--executor <岗位>] [--reviewer <岗位|owner>] "<原因>"
```

只改还没开工的任务：状态必须是 blocked 或 ready，没有有效租约，也从未提交过。改派前会按创建时同样的规则校验：项目岗位契约（轨限定的承接岗位）和必配轨岗位（screenwriter、story-author、cinematography），并写一条 `reassign` 审计，任务版本加一。同一请求重放是幂等的。已开工、已提交或已完成的任务会被拒绝。

#### 老板作废、解锁与取消目标

```sh
pnpm run company revoke <任务ID> ["<原因>"]      # 终止在途执行：撤当前持有人租约回 ready，任务保留等下一位
pnpm run company void <任务ID> "<原因>"          # 作废：只等它的下游自动解锁；终验关口作废不会关闭目标
pnpm run company unlock <任务ID>                 # 补跑依赖解锁：依赖都完成了任务却还是 blocked 时用
sck owner task.void '{"taskId":"<任务>","reason":"<原因>"}'   # 作废任务并级联作废其 planned 后继
```

`revoke` 与 `void` 的区别：revoke 只撤在途租约（员工换人或路线变更时用，任务本身继续），void 是把任务整个作废。两者在插件「目标进展」页（任务详情与目标卡按钮）和网页审核台（/o/<token>/，目标页与待办关口按钮）也能直接操作，不用开终端。

都带审计和幂等键，规则与老板入口的 `task.void`/`task.revoke` 一致：已完成的任务不能作废，还有活下游的老板关口不能作废。**不要再直接改库改任务状态**。绕过解锁逻辑会让下游一直卡在 blocked（2026-10-11 的小说目标就这样卡过一次）。

#### 往返熔断

同一个任务在员工与老板之间反复"阻塞 → 老板处理 → 再阻塞"（`block` 审计），达到 `block_loop_limit`（默认 5）次，调度器不再重复提醒，而是把任务转成老板的待办问题：写明往返次数和最近三次阻塞原因，老板回复后任务按回复继续，并重新计数。`pnpm run admin config block_loop_limit <n>` 调整，`0` 关闭。起因：一个生产实测任务曾在 18 小时内往返 19 次、换了 18 个员工，每轮都在重复同样的失败。

#### 代码仓改绑后的实现人恢复

老板通过 `bind_task_code_repo` 明确改绑代码仓后，旧实现人会话仍可能绑定在原仓，仓库隔离与实现人连续性会共同挡住派工。调度器把这一明确错配纳入既有自动接替：仅在执行阶段，从任务当前仓库选择符合岗位、轨道、额度、独立性及策略约束的空闲工程员工，走版本校验与 `system:dispatcher` 接替审计，保留历史贡献及验收回避；下一轮正常领取。没有合法候选时等待并明确展示原因，不放宽跨仓隔离、不清实现人或作者记录。任务有效仓库（显式代码仓 > 任务项目仓 > 目标项目仓 > ops 仓）与实现人会话仓库不一致时也触发恢复；接替继续执行独立性门禁；同仓原实现人继续接续。

### 员工与通道

#### 员工客户端

员工通过 `sck` 命令与插件通道通信，不直接调用 MCP。在员工会话内执行：

```sh
'<sck>' list
'<sck>' call get_context '{}'
'<sck>' call get_task_history '{"taskId":"<任务ID>"}'
```

`<sck>` 指 `bin/sck`（完整路径见「员工命令」一节）。工具调用统一写作 `'<sck>' call <工具名> '<JSON参数>'`。

- 身份仅由插件通道决定，不能在参数里伪装；`claim_next` 在员工侧不可用，领取由 sidecar 代执行，见 [sidecar 通道](./sidecar-channel.md)。
- 领取返回的 `deliveryId`、`fence`、`task.version` 构成后续 heartbeat、checkpoint、submit 的 proof，由 sidecar 自动注入，员工参数只写业务字段。待确认：`idempotencyKey` 在网络丢响应重试时是否仍需由调用方保持相同，sidecar 是否自动生成，需核对 `plugin/server/sidecar.ts`。
- `get_secret` / `put_secret` 已下线。需要账号、workspace、生产登录，走 `ops_*` 运维工具（先 `ops_info` 查能力清单）。

实际员工身份由公司库的 `employee` 凭证记录确定。七个固定身份为 `gm-01`(gm)、`product-01`(product)、`eng-01`/`eng-02`(engineering)、`ai-01`(ai-content)、`qa-01`(qa)、`cs-01`(cs)（concept-design、asset-production 等内容产线岗位由调度器按 employee_def 动态生成实例，不走固定身份）。

0.7.0 起没有员工凭证文件：旧的 `SCK_EMPLOYEE_CREDENTIAL_FILE` 与 `private/credentials/*.token` 已删除，legacy 实例也不再代领新任务。

#### QA 对接

0.6.x 的 MCP 验收清单 `docs/qa/mcp-company-acceptance.md` 已在 0.7.0 删除。待确认：替代的 QA 验收清单尚未建立，由 QA 与老板确定。发布后的真实员工 `sck` 最终验收由 QA 任务执行，验收记录应包含本集成提交、`pnpm-lock.yaml` 哈希、目标库、进程状态与脱敏日志路径。当前工具参数与 DTO 以代码为准，待确认：`src/contracts.ts` 与 `plugin/server/sidecar.ts` 的对应范围。

#### WT01 登记、分配与上线验证

物理工作目录以任务服务的 `worktree` 登记为准，任务分支与物理树分开：每仓一个 shared（QA/老板/产品/CS/内容默认只读），串行工程在无活动引用且干净时复用它、每项独立 `task/<id8>` 分支/PR（基线优先仓库已取回的 origin/defaultBranch，未配置 remote 时用默认主线）；已有引用或 dirty 时新代码写手用 exclusive，原现场不切分支。内容写任务由管理方在 `create_task.workIntent` 显式授予 `{kind:"assets",paths:["assets/characters"]}`；重叠目录排队（大小写保守视为相同），互不重叠可共用，路径穿越/凭证目录/符号链接目录拒绝。GM 无租约唤醒用 `workspace.json` 的 shared 只读登记与会话引用。附件保持 `evidenceDir`。

仓库身份由 realpath + git common-dir 确定，未绑定 project 使用 `SCK_AGENT_CWD` 的规范仓库身份。插件与 sidecar 共同使用 Git common-dir 下的 `sck-worktree-allocation.lock`，由系统 `/usr/bin/python3` 的 kernel flock 持有（进程退出释放）；机器已有 Python，不安装全局工具。领取事务同时更新 task assignment、worktree_ref、employee active_task 和租约，失败不会落有效引用；网络丢响应重复 claim 保留 fence/路径。Git 树先登记，异常中断后未知树受保护，已存在的 task 分支现场就地接管，不 reset。引用有效性实时由任务 current_employee/delivery/fence/状态对账；撤销交接与被阻塞的写现场继续保护。main、常驻插件目录、`current` 与回滚用的插件发行目录均登记 protected。

WT02 在 WT01 登记之上启用按归属回收：持久引用是唯一删除依据；租约过期/交接只释放员工 fence，非终态保留 recovery；done 后 exclusive 干净树可事件触发删除，shared 与保护树保留；脏树与未合并分支不强制删除。孤儿宽限默认 7 天（`SCK_WORKTREE_ORPHAN_GRACE_DAYS` / `company_meta:config.worktree_orphan_grace_days`），时钟用 last_released_at → last_used_at → created_at。调度器沿用既有 10 分钟 sweep，不新建定时器。紧急关闭：`SCK_WORKTREE_RECLAIM=0`（设在插件服务环境中）。审计表 schema 012 `worktree_audit` 可查。细节与演练见 [WT02 生命周期手册](./qa/worktree-lifecycle.md)。

查询入口：员工 `'<sck>' call list_worktrees '{"taskId":"当前任务ID"}'`，权限沿用 get_task；老板可不传 taskId 查询全局。非老板不带 taskId 一律 `forbidden`，通道不回退到当前租约任务。released 引用默认只计数，加 `"includeReleased":true` 才列出。返回规范路径、稳定 ID、project/repo、mode、实际/登记 branch 状态、创建/最后使用时间、各引用持有人/任务/时间、`deletable` 与 reasons；不含凭证。不带 `pageSize`、`cursor` 时返回完整数组，超出 48 KiB 预算则报 `response_too_large`，不截尾；带分页参数时返回 `{worktrees, page}`，按 `page.nextCursor` 逐页读完再统计（见 [query-paging.md](./query-paging.md) 第 3、4 节）。GM 另可 `reclaim_worktrees`（支持 dryRun）与 `list_worktree_audits`。branch 漂移或丢失只报告，不自动修复。待确认：`list_worktrees`、`reclaim_worktrees`、`list_worktree_audits` 在 0.7.0 的 sidecar 工具列表中是否仍然暴露，`sidecar-channel.md` 的工具列表未列出它们。

管理查询分页与预算（SYS01，v25）：运营需要知道以下行为。

- `get_context`、`get_task_history`、`list_worktrees` 的每个响应不超过 48 KiB，即 49152 字节（UTF-8）。计量为结果的 JSON 字节加 256 字节帧预留（`answerBytes`），答案的文本副本与 `structuredContent` 两份都计入（双份计量待确认，见 query-paging.md）。不带 `pageSize`、`cursor` 的旧调用返回完整结果，超出则报 `response_too_large`，不截尾。
- 需要统计或遍历全部条目时，带 `pageSize`（1 至 100，缺省 25）逐页读取，直到 `page.hasMore` 为 false，并累加每页的 `returned`。`page.total` 为快照内的总数，可用于核对。每页条数由预算决定，可能少于 `pageSize`。
- 分页快照由数据库统一计数，插件 sidecar 共用上限：每身份 4 个，全库 64 个，合计 64 MiB；单个快照最多 5000 行或 8 MiB，有效期 6 小时。上限在代码中固定，没有运营配置项。
- 全库快照已满时返回 `temporarily_unavailable`，可重试。同一身份的快照全部仍在写入时，请求最多等待 5 秒，且不超过本次构建的 10 秒截止。构建超过 10 秒截止，或排队超过 2 秒仍拿不到构建连接，都返回可恢复的 `temporarily_unavailable`；答复最迟在 13 秒内返回。已预留的配额在截止后 2 秒内释放，来不及释放的标记为待清扫，下一次清扫释放一次。50 KiB/s 等受限链路上，超过 10 秒可传输量的大工作集会以该错误返回，这是可恢复的拒绝而不是数据损坏，应按答复指引收窄 `state`、`tag`、`role`、`since` 或投影字段后重试。超过 5 分钟仍未完成的快照视为遗弃并删除。持续出现容量错误时，核对 `query_snapshot` 表的行数与 `query_snapshot_quota:global` 的 `listings`、`bytes` 计数是否一致。
- 长文本用 `read_task_text` 按字节段读取，每段默认 16 KiB、最大 24 KiB。第二段起必须带首段返回的 `expectSha256`，若原文已变，返回 `conflict`，须从 `offset: 0` 重读。
- 写入先于回显提交。回显先裁切超长列表（依赖、意图路径，标注 `listsTruncated`，完整列表用 `read_task_text` 读取），再裁切正文（标注 `contextTruncated`）；其余顶层文本字段超过 2 KiB 时同样裁切并标注。只有整条应答仍超过 49 152 字节时，调用方才会收到 `response_too_large`。此时写入已经提交，用 `get_context`（带 `taskId`）核对状态，不得重复提交。
- 全局库存只有老板可读，即不带 `taskId` 的 `list_worktrees`。非老板角色必须带 `taskId`，缺省或 null 一律返回 `forbidden`。
- `reclaim_worktrees` 参数严格（经理裁定 v44）：`dryRun` 只接受 true、false 或省略（省略即回收）；整包 null、`dryRun` 为 null 或字符串、`repos` 不是路径列表，一律返回 `invalid`，不触碰任何工作树。

QA 步骤对应如下。统计工作树数量时，先以老板身份执行 `list_worktrees` 分页读取，或对具体任务带 `taskId` 读取。遇到 `response_too_large` 时改用 `'{"pageSize":25}'` 并按 `page.nextCursor` 逐页读完。`get_admin_summary` 为老板专用的只读汇总，口径与完整性标志见 [query-paging.md](./query-paging.md) 第 5 节。

0.6.x 上线验证记录（历史，0.7.0 不再执行）：当时的步骤是记录 MCP active release 提交、节点 `sck-company` 的 path 与版本、vendor 哈希与进程状态；按已合入 main 的提交生成固定 release 并安装 MCP（launchd）；验证 `/ready`、插件 running、真实员工 `get_context` 与真实派发恢复。插件由节点更新器切换为该 main 提交的发行版本，不手工 `plugin install` 或 `reload` 现有 `sck-company`。0.7.0 没有 MCP 与 `active`，这些步骤已不适用。

新业务环境变量：可选 `SCK_WORKTREE_RECLAIM`、`SCK_WORKTREE_ORPHAN_GRACE_DAYS`；系统 Python 和现有 Git 是本机准备项。

#### 目标员工休眠与只读会话审阅（v0.3.56）

目标员工的身份、Paseo agent ID 与 provider session ID 独立于运行进程和每项任务租约。Paseo 空闲回收造成 closed 时，无在途租约且编制仍启用的目标员工进入 sleeping，保留原身份、通道及上下文，不主动 reload。下一次合法派工先取得新租约再通过同一 agent send 按需恢复。持有在途租约的 closed 员工仍走原有恢复与故障宽限；明确归档、真实错误、通道隔离仍保留退役规则。历史已退役身份不自动复活。休眠员工仍占编制实例名额，但不计入运行并发。Factory 优先于 Claude 上下文复用：合法 Factory 有空位时先创建或复用 Factory，席位满按三个等待项及溢出分流规则处理。

Paseo 公司插件「公司 → 只读审阅」允许粘贴员工 agent ID；会话命令中心和面板也有「只读审阅历史」。通过本地 Claude/Factory 持久 transcript 分页显示文本和工具记录摘要，不恢复模型运行时、员工凭证或租约，不提供输入发送和工具执行。关闭未归档、已归档、已退役、无租约历史均可审阅；隐藏思考、配置、工具输入和原始工具输出不展示，常见凭证脱敏。普通长文本按正文续页保持可达。单条过大记录省略，文件缺失明确报错，不触发模型补取。老板 RPC 验证公司员工登记，QA 会话不开放此老板入口。归档的 Paseo 原生 history 打开跳过路由配置检查，仍保留环境清洗；非 history 交互保持路由与沙箱校验。普通原生聊天与只读审阅是不同入口，后者不激活前者。

#### 公司插件导航约定（v0.3.58）

公司插件在 Paseo 侧栏只注册「公司」一个入口。用量、历史审阅及后续公司功能放在公司工作台内部，不再新增侧栏菜单。手机端内部导航单行横向滑动，各页面独立滚动。保留原有命令与会话内用量、只读审阅面板；旧 surface ID 进入相同工作台。

Paseo 0.14.0 原生已归档会话走 history 恢复，但已关闭、未归档的持久会话走 interactive 恢复（安装包 agent-manager.js 的 resumeAgentFromPersistenceInternal）。因此「只读审阅」保留为公司内部补充功能：直接读持久记录，不恢复进程或执行权限。普通会话历史仍可直接使用 Paseo；若以后原生对所有关闭状态提供无需恢复运行的只读查看，再移除此补充界面。

### 提交与交付检查

#### 提交前检查（PR 门）

工程的实现任务（kind=task）提交时，系统会读 submit 证据里链接的 GitHub PR（`gh pr view`），只检查**头分支就是本任务登记分支**的那个 PR：与主干冲突、已关闭未合并、或有失败的 CI 检查，提交会被直接拒收（`invalid`，任务仍是 doing），员工修好后重新提交，不再占用一次验收。CI 还在跑不算失败；GitHub 因账户付款失败或触及支出上限而未启动作业的检查也不算失败。判定前会读该检查的注解（含 account payments / spending limit / Billing & plans 文案）与其作业，只有**一步都没执行**的作业才算基础设施拒绝，跑过步骤的失败、没有 job 链接的检查、读不到注解或作业一律照旧视为失败。证据里没有 PR 链接、链接的是别的分支、或 `gh` 查询出任何问题时一律放行，由验收人照常检查。上线申请、合入部署和其他岗位不受影响。`SCK_PR_GATE=0` 关闭（设在插件服务环境中）。

简报里的"退回"只统计真正的验收退回；系统因工作区路径变化换会话产生的"通道回滚"单列。

### 老板提醒与简报

#### 老板提醒：老化升级与每日简报

调度器每个周期都会检查等老板的东西（待批关口、待回答的问题），不再只在出现时提醒一次：

- **老化升级**：等待满 4 小时、24 小时、72 小时各再提醒一次，之后每天一次；提醒写明已等多久、属于哪个目标、卡住多少下游任务。24 小时起的提醒强制弹通知（不再经 Jev 判断是否打扰）。老板处理后提醒自动消失。检查每 5 分钟一次。
- **每日简报**：每天本地时间 9 点后的第一个周期发一条：等你处理的事（最久的排前面）、异常卡滞（依赖已完成却仍 blocked、就绪超过 1 小时没人领）、近 24 小时完成/退回/驳回/作废数、在办目标、供应商额度。调整时刻 `pnpm run admin config owner_brief_hour <0-23>`，关闭用 `-1`。重启不会重发。
- **手机推送**：桌面通知在电脑前才看得到。要推到手机，在 `private/service.env` 里加 `SCK_NOTIFY_WEBHOOK=<地址>`（任何接受 JSON POST 的中继，Bark/Gotify 等；地址含密钥，只放私有配置），重载插件后所有通知同时 POST 到该地址（字段 `title`/`body`/`message`/`text`）。不配置则只有桌面通知和收件箱。

集成测试用受控本地 fork 运行：`pnpm test`（全部）或 `bun scripts/test-worktrees.ts [tests/xxx.test.ts …]`（指定文件）。直接 `bun test` 读 `surreal_ck/.env` 会连到生产 SurrealDB 服务器，所以 `loadDatabaseConfig()` 在测试环境（`NODE_ENV=test`）下遇到非本机地址会直接报错拒绝。

#### 每日简报里的产能与员工流动

- **产能**：按岗位列出"当前可用编制/总编制"。供应商额度低于下限或处在冷却期的编制算不可用，并写明原因（例如 codex 额度不足、grok 402 欠费）。有岗位一个可用编制都没有时会明说。派工本来就会跳过这些编制，权重在可用的编制之间重新分配；这一段是给老板看的：该充值、换模型还是加编制。
- **员工流动**：近 24 小时新建与退役的员工实例数，以及其中"认领失败"的数量。正常情况下认领失败应接近 0；持续偏高说明调度在反复新建又丢弃实例（2026-10-10 曾因共享 worktree 争用每天上百次，worktree 按线分配后已降到 0）。

### 资源、产物与数据库

#### 终态产物回收与资源闸门自救

`evidence/<任务ID>/` 与 `deliverables/<任务ID>/` 是工作存储，不是长期档案。终态（done/void）任务的这两个目录按任务生命周期回收：宽限期 evidence 3 天、deliverables 7 天、作废任务 1 天，时钟取该任务最后一条审计，永远不取文件 mtime；只删大文件（媒体、压缩包、依赖/VCS 目录），保留小型文本与 `.reclaimed.json` 墓碑。派工闸门（`min_free_disk_mb`，默认 10240 MB）每轮先做一次压力回收，目标水位是 `min_free_disk_mb + artifact_headroom_mb`（默认共 20 GB）；水位达标后自动恢复派工。

**两级开关，语义不同**

| 开关 | 位置 | 作用 |
|---|---|---|
| `artifact_reclaim_enabled` | `company_meta:config` | 关闭**例行**回收（30 分钟惰性 sweep、普通 sweep 触发）。资源闸门触发的**紧急回收不受它影响**，否则磁盘一低就会把公司锁死。 |
| `SCK_ARTIFACT_RECLAIM=0` | 插件服务环境 | 硬停，连紧急回收一起停。此时闸门阻塞期间会发 `resources-reclaim-blocked` 通告（强制提醒），写明是哪一级开关停的。 |

人工运行的命令与台账见上文「磁盘与产物回收」。注意：参数里的裸数字一律是目标空闲 MB，不是任务 ID（任务 ID 是 UUID）。人工运行不受配置开关限制。

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

#### 本机数据库内存预算与资源阻塞分类（v0.3.57）

公司 fork 的默认 RocksDB 预算会随宿主机物理内存放大：16GB Mac 的 block cache 默认约 7GiB，write buffer 默认 128MiB×8。公司本机数据库通过 `scripts/company-db-runtime.sh` 设置本机预算：block cache 512MiB，write buffer 32MiB×4，受跟踪内存阈值 2GiB；值均使用整数 bytes，避免尺寸后缀解析差异。该阈值由 fork 的分配跟踪与查询取消检查实现，不是 macOS 对整个进程 RSS 的硬上限，缓存、映射、线程及其它分配仍可能造成差异。不能使用 launchd RSS 限制冒称硬隔离。只读日志记录这四项非敏感预算，不记录认证信息。

升级代码不会擅自重启数据库。需要应用新预算时，在仓库检出目录执行 `sh scripts/company-db.sh install`（见「数据库与云端迁移」）。凭证与持久数据目录保持原路径。安装会把运行脚本复制到服务 bin 目录，数据库启动不依赖 `current` 或发布目录；后续安装沿用该运行脚本，避免手改启动脚本后重装丢失预算。需要覆盖时在 launchd 环境中设置相同 `SURREAL_*` 整数字段；默认配置适用于当前 16GB 共享宿主机。

派工任务结论区分 memory_pressure 和 disk_space，两者同时低时分别显示，不复用磁盘清理说明。内存判断仍优先 macOS 内核压力等级，正常压力时不以少量空闲页误拦截。磁盘产物回收只由磁盘回收水位触发，内存不足不触发无关清盘；回收禁用通知仅在磁盘确实阻断派工时出现。旧 resources 代码保留兼容，恢复提示改为检查内存和磁盘，实时结论会在下一 tick 更新。

#### 内存压力 LRU 休眠（v0.3.60）

有待派工作且内存门禁阻断时，按连续空闲起点升序关闭一个闲置员工运行时，硬下限 3600 秒。未知起点从观测开始，不用进程年龄或上次领取时间代替。每轮最多关闭一个，再探测内存；仍有压力时等待下一轮，磁盘不足不触发此回收。

持有任务、待办唤醒中、权限待处理、运行中、状态不明或快照变动均跳过。事务登记两分钟领取屏障，任务 claim 与待办唤醒均遵守；关闭确认后解除，结果不明时自然过期。不退役、不撤销凭证、不归档工作空间，绑定的实现人也可休眠，下次合法派工复用原身份和会话。

使用本机 Paseo 自带的 `/mcp/agents` 端点（Paseo 自身的接口，不是公司 MCP 服务）的 `kill_agent`。安装版 0.14.0 中它仅调用 `closeAgentCommand → closeAgent`，保留持久记录，与 delete、archive、close-items 不同。默认端点 `http://127.0.0.1:6767/mcp/agents`，可通过 `SCK_PASEO_RUNTIME_MCP_URL` 指定其他本机端口，仅接受回环 HTTP。Paseo 升级后应复核该关闭契约。

### 模型路由（0.5.0）

#### Magpie 四档模型路由（0.5.0）

故事作者保持原有编制、客户端和模型。其余角色各保留一个 Claude 编制；产品默认 `group/sck-sonnet`，owner（老板）默认 `group/sck-opus`，其他岗位（含 QA）默认 `group/sck-haiku`。Fable 仅作为老板手动入口，不进入员工请求，老板个人通过 Magpie 手动使用 Fable。

员工组为 `group/sck-opus`、`group/sck-sonnet`、`group/sck-haiku` 三个，Fable 不进入员工请求。0.5.0 起员工会话不再经过本机网关（18779 已删除），直连 VPS magpie `https://data.maplayer.top/ofm`。租约档位是上限，手动选择可以降到更便宜的档，不能升档。

##### 员工会话环境注入

插件在员工会话打开时注入以下配置：

- `ANTHROPIC_BASE_URL`：VPS magpie 地址。
- `ANTHROPIC_AUTH_TOKEN`：取自服务目录 `private/magpie-remote.key`。该文件缺失或为空时拒绝启动员工会话，不静默直连。
- `x-magpie-session` 头：`sck-<digest(任务:员工)>`，供 `task_cost` 精确匹配用量。
- 模型：`group/sck-haiku`、`group/sck-sonnet`、`group/sck-opus`，按任务档位选择。

配置经 `--settings` 私有文件加载（员工通信目录下 `.claude/settings.local.json`，权限 0600），因为用户全局 `settings.env` 会覆盖进程环境变量。story-author 与老板手动会话不注入。

##### 会话归因

换任务即换会话。reuse 与 oneshot 两种策略都是：同一任务内的返工、复审接续原会话，绑定的任务记录在 `employee.session_task`。升级前已存在、没有绑定任务的旧会话，在下次派工时换新会话，因为旧会话环境里仍是已停用的网关地址。

##### 已删除与放弃的内容

- 0.5.0 删除模型排序整套（ranking、aa 榜单、alias、inventory、health、roster、trends、urgency、weights、内置 benchmarks）、agent 模型指标页、模型切换时间线、model_execution 台账，以及 Jev 组内排序。
- 派工器只处理角色/岗位轨、仓库与写入隔离、独立验收、实现人连续性、租约和本机总并发，不按订阅额度、账号并发、配置模型漂移或员工分数挑模型。
- 公司代码不再自动排序或入组模型。Sonnet、Haiku 组的实际成员与顺序以 Magpie 侧配置为准，本仓库代码不维护它们，上线后需核对。
- 放弃项：员工思考等级（thinking）控件对组名模型不再传给 Paseo，因为组名模型未经 Paseo 验证。

##### 会话与租约

有效员工会话的模型调用资格与任务写入租约分开：submit/review 成功会立即消耗任务租约，随后 Claude 仍需处理工具结果、输出收尾，此时记录 task 为空、phase=idle。新任务写入和供应商操作仍须原有有效租约；未登记、隔离或过期的在途租约不会获得任务权限。

##### 历史迁移

0.4.x 的四档迁移（加法迁移 033，以及原 `model-routing-admin.ts` 的 migrate、disable、roster 等步骤，该脚本已随 0.5.0 删除）已经完成，不再适用于 0.5.0。0.5.0 的回滚与上线验证项见 [运行手册 · 上线记录](agent-operations.md#上线记录)。

##### Factory 优先的原生员工编制

编制保留 Claude、Factory（`factory-droid`）及故事作者特例；删除其他 provider 的非故事作者定义。Factory 保留原生 provider、模型与思考设置，并恢复额度门禁；Claude 继续使用岗位默认的 Magpie 组。老板编制列表把 Factory 排在前面。

派工选人不调用 Jev。资格检查（岗位/轨道、项目、额度与健康、席位与并发、原实现人绑定、验收回避及独立性）通过后，先复用 Factory，再使用可新建的 Factory 席位。Factory 额度与健康可用且岗位编制启用时，全公司按任务创建时间和稳定键排序，最多保留 3 个待派工作项等待 Factory；席位或并发满不立即分流这 3 项，第 4 项起可使用其他合格员工。执行、验收与 blocked_to=owner 的老板关口恢复工作共用名额；批次含保留等待项时整批等 Factory。任务实际派出才释放名额并递补。额度耗尽/冷却或该岗位无启用 Factory 编制时按原候选规则回退。任务原因用 factory_wait 解释等待，不绕过负责人、作者回避或独立性限制。Factory 编制显式设置 thinking=max，与 auto-high 工具权限模式分开。候选排序在本机执行，不为派工产生 Jev 调用。

## 已删除的旧做法

以下内容属于 0.7.0 之前的节点布局。它们已删除，不要按这些内容操作。

- MCP 任务服务：launchd 任务 `org.surrealck.company-mcp`、端口 38473、`/mcp` 端点、`/ready` 检查、`SCK_MCP_PORT`、`SCK_MCP_URL`，以及 `scripts/company-service.sh`、`scripts/run-service.sh`。
- 远程 VPS 部署 MCP：`scripts/deploy-mcp-remote.sh`、`sync-gate` 命令、`private/mcp-remote.env`，以及远端 bun 版本核对与 SYS02 上传前守卫。远程部署整节已删除，发布只走节点更新器与 CI 发行包。
- 固定快照目录：`releases/<sha>/`、`active` 符号链接。插件发行目录是 `plugin-releases/`。
- 两面切换演练（deploy drill）与 `scripts/acceptance-guard.sh`。
- 本机门禁回执 `gates/` 目录与 `release-gate.sh`。发布前的公司 fork 回归需手动运行 `bun scripts/test-worktrees.ts <文件>`。
- GitHub 看板投影：`SCK_GITHUB_REPOSITORY`、`SCK_PROJECTOR_CREDENTIAL_FILE`、`SCK_PROJECTION_STATE_FILE`，以及 `private/gh-projection.json`。
- 员工凭证文件模式：`SCK_EMPLOYEE_CREDENTIAL_FILE` 与 `private/credentials/*.token`。员工通道只使用 comm 文件协议。
- 独立调度器 launchd 任务 `org.surrealck.company-dispatcher`：调度器已经并入插件。
- `npm` 或 `pnpm` 脚本 `mcp:client`、`mcp:serve`、`test:mcp:live` 与 `dispatcher`。
- 云端 `outbox` 事件表与 `company_meta:outbox_counter`（schema 062）。
