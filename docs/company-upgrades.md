# 公司系统版本发布与节点升级（0.7.0）

0.7.0 起，执行节点上只有两样东西：Paseo 插件 `sck-company`，以及节点更新器。main 合入后，CI 发布插件发行包，各节点的节点更新器读取最新正式 Release，核对清单与 sha256，再把插件切换到新版本。节点上不再运行 MCP 服务，也没有 `active` 链接或 `releases/` 快照。节点运维见 [company-service-operations.md](./company-service-operations.md)。

## 版本与发布说明

- 版本号采用语义版本。根 `package.json`、`plugin/package.json` 与 `company-release.json` 的 `version` 必须一致。`scripts/plugin-package.ts` 在打包时核对这三处（`plugin-package.ts` 中「版本不一致」的检查）。
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
| `quality` | PR 与 main push | 安装依赖，生成 vendor，根与插件 typecheck，运行 `test:bridge`、`test:service`、`test:comm` |
| `workflow-lint` | PR 与 main push | 用 actionlint 1.7.12 检查 workflow 语法 |
| `release` | 仅 main push，且 `quality` 通过 | 迁移云端库，发布 GitHub Release 资产 |

`release` 按顺序执行：

1. 确认 `v<版本>` 尚未发布（`gh release view`）。已发布则失败，需先提高版本号。
2. 在临时服务目录写入 migrator 凭证（`private/cloud/migrator-client-secret`），凭证只存在于本次作业。
3. 运行 `bun scripts/company-migrate.ts`，以 migrator 身份对云端公司库执行 schema 迁移。
4. 运行 `bun scripts/plugin-package.ts --out <临时目录> --verify-install`，生成发行包与清单，并在临时目录按锁文件安装生产依赖，确认服务端入口可以打包。
5. 以 main 提交为目标执行 `gh release create v<版本>`，上传三个资产。

迁移只在 `v<版本>` 尚未发布时执行。若第 4 步或第 5 步失败，重跑作业会再次执行迁移，所以新增 schema 必须可以重复执行。`release-main` 并发组让发布串行执行，且不取消在途发布。main 的 Quality gate 失败时不会发布。

作业需要的仓库 secrets：`COMPANY_DB_URL`、`IDP_ISSUER`、`MIGRATOR_CLIENT_ID`、`MIGRATOR_CLIENT_SECRET`。缺少 `MIGRATOR_CLIENT_SECRET` 时作业在迁移前失败。CI 不持有节点的 runner 凭证。

## 发行资产

| 资产 | 内容 |
|---|---|
| `sck-company-<版本>.tgz` | `release.json`（product、version、sha、requiredSchema）、`plugin/` 与 `scripts/`。`plugin/` 只含运行所需条目：`paseo-plugin.json`、`package.json`、`pnpm-lock.yaml`、`index.client.tsx`、`index.server.ts`、`client/`、`server/`（含 vendor 与版本戳）、`shared/`，不含 `node_modules`、测试文件与 `tsconfig.json`。`scripts/` 只含 `sck.sh` 与 `bun-runtime.sh`，节点更新器把它们装到 `bin/`。 |
| `manifest.json` | 清单：`format`（当前为 1）、`product`（`sck-company`）、`version`、`sha`（main 提交）、`requiredSchema`、`createdAt`，以及发行包（`package`）与更新器（`updater`）的文件名、sha256 和字节数。 |
| `node-updater.js` | 节点更新器单文件，由 `scripts/node-updater.ts` 以 `--target node` 打包。 |

节点不下载依赖，而是用包内的 `pnpm-lock.yaml` 执行 `pnpm install --prod --frozen-lockfile --ignore-scripts`。

## 节点更新器

### 运行方式与目录

| 项 | macOS | Linux |
|---|---|---|
| 定时器 | launchd `org.surrealck.node-updater`，`StartInterval` 900 秒，登录时立即运行一次 | systemd 用户单元 `sck-node-updater.timer`，启动 2 分钟后，之后每 15 分钟一次 |
| 启动入口 | `<服务目录>/updater/run.sh`（权限 700） | 同左 |

服务目录默认是 `~/Library/Application Support/SurrealCKCompany`，可用 `SCK_SERVICE_HOME` 覆盖。更新器使用其中的以下位置：

- `updater/`：`node-updater.js`（权限 600）、`run.sh`、运行锁 `lock`，以及回退冷却记录 `rolled-back.json`（发生过回退时才存在）。
- `plugin-releases/<sha>/`：插件发行目录，包含 `release.json`、`plugin/`（含依赖）与 `scripts/`（`sck.sh`、`bun-runtime.sh`）。
- `current`：符号链接，指向现役插件目录 `plugin-releases/<sha>/plugin`。员工命令从这里运行。
- `bin/sck`、`bin/bun-runtime.sh`：从现役发行目录复制来的工具脚本（权限 700）。
- `private/node-id`：节点 ID，首次运行时生成（`src/node-identity.ts`）。
- `logs/node-updater.log`：每轮日志。`run.sh` 在输出不是终端时把输出追加到这里，launchd 与 systemd 都写入这里。一轮正常结束时最后一行是 `结果: …`。

插件发行目录放在 `plugin-releases/` 下，以提交 SHA 命名。

### 一轮的步骤

下列步骤对应 `src/node-updater.ts` 的 `runLocked`：

1. 取得 `updater/lock`（内容为进程号与时间）。另一轮仍在运行时本轮暂缓；持有者进程已不存在时接管陈旧的锁。
2. 记录检查时间（`node_release.checked_at`），写入失败只记日志。
3. 查询最新正式 Release。没有则结束，结果为“没有正式发行版本”。
4. 下载并解析 `manifest.json`。Release 标签必须等于 `v<清单版本>`，清单的发行包与更新器资产名不能相同。
5. 读取插件当前注册（`paseo plugin ls sck-company --json`）。注册路径无法解析或不在服务目录内（例如开发树）时拒绝，不切换。
6. 比较版本：
   - 现役 sha 与清单相同：把 `current` 与 `bin/` 对齐，并把 `node-updater.js` 对齐到清单，结果为“已是最新”。
   - 清单版本不高于现役版本：拒绝降级。
   - 切换后刚回退过同一版本：24 小时内暂缓（`RETRY_COOLDOWN_MS`）。
7. 准备发行目录（幂等）。若 `plugin-releases/<sha>` 已有与清单一致的 `release.json` 且 `plugin/node_modules` 存在，直接复用，只重新下载并校验更新器。否则下载发行包与更新器，校验 sha256 与字节数，不符即拒绝、不解压。解压到暂存目录，核对 `release.json`（product、version、sha、requiredSchema）与清单，确认有 `plugin/`，移入 `plugin-releases/<sha>`，再安装生产依赖。依赖安装失败时删除整个目录，下一轮重新准备。
8. 租约门禁：统计本节点的进行中租约。有租约则暂缓；查询失败也暂缓。
9. 切换前核验云端 schema 满足清单的 `requiredSchema`，不满足则拒绝。
10. 切换：`paseo plugin remove sck-company`（已注册时）→ `paseo plugin install <plugin-releases/<sha>/plugin> --id sck-company` → 等待插件进入 running 且启用、注册路径是新目录（默认最长 60 秒）→ 再核验一次 schema。Paseo daemon 不重启，只有该插件进程重启。
11. 切换后任一步失败，切回原注册路径，并记录回退（`rolled-back.json` 与云端 `node_rollback`）。切回也失败时结果为“回退失败”，插件可能未运行，需人工处理。节点原本未注册时没有可切回的路径：只移除新注册，结果为“失败”。
12. 成功：刷新 `current` 与 `bin/`，替换 `updater/node-updater.js`，清除回退记录，回收旧发行目录（只保留本版本与切换前的现役版本，后者是回退目标），写入结果“升级成功”。

`current` 与 `bin/` 的刷新发生在切换成功之后。这两步失败只记日志，不回退插件，日志会写明 `current` 或工具脚本没有更新。

租约门禁统计的是本节点的进行中租约：`task.current_employee` 非空、`lease_expires_at` 尚未过期，且 `lease_node` 为本节点或尚未记录。未记录节点的旧租约按本节点计算，以保守为先。

### 结果与退出码

日志结论行的格式是 `结果: <结论>`，由 `summarize` 生成。

| 日志结果 | 含义 | 退出码 |
|---|---|---|
| 已是最新 | 现役版本与清单相同 | 0 |
| 没有正式发行版本 | 仓库没有正式 Release | 0 |
| 暂缓 | 有进行中租约、另一轮在运行、无法确认租约，或回退冷却中 | 0 |
| 升级成功 | 切换并核验通过 | 0 |
| 拒绝 | 清单或资产校验失败、标签与清单不符、注册在服务目录外、降级、云端 schema 不满足 | 1 |
| 失败 | 下载、解压或依赖安装失败，读取注册失败等 | 1 |
| 已回退 | 切换后验证失败，已切回原版本 | 1 |
| 回退失败 | 切回原版本也失败，插件可能未运行 | 1 |

连接云端或读取节点 ID 失败时，本轮在检查之前结束：日志只有“连接公司库失败”或“节点 ID 读取失败”一行，未切换，退出码为 1。

### 云端记录

- `node_release`：每个节点一行，记录 ID 即节点 ID。插件心跳写入 `version`、`sha`、`seen_at`。更新器写入 `checked_at`；拒绝、失败、升级成功与回退时还写入 `last_status`、`last_target`、`last_at`、`last_error`。暂缓与“已是最新”只更新 `checked_at`。
- `node_rollback`：每次切换后回退追加一行，记录节点、时间、回退前后的版本与 sha、原因与结果。

查看所有节点：

```sql
SELECT id, version, sha, seen_at, checked_at, last_status, last_target, last_error FROM node_release;
```

### 切换边界

- 只切换 `sck-company` 插件，不重启 Paseo daemon，不暂停全公司派工。
- 插件切换会重启插件进程，因此只在节点没有进行中租约时发生。有租约则等下一轮（约 15 分钟）。
- Paseo 只在插件登记时解析来源路径，`reload` 不改来源，所以切换必须是 `remove` + `install`。插件进程重启后，sidecar 会对已有员工实例执行 adopt，重新接管其通道。

## 首次安装节点更新器

适用于新执行节点，以及尚未安装更新器的已有节点。

### 前提

1. 系统为 macOS，或带 systemd 用户服务的 Linux。
2. 工具：Node.js 22 或以上（可用 `SCK_NODE_BIN` 指定绝对路径）、`tar`、`pnpm`（可用 `SCK_PNPM_BIN` 指定）、已登录的 `gh`（账号能读取发行仓库的 Release）。
3. Paseo CLI：macOS 上若存在 `/Applications/Paseo.app/Contents/Resources/bin/paseo` 则使用它，否则从 PATH 查找 `paseo`，也可用 `SCK_PASEO_BIN` 指定。找不到时安装仍会继续，但更新器无法工作。
4. 云端连接配置，只写入服务目录：
   - `COMPANY_DB_URL`、`IDP_ISSUER`、`RUNNER_CLIENT_ID`：可作为环境变量设置，也可写入 `<服务目录>/private/company-db.env`（权限 0600）。缺少 `COMPANY_DB_URL` 时更新器拒绝运行，不会回落到本机库。
   - 执行端 client secret 放在 `<服务目录>/private/cloud/runner-client-secret`（权限 0600）。只需确认路径存在，不要把内容复制到文档、日志或工单。
5. 插件运行所需的其他本机配置（如 `private/service.env`、员工沙箱 `sh scripts/sandbox/install.sh`）仍按原流程准备，更新器不负责这些。

### 安装

在干净的 main 检出目录执行：

```sh
sh scripts/node-updater.sh install
```

`install` 只接受 `--from <dir>` 与 `--no-load`，两者仅用于测试与离线安装。安装命令会依次执行：

1. 用 `gh release download` 取得最新正式 Release 的 `manifest.json` 与 `node-updater.js`，校验 sha256 和字节数。不符则放弃，不写入任何文件。
2. 写入 `<服务目录>/updater/node-updater.js`（权限 600）与执行脚本 `run.sh`（权限 700）。
3. 注册定时器：macOS 写入 `~/Library/LaunchAgents/org.surrealck.node-updater.plist` 并 bootstrap；Linux 写入 `~/.config/systemd/user/sck-node-updater.service` 与 `sck-node-updater.timer`，再 `enable --now`。
4. 立即运行一轮。若节点从未注册过 `sck-company`，这一轮会直接注册并启动插件。首轮失败不会让安装失败，错误写入日志；修复后运行 `sh scripts/node-updater.sh run` 重试。

发行仓库缺省为 `MainListActivity/surreal-ck-operations`，可用 `SCK_RELEASE_REPO` 覆盖。Linux 服务器还要执行：

```sh
loginctl enable-linger "$USER"
```

否则登出后定时器不会运行。

安装命令不创建 `bin/`、`current` 或 `private/`；它们在第一轮成功切换插件后生成（`bin/` 与 `current` 由插件切换步骤创建，`private/node-id` 由第一轮运行创建）。

### 验证

- `sh scripts/node-updater.sh status`：显示定时任务是否已加载，并打印日志最后 40 行。
- `paseo plugin ls sck-company --json`：状态为 running，已启用，`path` 位于 `<服务目录>/plugin-releases/<sha>/plugin`。
- `ls -l <服务目录>/current`：指向同一个 `plugin` 目录。
- 云端 `node_release` 中出现本节点的行，`checked_at` 为近期时间。

卸载用 `sh scripts/node-updater.sh uninstall`。它只移除定时器（launchd plist 或 systemd 单元），保留 `plugin-releases`、`updater`、日志与插件注册。

## 升级与回退

### 正常升级

不需要人工操作。main 发布新 Release 后，各节点在下一轮（最长约 15 分钟）自动切换。

### 手动回退到上一版

切换后验证失败时，更新器会自动切回原注册路径，并在 24 小时内不再尝试同一版本。0.7.0 不再有 MCP 回退，回退要同时切回插件、`current` 与 `bin/` 三处。需要人工回退某个节点（例如 0.7.0 回到 0.6.1）时：

1. 先停用节点更新器，否则它会再次升级：`sh scripts/node-updater.sh uninstall`。
2. 找到上一版的插件发行目录。由节点更新器切换的版本保留在 `<服务目录>/plugin-releases/<上一版 SHA>/plugin`，因为切换时会保留切换前的现役版本。若目录已不存在，需要从上一版 main 提交重新打包，待确认：0.7.0 之前的 `releases/` 快照已不再由任何脚本生成，旧版 `company-service.sh` 也已删除。
3. 把插件指回上一版目录：

   ```sh
   paseo plugin remove sck-company
   paseo plugin install "<上一版 plugin 目录>" --id sck-company
   paseo plugin ls sck-company --json
   ```

   结果应为 running、已启用，`path` 指向上一版目录。
4. 把 `current` 指向上一版插件目录（`ln -sfn "<上一版 plugin 目录>" "<服务目录>/current"`，与 `pointCurrent` 的结果一致），并用上一版发行包的 `scripts/sck.sh` 与 `scripts/bun-runtime.sh` 覆盖 `bin/sck` 与 `bin/bun-runtime.sh`（权限 700）。员工命令 `bin/sck` 依赖 `current`，两者需要同时恢复。
5. 修复并发布新版本之前，不要运行节点更新器的 `install` 或 `run`，否则它会立即升级到最新 Release。

0.7.0 没有 schema 变化（仍为 061），回退时无需删除表或字段，细节见下节。

## 0.7.0 迁移与回退

### 变化

- 删除 MCP 服务：节点上不再有 `org.surrealck.company-mcp` launchd 任务、`/mcp` 端点（端口 38473）、`releases/` 快照目录、`active` 符号链接、`scripts/company-service.sh`、`scripts/run-service.sh` 与 `scripts/deploy-mcp-remote.sh`。
- 删除 GitHub 看板投影（`SCK_GITHUB_REPOSITORY` 等）：核心不再写 `outbox` 事件。`outbox` 表与 `company_meta:outbox_counter` 保留在库中，0.7.0 不删除：0.6.1 核心仍在事务里写入它们，过早删表会让仍在 0.6.1 的节点写入失败，下个版本再删。`CLOUD_SCHEMA_VERSION` 仍为 61。`get_admin_summary` 不再返回 `outboxSequence`。
- 新增 `current` 符号链接与 `bin/`：员工命令 `bin/sck` 从 `current/server/vendor/src/sck-cli.ts` 运行。

### 迁移

迁移由 CI 的 release 作业执行一次（`scripts/company-migrate.ts`），节点不执行迁移。0.7.0 的 `requiredSchema` 为 061，云端库已在 061 时迁移只重放已有 schema（幂等），库结构不变。节点更新器在切换前核验云端 schema 是否满足清单的 `requiredSchema`，不满足则拒绝切换，节点停留在旧版本。

下个版本删除 `outbox` 表前，需要先确认节点都已升到不再写入 outbox 的版本（0.7.0 或更新），并在该版本的迁移说明中写明删表。

### 回退

0.7.0 回退到 0.6.1 时，插件回退到上一版目录即可，不涉及 MCP 回退，也没有 `releases/` 回退。两个版本的 schema 都是 061，`outbox` 表保留，回退不需要恢复任何表。回退后 0.6.1 核心会重新写入 `outbox` 事件，但 GitHub 投影已随 MCP 服务删除，不会恢复。

## 已知限制

- 节点更新器的完整升级路径（切换与回退）尚未在真实节点上端到端验证。首次升级前，先在一台可接受中断的节点上观察一轮，并核对云端 `node_release`。
- Linux 的 systemd 定时器与 `gh` 生产下载路径尚未在本机验证。
- 没有正式 Release 时，更新器依赖 `gh` 的错误文字（`release not found`、`no releases found`）识别这种情况。文字变化后，它会被当作失败记录。
- 陈旧锁的接管不是原子操作。
- 切换成功后，若替换 `updater/node-updater.js` 失败，插件已是新版，更新器文件仍是旧版。日志会记录，下一轮重新对齐。
- 插件进入 running 的等待按轮询次数计时，不是严格的墙钟时间。

## 排查

- 本机日志：`<服务目录>/logs/node-updater.log`。正常结束的一轮，最后一行 `结果: …` 是本轮结论；没有这一行时，看倒数第二行的错误说明。
- 云端回退记录：`SELECT * FROM node_rollback;`
- 占用租约的任务及其节点：`SELECT id, current_employee, lease_expires_at, lease_node FROM task WHERE current_employee != NONE;`

## 维护者发布前检查

1. 三处版本号一致，`company-release.json` 说明完整；需要时同步登记 schema。
2. 本地运行 `bun test tests/node-updater.test.ts tests/node-updater-install.test.ts tests/node-updater-cli.test.ts tests/plugin-package.test.ts tests/release-notes-contract.test.ts`，并用 `bun scripts/plugin-package.ts --out <临时目录> --verify-install` 检查产物。
3. PR 通过 Quality gate 后合入 main。
4. 确认 Release 含三个资产，且 `manifest.json` 的 `sha` 与 main 提交一致。
5. 等待各节点的下一轮（最长 15 分钟），在云端 `node_release` 核对版本与 `last_status`。
