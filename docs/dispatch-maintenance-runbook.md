# 派工维护运行手册：静默窗口切换、回滚与 dispatch_pause

适用：SYS-DISP afdb562c（PR #1494）上线后的派工维护，以及从 bdf9732 首次切换到新版。

状态：草案，待独立工程复核。本文件不授权合入、部署、开窗、暂停或恢复。每次执行都须由 GM 在任务记录中授权，并按本文留证据。

依据：GM 决定 afdb562c v6（gm-fable-5c4823，2026-10-20T22:55Z）；7c0ac47e 只读核验 findings.md。

## 0. 边界

1. 首次从旧版切到新版，使用静默窗口（第 2 节，Q0 至 Q5），不使用任何暂停开关。
2. 新版上线并通过 Q3 之后，维护停派只使用 dispatch_pause、dispatch_status、dispatch_restore（第 4 节）。
3. 以下路径禁止用于维护停派：
   - 旧版布尔暂停：老板 UI 的暂停按钮、owner_command 的 pause 与 resume、宿主 RPC company.pause.set。
   - `admin config paused`：它现在经暂停事务写入纪元、闸门与审计（见第 7 节第 4 条），不再是绕过屏障的旁路；但没有比较并交换，也不等待排空，因此仍不作为维护停派手段。
   - `def_ensure` 写 enabled=false：它不拦截复用（见第 7 节第 6 条）。
4. 禁止以 owner 身份、owner CLI、SQL、环境变量、token 或守护进程凭证绕过本手册的任何一步。
5. 本手册描述的是 PR 合入 origin/main 之后的 release 切换。PR 未合入前，install 会拒绝该 release。

## 1. 术语

- 静默窗口：窗口内 ready 任务为 0，待 GM 的任务为 0，且没有能把任务变为 ready 的复核租约。accept 会解锁依赖，return 会把任务变为 ready。新租约只为 ready 任务发放，所以窗口内没有新租约来源。
- 纪元（epoch）：company_meta:config.pause_epoch。暂停状态每改变一次加一。dispatch_pause 与 dispatch_restore 用它做比较并交换（CAS）。
- 排空（drained）：dispatch_pass 账本中，纪元早于当前纪元且状态仍为 running 的 pass 数为 0。只有 dispatch_pause 会等待排空。
- 租约闸门：claimLease 在事务内读取 paused，暂停时拒绝新租约（src/core.ts:830）。这是新租约的强屏障，与排空无关。

## 2. 首次切换：静默窗口 Q0 至 Q5

窗口编号写作 W-<UTC 日期时间>。每一步的输出写入该窗口的证据目录（evidenceDir 下的 window/W-<编号>/）。下列命令中使用这些变量：

```sh
SCK="/Users/y/Library/Application Support/SurrealCKCompany/bin/sck"
SVC="$HOME/Library/Application Support/SurrealCKCompany"
PASEO="/Applications/Paseo.app/Contents/Resources/bin/paseo"
```

### Q0（T-10 分钟，只读）

1. `sh "$SCK" call get_context '{}'`：记录 company.paused（必须为 false）；记录 state 为 ready 的任务数（必须为 0）；记录 blocked 任务中待 GM 的数量（必须为 0，核对方式以返回字段为准）；列出全部 doing 与 review 任务的 id、state、version、fence、reviewerRole。
2. 对每个 doing 与 review 任务：`sh "$SCK" call get_task_history '{"taskId":"<id>"}'`，记录当前持有人（最后一条有效 claim 的员工）、fence、version、最近一条事件的时间。
3. 运行面：`readlink "$SVC/active"`；`"$PASEO" plugin ls sck-company --json`，记录 SOURCE 与 DIRECTORY；`launchctl print "gui/$(id -u)/org.surrealck.company-mcp"`，记录 state 与 pid；`sh "$SVC/active/scripts/company-service.sh" status`。
4. 探针：`curl --fail http://127.0.0.1:<MCP 端口>/health` 与 `/ready`，都必须为 200。端口由运维登记在 Q0 证据中，可用 `lsof -nP -iTCP -sTCP:LISTEN -a -p <MCP pid>` 核对。不读取 private/ 目录。
5. GM 执行 `sh "$SCK" call def_list '{}'`，记录每个 employee_def 的 enabled，作为原状态基线（只读）。
6. 确认新 release 目录 $REL 通过第 3 节 R2 的完整性检查，并且插件 SOURCE 位于服务目录内。否则 install 不会重指插件（见 Q2）。

### Q1（T-1 分钟，只读复采）

1. 重做 Q0 的第 1 与第 2 步。
2. 全部满足才进入 Q2：
   - ready 为 0，待 GM 的任务为 0。
   - 没有 review 持有人，即没有活的复核租约。
   - doing 与 review 清单，以及各自的 version、fence、持有人，与 Q0 完全一致。
   - Q0 之后，get_task_history 中没有新的 claim、lease、release、revoke 或 expire 事件。
   - Q0 之后，GM 与 owner 没有创建、批准、解锁、作废或改派任务。
3. 任一条件不满足：不开窗。5 分钟后重做 Q1。

### Q2 开窗（需 GM 在任务记录中授权）

```sh
SCK_RELEASE_KEEP=<N> SCK_COMPONENTS=mcp sh "$REL/scripts/company-service.sh" install "$REL"
```

- $REL 为 `$SVC/releases/<40 位 SHA>`。SHA 为 origin/main 上的合并提交。脚本会拒绝不在 origin/main 上的提交。
- N 为切换时 releases/ 下有效的 40 位 SHA 目录数，包括 $REL。2026-10-20 决定时为 5，切换时重新数。N 不小于候选数时，脚本不会删除任何快照。
- install 的执行顺序（scripts/company-service.sh）：
  1. 校验 $REL 完整（src/mcp/run.ts 与 src/dispatcher/run.ts 存在）、SHA 为 40 位、可达 origin/main，并查询插件当前 SOURCE。查询失败则拒绝，active 不变。
  2. 替换 bin/run.sh 与 bin/sck；原子切换 active 指向 $REL。
  3. 若插件 SOURCE 位于服务目录内：`plugin remove sck-company`，再 `plugin install $REL/plugin --id sck-company`。此时旧插件进程退出，旧派工器停止；新插件启动，新派工器开始 tick。
  4. 重写 MCP plist，bootout 后 bootstrap。MCP 重启并执行 bootstrap（含 schema 021）。MCP 在 bootstrap 完成后才开始监听（src/mcp/run.ts），因此 /health 与 /ready 返回 200 即表示 bootstrap 已完成。
  5. 按 SCK_RELEASE_KEEP 修剪快照。
- 不做：不重启整个 Paseo 守护进程；不另建 dispatcher、launchd 或定时器；不修改 enabled；不写 company_meta:config。
- 输出含 `warning: plugin repoint failed`：立即进入 R1，不进入 Q3。
- 输出含 `note: sck-company is registered outside the service home`：插件未重指，视为 Q3 失败，进入 R1。

### Q3（L1 与 L2，安装返回后）

1. `readlink "$SVC/active"` 等于 $REL。
2. `"$PASEO" plugin ls sck-company --json`：状态 running、enabled、无 error；SOURCE 与 DIRECTORY 都等于 `$REL/plugin`。
3. `launchctl print` 显示 MCP running，pid 与 Q0 不同；`/health` 与 `/ready` 为 200。
4. 双面版本一致：
   - `diff -qr "$REL/schema" "$REL/plugin/server/vendor/schema"` 无输出。
   - 去掉 vendor 文件首行 `// @ts-nocheck` 后，plugin/server/vendor/src/ 下的 core.ts、dispatch-pause.ts、dispatcher/dispatcher.ts、mcp/server.ts 与 $REL/src 中的对应文件无差异。
5. 新面可用：GM 执行 `sh "$SCK" call dispatch_status '{}'`。返回 paused 为 false，oldRunning 为 0，epoch 为 0（从未经新版暂停；旧版暂停不写纪元），或与 Q0 记录的基线一致。返回工具不存在或 forbidden 即失败。dispatch_status 只读，不改变状态。
6. `sh "$SCK" call get_context '{}'` 正常返回，company.paused 仍为 false。

### Q4（L3 adopt，逐条核对）

1. 对 Q0 记录的每个 doing 与 review 任务：持有人、fence、version 与 Q0 一致；get_task_history 中没有 release、revoke 或 expire 事件。
2. 切换后出现的每个新事件（claim、lease、review 认领、重派）逐条记录来源：是 adopt 的既有会话，还是新派工器的 spawn 或 claim。记录时间戳，并与派工器日志或 get_task_history 对应。
3. 不得出现误退役、误重派或换人。任一项不满足即 Q4 失败，进入 R1。
4. 窗口内不制造 ready 任务，所以真实派工（spawn、claim）不在窗口内验证。真实派工在 Q5 之后，由 GM 在正常产生的 ready 任务上观察并记录。未观察到之前，不得宣布"派工已验证"。

### Q5（收窗）

1. 重做 Q0 的第 1 步。company.paused 仍为 false。ready 为 0。若出现 ready 任务，只能是 Q4 已逐条核对过的外部事件产生的任务，逐一列出 id。
2. 记录收窗时间（UTC）与证据位置。
3. 本流程从未暂停，无需恢复 paused。enabled 未改动，无需恢复。收窗后按正常调度工作。

### 窗口边界

- 静默窗口不阻止外部事件。员工会话崩溃、订阅耗尽或会话归档会释放租约，任务变为 ready。此时由新派工器按正常规则派发，新租约只能经 claimLease 发放。Q4 逐条核对。
- install 的插件 remove 与新插件启动之间，若有 submit 产生新的复核租约，该租约应由新派工器发放。若复核 spawn 找不到派工来源，按 Q4 失败处理，进入 R1。窗口内不得手工 claim，不得手工修改任务状态。
- MCP 重启期间（bootout 到 bootstrap 之间）的请求会失败。调用方使用同一 idempotencyKey 重试。
- 新插件可能在 MCP 完成 bootstrap 之前启动。本次迁移是加法迁移，写入的是 schemaless 表与 company_meta 字段，不依赖 bootstrap 先完成。插件运行时只做查询，不做 bootstrap（plugin/server/company.ts:61 至 :62）。非加法迁移需另行设计切换顺序（见第 7 节第 10 条）。

## 3. 失败与回滚 R1 至 R4

触发条件：Q2 输出 warning 或 note；Q3 或 Q4 任一项失败；窗口内出现无法解释的 claim 或 lease。

前置：config.paused 必须为 false。若 paused 为 true（只可能来自新版 dispatch_pause，或 owner 路径），先由 GM 用 dispatch_restore 恢复。若新版 dispatch 工具不可用，停止回滚并报 GM。旧版没有 GM 可用的恢复入口，禁止以 owner 或 admin 路径恢复。

### R1 冻结（立即）

1. 停止所有写入动作：不 claim、不 accept、不 return、不 pause、不 restore、不改 def、不改 enabled、不创建或批准任务。
2. 只读保存现场：Q0 的全部输出；受影响任务的 get_task_history；launchctl print、plugin ls、company-service status、/health 与 /ready 的输出；记录 UTC 时间。日志只记录行数与时间，不把原文复制进证据。

### R2 回滚 MCP 与 active 到 PREV

```sh
SCK_RELEASE_KEEP=<N> SCK_COMPONENTS=mcp sh "$PREV/scripts/company-service.sh" install "$PREV"
```

- PREV 为已核实完整的上一版 release。生产当前为 bdf9732，以 Q0 记录为准。
- 完整性检查：src/mcp/run.ts 与 src/dispatcher/run.ts 存在；plugin/ 与 plugin/node_modules 存在；plugin/server/vendor/schema 与 schema 一致；目录内没有 .git（不是 Git worktree）。缺任一项则不回滚，报 GM。
- 插件 SOURCE 位于服务目录内时，install 会自动把插件重指到 $PREV/plugin。

### R3 插件面核对与修复

- 若 R2 输出含 `warning: plugin repoint failed`，手工执行：

  ```sh
  "$PASEO" plugin remove sck-company
  "$PASEO" plugin install "$PREV/plugin" --id sck-company
  "$PASEO" plugin reload sck-company
  ```

- 核对：`plugin ls` 的 SOURCE 与 DIRECTORY 都等于 $PREV/plugin，状态 running，无 error。
- 注意：docs/company-service-operations.md 第 5 节的双面回滚，在 install 已自动重指后再执行 `plugin install`，会因 ID 已存在而失败。以本节为准。

### R4 验证并收尾

1. 重做 Q3 的第 1 至第 4 项与第 6 项。第 5 项的 dispatch_status 只在插件为新版时可用，旧版不可用属正常。
2. 核对 company.paused 为 false。核对 enabled 与 Q0 记录一致；不一致则报 GM，由 GM 决定。只能用 def_ensure 写回 Q0 记录的完整定义，不得启用 Q0 时已停用的编制。
3. 保留现场与全部快照，不删除任何 release 目录。
4. 在任务记录中写明回滚时间、PREV SHA 与证据路径，并报 GM。
5. 旧版忽略新版的 dispatch_pass 行与 pause_epoch 字段，残留行不影响旧版运行。

## 4. 上线后的 dispatch_pause 使用与恢复

### 前提（全部满足才可使用）

- 新版在两面同时生效：active、插件 SOURCE 与 DIRECTORY 都指向同一个新 release（见第 5 节）。
- GM 能调用 dispatch_status（需要 gm 角色与 manage 能力）。
- GM 授权与维护理由已写入任务记录。
- idempotencyKey 在同一员工与同一操作（pause 或 restore）内标识一次调用（src/core.ts:1107）；不同 GM 之间不复用同一键。建议格式为 `afdb562c-<用途>-<UTC 时间>`，长度 8 至 200 字符。

### 工具（src/mcp/server.ts:222 至 :240；src/core.ts:1094 至 :1152）

```sh
sh "$SCK" call dispatch_status '{}'
sh "$SCK" call dispatch_pause '{"expectedEpoch":<E>,"reason":"<原因>","idempotencyKey":"<唯一串>","drainTimeoutSeconds":120}'
sh "$SCK" call dispatch_restore '{"expectedEpoch":<E>,"reason":"<原因>","idempotencyKey":"<唯一串>"}'
```

| 工具 | 输入约束 | 返回 |
|---|---|---|
| dispatch_status | 无 | paused、epoch、changedAt、runningPasses（最多 50 条，含 instance、epoch、startedAt）、oldRunning |
| dispatch_pause | expectedEpoch 为非负整数；reason 为 2 至 500 字；idempotencyKey 为 8 至 200 字符；drainTimeoutSeconds 为 10 至 900，默认 120 | operationId、operation、paused、epoch、before、drained（含 drained、blocking、waitedMs，或为 null）、replayed |
| dispatch_restore | 同上，不含 drainTimeoutSeconds | 同上，drained 为 null，不排空 |

错误码：forbidden（不是 gm，或没有 manage）；invalid（参数越界）；conflict（expectedEpoch 已过期、同一 key 的载荷不同，或并发冲突，可重试）。

### 步骤

1. `dispatch_status`：记录 paused、epoch E、oldRunning、runningPasses。要求 paused 为 false，oldRunning 为 0。若 oldRunning 为 1，且该行 epoch 为 null、startedAt 只有几秒，属于 pass 的正常启动瞬间，等待数秒后重读。
2. `dispatch_pause`，expectedEpoch 填 E。记录 operationId、epoch（应为 E+1）、before、drained、replayed。
3. 看 drained：
   - drained.drained 为 true：新租约已拒绝，暂停前开始的 pass 已全部结束。进入第 4 步。
   - drained.drained 为 false：paused 仍为 true，新租约仍被拒绝，但仍有旧纪元的 pass 未结束。维护不得开始，见下文。
4. `dispatch_status`：确认 paused 为 true，epoch 为 E+1，oldRunning 为 0。
5. 维护动作只在此时开始。维护期间，持有租约的员工继续续租、提交和复核（这是设计），只有新租约被拒绝。
6. `dispatch_restore`，expectedEpoch 填 E+1。记录 epoch（应为 E+2）与 before。恢复不等待排空。
7. `dispatch_status`：确认 paused 为 false，epoch 为 E+2。
8. 在任务记录中写入两个 operationId、前后的 epoch、drained、oldRunning、维护内容与起止时间。

### drained 为 false 时

- 不开始维护，保持暂停。
- 读取 dispatch_status.runningPasses。instance 的格式为 `<主机>:<pid>:<随机串>`。epoch 为 null 表示尚未记录纪元，按旧纪元计。
- 若该 pass 对应的进程仍在运行：每 30 至 60 秒读一次 dispatch_status，等待 pass 结束。然后用新的 idempotencyKey、相同的 expectedEpoch（E+1）重新 dispatch_pause，重新等待排空。
- 若该 pass 对应的进程已不存在（插件重载、崩溃或被强制结束）：当前版本没有自动回收，该行会一直计入 oldRunning，排空无法完成。不得手工删除或改写 dispatch_pass 行，不得改用 admin 或 owner 路径。报 GM，由 GM 决定：继续等待，或在 reason 中写明风险后恢复派工，或先实施受审的回收（见第 7 节第 1 条）。
- dispatch_restore 不检查 oldRunning。若 oldRunning 大于 0 时恢复，GM 须在 reason 中写明。

### 版本约束与幂等

- expectedEpoch 必须等于 dispatch_status 读到的当前纪元。过期返回 conflict，重新读取后再调用。
- 同一 idempotencyKey 加同一载荷：返回已存储的结果（replayed 为 true），并重新等待排空（src/core.ts:1140）。同一 key 加不同载荷：conflict。载荷包括 operation、expectedEpoch、reason 与 drainTimeoutSeconds。
- 纪元只在暂停状态真正改变时加一。已暂停时再次 dispatch_pause（expectedEpoch 为当前纪元）不加一，可用于重新排空。
- 每次实际写入都产生一条审计行（action 为 dispatch_pause 或 dispatch_restore，含 paused、previous_paused、epoch、previous_epoch、sequence）。同一 key 的重放不新增审计行。

### 生产验证（3381c477 的独立 QA 必须执行一次）

1. 选无在途任务的时刻：dispatch_status 的 oldRunning 为 0，且 Q0 式清单中没有 doing 或 review 任务。
2. 执行第 4 节的步骤 1 至 7。pause 与 restore 之间不做维护，立即恢复。
3. 记录：前后的 epoch、两个 operationId、两条审计行、两次 dispatch_status 的读回结果。
4. 审计行的读取方式：当前员工侧工具没有 dispatch 审计查询。get_task_history 只按任务查询，而 dispatch 审计行不关联任务。需要 GM 指定只读取证方式。在此之前，审计行一项标记为"未验证"。

## 5. 旧版矩阵

| 组合 | 新租约闸门（claimLease） | dispatch_* 工具 | 可否用于维护停派 |
|---|---|---|---|
| bdf9732 两面（生产现状） | 无，只有派工 pass 级布尔 gate | 无 | 否 |
| 新版 MCP 与新版插件（同一 release） | 有，在事务内 | 有 | 是（第 4 节） |
| 新版 MCP 与旧版插件 | 旧插件的派工与侧车 claim 无闸门 | 插件侧无 | 否，Q3 失败 |
| 旧版 MCP 与新版插件 | 插件侧有；MCP 的 claim_next 无闸门 | 插件侧有，MCP 无 | 否，Q3 失败 |
| 新版但 MCP 未完成 bootstrap | 未知 | 视 MCP 而定 | 否，/ready 非 200，Q3 失败 |

屏障必须覆盖所有 claim 入口，因此插件与 MCP 两面必须是同一个新 release。

## 6. 迁移与环境需求

- 迁移：schema/023-dispatch-pause.surql。定义 `dispatch_pass` 表（SCHEMALESS，PERMISSIONS NONE）与 state 索引，均为 IF NOT EXISTS。加法迁移，不改写存量行，不需要冻结写入。由 MCP bootstrap 执行（src/database.ts:104 至 :105）。编号历史：本迁移最初为 021，main 占用 021（worktree 审计事件）后顺延为 022，main 又占用 022（编制额度限制）后顺延为 023。三条迁移都是加法，先后只决定执行顺序。
- schema_version：新版由 20 改为 23（条件 WHERE schema_version < 23）；中间经过 main 的 21（worktree 审计事件）与 22（编制额度限制）。旧版的条件为 < 20，不会把 21、22 或 23 降回去（ddc8402 的 src/database.ts:99）。
- 新增的数据字段与记录：company_meta:config.pause_epoch（缺省为 0）；company_meta:dispatch_gate；audit 中的 dispatch_pause 与 dispatch_restore 行；dispatch_pass 行。每个 pass 一行，已结束且超过 1 天的行在新 pass 开始时删除，running 行不删除。
- 环境变量：分支没有新增 process.env 读取。RUN_SCK_DISPATCH_PAUSE_TESTS 只用于 fork 测试。install 沿用 SCK_RELEASE_KEEP 与 SCK_COMPONENTS。
- 主机准备：无。
- 插件构建：plugin/paseo-plugin.json 的 build 步骤运行 scripts/vendor.sh，生成 plugin/server/vendor/（已被 .gitignore 忽略）。release 在切换前必须已生成 vendor。
- 本地测试：只用公司 fork SurrealDB（~/.surrealdb/surreal），不用上游官方 SurrealDB。

## 7. 已知限制

标 ★ 的条目需要 GM 决定。

1. ★ 陈旧 running 行。进程被强制结束时，pass 的 finally 不执行，行保持 running。OLD_RUNNING_PASSES（src/dispatch-pause.ts:114）不判断进程是否存活，清理只删除非 running 行（src/dispatch-pause.ts:177）。现有 fork 测试 `drain`（tests/dispatch-pause.fork.test.ts:134 起）已断言：只要旧 pass 未结束，drained 为 false，oldRunning 为 1。后果：每次插件重载或崩溃中断一个 pass 之后，之后所有 dispatch_pause 的 drained 都无法为 true。这是失败关闭，不会误报排空，但维护无法完成。建议：派工器启动时，把同一主机上 pid 已不存在的 running 行标记为 abandoned；无法判断的行保持 running。
2. 无任务派工不经过租约闸门。GM 与 eval 的唤醒与 spawn 走 assign（src/dispatcher/dispatcher.ts:1504，调用点 :1251、:1280、:1336），没有 task，不调用 claimLease。它们只受 pass 级 gate（:934）与排空约束。drained 为 false 时，仍在运行的旧 pass 可能完成一次无任务唤醒或生成。
3. 持有租约的员工继续续租、提交与复核，静默收尾提醒照常发出。暂停不停止在办任务。
4. admin config 的 paused 经暂停事务写入（本补修修复）。src/admin.ts 的 `config paused true|false` 现在调用 writePause，与经理暂停同一事务：暂停值、pause_epoch、company_meta:dispatch_gate 与审计行一起提交（actor 记为 admin，actor_role 为 operator）。因此它不再绕过屏障，也不与 claimLease 的写冲突检测脱节；`config pause_epoch` 被直接拒绝，并指向 dispatch_pause 或 owner 暂停入口。该路径仍没有比较并交换，也不等待排空，所以维护停派只使用 dispatch_pause、dispatch_status、dispatch_restore。回归：tests/dispatch-pause-tick.fork.test.ts 的 R-A 用例（写入推进纪元并留下闸门与审计行，暂停期间新租约被拒）。
5. 老板路径（UI 按钮、owner_command 的 pause 与 resume）调用 owner.setPaused（src/owner.ts:319）。它同样经过 PAUSE_TXN（纪元、审计、gate），但不做比较并交换，也不排空。老板的恢复可以解除 GM 的暂停，这是设计。
6. ★ 复用不检查 def.enabled。staffingPool 的复用分支（src/dispatcher/dispatcher.ts:233 至 :253）没有 def.enabled 检查，只有新建分支检查（:261）。因此 def_ensure 写 enabled=false 不是停派手段。本分支未改此行为，按决定保留披露。
7. drainTimeoutSeconds 默认 120 秒是设计默认值，未在生产测量。
8. 本分支未经生产验证。第 4 节的生产验证由 3381c477 执行。
9. ★ 审计行没有员工侧读取工具（见第 4 节）。
10. 切换顺序不一致：install 先重指插件，再重启 MCP（scripts/company-service.sh）；docs/company-service-operations.md 第 3 节写的是 MCP ready 后再切插件。本次迁移为加法，可以接受。非加法迁移前需统一顺序（待 GM 决定）。

## 8. 本手册编写期间的执行情况

- 未执行任何 pause、restore、install、服务或插件启停，未写入任何生产数据。
- 未读取 token、凭证、env 或 private/ 目录。
- 代码未改动。本手册只描述 PR #1494 现有代码。
- 证据目录：`/Users/y/Library/Application Support/SurrealCKCompany/evidence/afdb562c-e217-493e-8060-3c60bbf50bfe/`。
