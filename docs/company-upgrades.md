# 公司系统版本发布与节点升级（0.13.85）

0.13.84 起，节点升级由原生执行端自己完成（自更新），不再经过 Paseo 插件和 launchd 定时更新器。main 合入后，CI 发布发行包；执行端每 15 分钟读取最新正式 Release，核对清单与 sha256，在空闲且无租约时切换 `current`，排空后由 launchd 按新版本重新拉起。新版本健康后确认；起不来时由启动脚本退回旧版本。0.13.85 起仓库里没有 Paseo 插件，发行包只含执行端运行目录。节点运维见 [company-service-operations.md](./company-service-operations.md)，执行端见 [native-agent-runtime.md](./native-agent-runtime.md)。

## 版本与发布说明

- 版本号采用语义版本。根 `package.json` 与 `company-release.json` 的 `version` 必须一致。`scripts/release-package.ts` 在打包时核对这两处（「版本不一致」的检查）。
- 每次上线提高版本号，并在同一提交更新 `company-release.json`：
  - `title`：标题，2 到 100 字。
  - `changes`：上线内容，1 到 10 条，每条不超过 240 字。
  - `impact`：影响范围，1 到 8 条，每条不超过 240 字。
  - `migration`：数据变化；`rollback`：回退方式。两者各不超过 400 字。
- 说明文件的结构由 `releaseNotesSchema`（`src/company-release.ts`）约束。
- 新增云端 schema 时，除增加 `schema/NNN-*.surql` 外，还要更新 `src/database.ts` 的 `CLOUD_SCHEMA_VERSION`（以及 `applySchema`），并在 `src/company-release.ts` 的 `RELEASE_SCHEMA_REQUIREMENTS` 登记该版本需要的 schema 与表。打包时核对这两处一致。

## 发布流程

工作流文件是 `.github/workflows/quality-gate.yml`，包含三个作业：

| 作业 | 触发条件 | 作用 |
|---|---|---|
| `quality` | PR 与 main push | 安装依赖，typecheck，运行 `test:bridge`、`test:service`、`test:comm` 与老板端测试 |
| `workflow-lint` | PR 与 main push | 用 actionlint 1.7.12 检查 workflow 语法 |
| `release` | 仅 main push，且 `quality` 通过 | 迁移云端库，发布 GitHub Release 资产 |

`release` 按顺序执行：

1. 确认 `v<版本>` 尚未发布（`gh release view`）。已发布则失败，需先提高版本号。
2. 在临时服务目录写入 migrator 凭证（`private/cloud/migrator-client-secret`），凭证只存在于本次作业。
3. 运行 `bun scripts/company-migrate.ts`，以 migrator 身份对云端公司库执行 schema 迁移。
4. 运行 `bun scripts/release-package.ts --out <临时目录> --verify-install`，生成发行包与清单，并在临时目录按锁文件安装生产依赖，确认执行端与 sck 入口可以打包。
5. 以 main 提交为目标执行 `gh release create v<版本>`，上传资产。

迁移只在 `v<版本>` 尚未发布时执行。若第 4 步或第 5 步失败，重跑作业会再次执行迁移，所以新增 schema 必须可以重复执行。`release-main` 并发组让发布串行执行，且不取消在途发布。main 的 Quality gate 失败时不会发布。

作业需要的仓库 secrets：`COMPANY_DB_URL`、`IDP_ISSUER`、`MIGRATOR_CLIENT_ID`、`MIGRATOR_CLIENT_SECRET`。缺少 `MIGRATOR_CLIENT_SECRET` 时作业在迁移前失败。CI 不持有节点的 runner 凭证。

## 发行资产

| 资产 | 内容 |
|---|---|
| `sck-company-<版本>.tgz` | `release.json`（product、version、sha、requiredSchema）、`runtime/` 与 `scripts/`。`runtime/` 是执行端运行目录：根 `package.json`、`pnpm-lock.yaml`、`src/`、`schema/`、`landscape/`，不含 `node_modules`、测试文件与 `tsconfig.json`；执行端入口 `src/runner/run.ts`，版本从发行目录的 `release.json` 读。`scripts/` 只含 `sck.sh` 与 `bun-runtime.sh`，确认新版本时装到 `bin/`。0.13.84 及之前的发行包运行目录叫 `plugin/`（Paseo 插件 + `server/vendor`），自更新两种都认。 |
| `manifest.json` | 清单：`format`（当前为 1）、`product`（`sck-company`）、`version`、`sha`（main 提交）、`requiredSchema`、`createdAt`、发行包（`package`）的文件名、sha256 和字节数。0.13.84 及之前还带 `updater`（旧定时更新器），现在可缺省且不读取。 |

节点不下载依赖，而是用包内的 `pnpm-lock.yaml` 执行 `pnpm install --prod --frozen-lockfile --ignore-scripts`。

## 执行端自更新

### 运行方式与目录

自更新跑在原生执行端进程里（`src/runner/self-update.ts`，launchd `org.surrealck.native.<节点ID>`），只在安装的服务里启用（启动脚本设置 `SCK_NATIVE_FOLLOW_CURRENT=1`）；`SCK_SELF_UPDATE=0` 可关闭。首轮在启动 2 分钟后，之后每 15 分钟一轮。依赖 `gh`（已登录，可用 `SCK_GH_BIN` 指定）、`pnpm`（`SCK_PNPM_BIN`）与 `tar`，它们要在启动脚本的 PATH 里。发行仓库缺省 `MainListActivity/surreal-ck-operations`，可用 `SCK_RELEASE_REPO` 覆盖。

服务目录默认是 `~/Library/Application Support/SurrealCKCompany`，可用 `SCK_SERVICE_HOME` 覆盖。自更新使用其中的以下位置：

- `updater/lock`：运行锁（进程号与时间）。`updater/rolled-back.json`：回退冷却记录。`updater/pending`（及 `.attempts`、`.rolled-back`）：待确认标记，见下文。
- `plugin-releases/<sha>/`：发行目录（目录名沿用历史），包含 `release.json`、运行目录 `runtime/`（含依赖）与 `scripts/`。
- `current`：符号链接，指向现役运行目录 `plugin-releases/<sha>/runtime`。执行端与员工命令都从这里运行。
- `bin/sck`、`bin/bun-runtime.sh`：从现役发行目录复制来的工具脚本（权限 700）。`bin/native-<节点ID>.sh`：启动脚本，由 `scripts/native-service.ts` 生成，不随版本更新。
- `private/node-id`：节点 ID（`src/node-identity.ts`）。
- 日志：`logs/native-<节点ID>.log`，自更新的行以 `[自更新]` 开头。

### 一轮的步骤

下列步骤对应 `src/node-updater.ts` 的 `runLocked`：

1. 取得 `updater/lock`。另一轮仍在运行时本轮暂缓；持有者进程已不存在时接管陈旧的锁。
2. 记录检查时间（`node_release.checked_at`），写入失败只记日志。上一次切换尚未确认（`updater/pending` 存在）时暂缓。
3. 查询最新正式 Release。没有则结束。
4. 下载并解析 `manifest.json`。Release 标签必须等于 `v<清单版本>`。
5. 解析 `current`。指向服务目录之外时拒绝。现役 sha 与清单相同即“已是最新”；清单版本不高于现役版本拒绝降级；24 小时内回退过的同一版本暂缓。
6. 准备发行目录（幂等）：已有与清单一致的 `release.json` 且依赖已装就复用；否则下载发行包，校验 sha256 与字节数，解压到暂存目录，核对 `release.json` 与清单，移入 `plugin-releases/<sha>`，安装生产依赖。安装失败删除整个目录，下一轮重来。
7. 门禁：执行端有运行中的会话则暂缓；再统计本节点的进行中租约，有租约或查询失败都暂缓。
8. 核验云端 schema 满足新版本要求，不满足则拒绝。
9. 写 `updater/pending`（第 1 行新运行目录、第 2 行旧运行目录、第 3 行版本元数据），再原子替换 `current`。结果“已切换”。执行端随即停止接新活，心跳发现 `current` 变化后等会话与租约排空再退出，launchd 按新 `current` 拉起新版本。

租约门禁统计的是本节点的进行中租约：`task.current_employee` 非空、`lease_expires_at` 尚未过期，且 `lease_node` 为本节点或尚未记录。

### 确认与回退

- 新版本启动时若 `current` 指向待确认的新目录，先装 15 分钟看门狗；连上云端、派工启动、首个心跳到达后调用 `confirmSwitch`：再核验一次 schema，安装 `bin/sck` 与 `bin/bun-runtime.sh`，清除冷却记录，回收旧发行目录（保留新版本与回退目标），写入升级成功并删除标记。
- 确认时 schema 不满足：新版本自己把 `current` 指回旧目录，记录回退与 24 小时冷却，然后排空退出，由 launchd 拉起旧版本。
- 新版本起不来（崩溃或 15 分钟内没确认就被看门狗退出）：启动脚本每次启动都检查标记，`current` 仍指向新目录就计一次数（`updater/pending.attempts`）；连续 3 次后把 `current` 指回旧目录并写 `updater/pending.rolled-back`。旧版本启动时 `settlePending` 补记 `node_rollback`、升级结果“已回退”与冷却，再删除标记。回退逻辑在启动脚本里，坏版本改不了它。
- 首次安装（没有旧版本）不能回退，启动脚本只计数。

### 结果

日志行 `[自更新] <结论>`：已是最新、没有正式发行版本、暂缓（会话或租约未排空、另一轮在运行、上次切换未确认、冷却中）、拒绝（清单或资产校验失败、标签不符、current 在服务目录外、降级、schema 不满足）、失败（下载、解压、依赖安装或切换失败）、已切换。确认阶段另记“升级成功：<版本>”或回退原因。

### 云端记录

- `node_release`：每个节点一行，记录 ID 即节点 ID。执行端心跳写入 `version`、`sha`、`seen_at`。自更新写入 `checked_at`；拒绝、失败、升级成功与回退时还写入 `last_status`、`last_target`、`last_at`、`last_error`。
- `node_rollback`：每次回退追加一行，记录节点、时间、回退前后的版本与 sha、原因与结果。

```sql
SELECT id, version, sha, seen_at, checked_at, last_status, last_target, last_error FROM node_release;
```

### 旧定时更新器的退役

0.13.84 之前由 launchd `org.surrealck.node-updater` 通过 `paseo plugin remove/install` 切换版本。0.13.84 由它最后一次切换上线；执行端启动后（及之后每轮）若发现该 plist 且它没在持有更新锁，就 `launchctl bootout` 并把 plist 移到 `<服务目录>/retired/`。`scripts/node-updater.sh` 已删除。

## 新节点安装

1. 准备云端连接配置（`private/company-db.env`、`private/cloud/runner-client-secret`）、老板凭证 `private/owner-token`、`private/service.env` 与员工沙箱（`sh scripts/sandbox/install.sh`）。
2. 第一次手工放置发行目录：下载最新 Release 的发行包，解压到 `plugin-releases/<sha>/`，在 `runtime/` 执行 `pnpm install --prod --frozen-lockfile --ignore-scripts`，把 `current` 指向它，并把 `scripts/sck.sh`、`scripts/bun-runtime.sh` 复制为 `bin/sck`、`bin/bun-runtime.sh`（权限 700）。
3. 写 `private/native-runner.json`，用 `current` 里那份 `scripts/native-service.ts` 安装服务：`bun scripts/native-service.ts <节点ID> <配置绝对路径>`。
4. 核对 `native:<节点ID>` 心跳后再写 `private/runtime-routes.json`。之后的升级由自更新完成。

## 升级与回退

### 正常升级

不需要人工操作。main 发布新 Release 后，执行端在空闲且无租约时（最长约 15 分钟一轮）自动切换并确认。想立即检查，重启执行端服务（`launchctl kickstart -k gui/$UID/org.surrealck.native.<节点ID>`），首轮在 2 分钟后运行。

### 手动回退到上一版

1. 先关闭自更新，否则它会再次升级：在启动脚本或 `private/service.env` 设置 `SCK_SELF_UPDATE=0`。
2. 上一版目录保留在 `<服务目录>/plugin-releases/<上一版 SHA>/runtime`（0.13.84 是 `.../plugin`；确认时保留回退目标）。
3. `ln -sfn "<上一版运行目录>" "<服务目录>/current"`，用上一版发行包的 `scripts/sck.sh` 与 `scripts/bun-runtime.sh` 覆盖 `bin/sck` 与 `bin/bun-runtime.sh`，删除 `updater/pending*`。
4. `launchctl kickstart -k gui/$UID/org.surrealck.native.<节点ID>`。
5. 修复并发布新版本后，再去掉 `SCK_SELF_UPDATE=0`。

## 0.7.0 迁移与回退

### 变化

- 删除 MCP 服务：节点上不再有 `org.surrealck.company-mcp` launchd 任务、`/mcp` 端点（端口 38473）、`releases/` 快照目录、`active` 符号链接、`scripts/company-service.sh`、`scripts/run-service.sh` 与 `scripts/deploy-mcp-remote.sh`。
- 删除 GitHub 看板投影（`SCK_GITHUB_REPOSITORY` 等）：核心不再写 `outbox` 事件。`outbox` 表与 `company_meta:outbox_counter` 在 0.7.0 保留在库中：0.6.1 核心仍在事务里写入它们，过早删表会让仍在 0.6.1 的节点写入失败。删除由 0.7.1 的 schema 062 完成（见下节）。`CLOUD_SCHEMA_VERSION` 在 0.7.0 仍为 61。`get_admin_summary` 不再返回 `outboxSequence`。
- 新增 `current` 符号链接与 `bin/`：员工命令 `bin/sck` 从 `current/server/vendor/src/sck-cli.ts` 运行。

### 迁移

迁移由 CI 的 release 作业执行一次（`scripts/company-migrate.ts`），节点不执行迁移。0.7.0 的 `requiredSchema` 为 061，云端库已在 061 时迁移只重放已有 schema（幂等），库结构不变。节点更新器在切换前核验云端 schema 是否满足清单的 `requiredSchema`，不满足则拒绝切换，节点停留在旧版本。

删除 `outbox` 表的前提是节点都已升到不再写入 outbox 的版本（0.7.0 或更新）。该前提与删表步骤写在 0.7.1 的迁移说明中（见下节）。

### 回退

0.7.0 回退到 0.6.1 时，插件回退到上一版目录即可，不涉及 MCP 回退，也没有 `releases/` 回退。两个版本的 schema 都是 061，`outbox` 表保留，回退不需要恢复任何表。回退后 0.6.1 核心会重新写入 `outbox` 事件，但 GitHub 投影已随 MCP 服务删除，不会恢复。

## 0.7.1 迁移与回退

### 变化

- 删除本机公司库：仓库不再提供 `scripts/company-db.sh`、`scripts/company-db-runtime.sh` 与 `scripts/company-backup.ts`，也不再安装 `company-db`、`company-backup`、`company-verify` 三个 launchd 任务。每小时 R2 备份与每周恢复演练一并停止。
- 生产只连云端：插件的公司栈、节点更新器与老板 CLI（`company`、`admin`、`bootstrap`）缺 `COMPANY_DB_URL` 时拒绝启动并说明原因，不回落到 `SURREAL_URL` 或本机 root 账号。`private/company-db.env` 只读云端字段。
- 删除 `outbox`：schema 062 删除 `outbox` 事件表、`outbox_sequence` 索引与 `company_meta:outbox_counter` 计数器，只删除，不改写其它表的既有行。全新库按 001 至 062 应用后不再有它们。`CLOUD_SCHEMA_VERSION` 与 0.7.1 的 `requiredSchema` 为 062。

### 迁移

- 迁移由 CI 的 release 作业执行一次（`scripts/company-migrate.ts`），节点不执行迁移。`main` 合入后，release 作业先把云端库迁到 062，再发布 0.7.1 Release。节点更新器切换前核验云端 schema 不低于 062。
- 合入 `main` 前必须确认：所有执行端的插件都已是 0.7.0 或更新。0.6.x 核心仍在任务事务里写 `outbox`，并用计数器分配序号。云端删除表与计数器后，它的写入会失败，或写入无序号的行（取决于服务端）。在云端 `node_release` 表逐台核对 `version`（版本号是字符串，需按段比较，不能按字典序比较）。
- 合入 `main` 会立即在生产云端执行 062。删除的 `outbox` 数据不会自动恢复。

### 回退

- 0.7.1 回退到 0.7.0：插件回退到上一版目录即可，见上文「手动回退到上一版」。0.7.0 只需要结构版本 61，062 满足它；0.7.0 不读写 `outbox`，回退不需要恢复任何表。
- 0.7.1 不能只回退插件到 0.6.x。0.6.x 会写 `outbox` 与 `company_meta:outbox_counter`，回到 0.6.x 前，运维需先从云端备份恢复这两样，本版本不提供该步骤。
- 节点更新器的自动回退回到切换前的版本。在前提满足（节点已是 0.7.0）时，那就是 0.7.0。

## 已知限制

- 启动脚本的回退路径只在真实 shell 测试里验证过，生产上还没有真正触发过。
- 新节点第一次仍要手工放置发行目录，之后才由自更新接管。
- 没有正式 Release 时，依赖 `gh` 的错误文字（`release not found`、`no releases found`）识别这种情况。文字变化后，它会被当作失败记录。
- 陈旧锁的接管不是原子操作；启动脚本用 `ln -sfn` 回退 `current`，不是原子替换。
- 新版本 15 分钟内连不上云端也会被看门狗判为未确认；连续 3 次后回退并冷却 24 小时，网络持续故障时可能把好版本回退。

## 排查

- 本机日志：`<服务目录>/logs/native-<节点ID>.log`，搜 `[自更新]` 与 `启动脚本：`。
- 待确认标记：`<服务目录>/updater/pending`（存在说明上次切换尚未确认）、`pending.attempts`（新版本已启动的次数）。
- 云端回退记录：`SELECT * FROM node_rollback;`
- 占用租约的任务及其节点：`SELECT id, current_employee, lease_expires_at, lease_node FROM task WHERE current_employee != NONE;`

## 维护者发布前检查

1. 三处版本号一致，`company-release.json` 说明完整；需要时同步登记 schema。
2. 本地运行 `pnpm test:service` 与 `bun test tests/release-notes-contract.test.ts`，并用 `bun scripts/release-package.ts --out <临时目录> --verify-install` 检查产物。
3. PR 通过 Quality gate 后合入 main。
4. 确认 Release 资产齐全，且 `manifest.json` 的 `sha` 与 main 提交一致。
5. 等待执行端的下一轮（最长 15 分钟，加上排空时间），在云端 `node_release` 核对版本与 `last_status`。
