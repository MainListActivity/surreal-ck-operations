# 派工维护运行手册：静默窗口切换、回滚与 dispatch_pause

适用：SYS-DISP afdb562c（PR #1494）上线后的派工维护，以及从旧版首次切换到新版。旧版 SHA 不写死：PREV 一律取切换当刻 Q0 记录的 active 与插件 SOURCE/DIRECTORY 双面核准值（bdf9732、021、633bdf2、2bacac1 以及旧版旁路修复均为历史，不再是生产现状）。

状态：草案，待独立工程复核。本文件不授权合入、部署、开窗、暂停或恢复。每次执行都须由 GM 在任务记录中授权，并按本文留证据。

依据：GM 决定 afdb562c v6（gm-fable-5c4823，2026-10-20T22:55Z）；7c0ac47e 只读核验 findings.md。

## 0. 边界

1. 首次从旧版切到新版，使用静默窗口（第 2 节，Q0 至 Q5），不使用任何暂停开关。
2. 新版上线并通过 Q3 之后，维护停派只使用 dispatch_pause、dispatch_status、dispatch_restore（审计取证读取用 dispatch_audit，见第 4 节）。
3. 以下路径禁止用于维护停派：
   - 旧版布尔暂停：老板 UI 的暂停按钮、owner_command 的 pause 与 resume、宿主 RPC company.pause.set。
   - `admin config paused` / `admin config pause_epoch`：维护键，命令入口在任何写入之前一律拒绝并指向 dispatch_pause/dispatch_restore（见第 7 节第 4 条）；config 其余键照常。
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

**窗口准入的候选来源**（按旧 release 的真实 claim/唤醒路径，而不只是 ready 清单）：

- `ready` 任务：任何一次 tick 都可能被 claim，包括异常地仍带 holder 的 ready 行。
- `review` 任务：未领取的非 owner review 会被 claim；活 review 的 accept/return 会解锁依赖或把任务退回 ready；owner review 的 accept 会解锁依赖。
- `doing` 但没有 holder：异常行，下一轮可能被 claim。
- 失效、未知或临近到期的租约：监督会 revoke/expire，随后重新成为 claim 候选。
- 活的 execute 租约：submit（转 review，产生复核候选）、release/放弃（转 ready）同样产生候选。
- 不签发任务租约但会新建/唤醒会话的路径：triage 目标、待 eval 的终态任务、GM-attention（blockedTo=gm）。
- 任何未知、截断、分页或汇总漂移：数据不完整，不开窗。

**保守窗口**：除原 3381 本次部署的 execute 租约（具名 task/holder/fence/version/expiry，持续受权保活）外，doing 与 review 全部排空；ready、待 GM/owner、triage/eval/GM-attention、未知或临近到期一律不开窗。静默窗口是有条件最佳努力，不是硬事务屏障：外部 owner 动作、崩溃或状态变化立即使窗口失效，必须重新采样。

1. GM 运行 `bun "$REL/scripts/maintenance-preflight.ts"`（能力检查，只读；不暂停、不安装）。记录 admin summary（cutoff、since、逐 state 计数、outboxSequence、integrity.complete）、分页快照与行数、verdict。`capability.complete` 必须为 true。口径说明：summary 统计全部任务状态，get_context 只列工作态（ready/doing/review/blocked）且隐藏本人提交的 review，因此工具按工作态比对 ready/doing/blocked，并把 review 的差额记为 `hiddenReviews`；工作态总数必须等于分页行数加隐藏 review，任一行列表被截断（`listsTruncated`）即失败关闭——依赖读不全就不放行。隐藏的本人 review 仍会挡住窗口（它可以被 accept/return 解锁依赖）。
2. GM 运行 `bun "$REL/scripts/maintenance-preflight.ts" --window --deployment '<json>' --extras '<json>'`，记录 `window.allowed` 与 `admittedLease`。
   - `--deployment`：本次部署的具名租约 `{taskId,holder,fence,version,expiresAt}`。
   - `--extras`：`{triageGoals,pendingEvals,gmAttention}`，未知写作 `null`（会拒绝开窗）。
   - `window.allowed` 为 false 时按 reasons 逐条处理，不得跳过；工具不执行的读（如 triage/eval 计数）必须由 GM 用现有只读工具补采后如实传入，未知不得当作 0。
3. 运行面：`readlink "$SVC/active"`；`"$PASEO" plugin ls sck-company --json`，记录 SOURCE 与 DIRECTORY；`launchctl print "gui/$(id -u)/org.surrealck.company-mcp"`，记录 state 与 pid；`sh "$SVC/active/scripts/company-service.sh" status`。
4. 探针：`curl --fail http://127.0.0.1:<MCP 端口>/health` 与 `/ready`，都必须为 200。端口由运维登记在 Q0 证据中，可用 `lsof -nP -iTCP -sTCP:LISTEN -a -p <MCP pid>` 核对。不读取 private/ 目录。
5. GM 执行 `sh "$SCK" call def_list '{}'`，记录每个 employee_def 的 enabled，作为原状态基线（只读）。
6. 确认新 release 目录 $REL 通过第 3 节 R2 的完整性检查，并且插件 SOURCE 位于服务目录内。否则 install 不会重指插件（见 Q2）。

### Q1（T-1 分钟，只读复采）

1. 重新运行 Q0 的第 1 与第 2 步（新的一次 summary、分页与窗口判定），与 Q0 记录逐项比较：
   - 两次 `capability.complete` 均为 true，逐 state 计数、outboxSequence 与 paused=false 一致；
   - 两次 `window.allowed` 均为 true，`admittedLease` 与部署租约完全一致且未临近到期；
   - doing/review 清单（id/state/version/fence/holder）与 Q0 完全一致；Q0 之后没有新的 claim、lease、release、revoke 或 expire 事件。
2. 全部满足才进入 Q2；任一漂移、未知或超时：不开窗，5 分钟后重做 Q1。

### Q2 开窗（需 GM 在任务记录中授权）

```sh
# KEEP 取安装时有效的 40 位十六进制 release 目录数（含 $REL），动态计算，不用固定值
SCK_RELEASE_KEEP=$(ls "$SVC/releases" | grep -E '^[0-9a-f]{40}$' | wc -l | tr -d ' ') SCK_COMPONENTS=mcp sh "$REL/scripts/company-service.sh" install "$REL"
```

- $REL 为 `$SVC/releases/<40 位 SHA>`。SHA 为 origin/main 上的合并提交。脚本会拒绝不在 origin/main 上的提交。
- N 为切换时 releases/ 下有效的 40 位 SHA 目录数，包括 $REL。2026-10-20 决定时为 5，切换时重新数。N 不小于候选数时，脚本不会删除任何快照。
- install 的执行顺序（scripts/company-service.sh）：
  1. 校验 $REL 完整（src/mcp/run.ts 与 src/dispatcher/run.ts 存在）、SHA 为 40 位、可达 origin/main，并查询插件当前 SOURCE。查询失败则拒绝，active 不变。
  2. 替换 bin/run.sh 与 bin/sck；原子切换 active 指向 $REL。
  3. 若插件 SOURCE 位于服务目录内：`plugin remove sck-company`，再 `plugin install $REL/plugin --id sck-company`。此时旧插件进程退出，旧派工器停止；新插件启动，新派工器开始 tick。
  4. 重写 MCP plist，bootout 后 bootstrap。MCP 重启并执行 bootstrap（迁移链当前至 schema/027，集成后执行顺序 024→025→027、026 保留；以 release 内 src/database.ts 为准）。MCP 在 bootstrap 完成后才开始监听（src/mcp/run.ts），因此 /health 与 /ready 返回 200 即表示 bootstrap 已完成。
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

- PREV 为已核实完整的上一版 release，取切换当刻 Q0 记录的 active 与插件 SOURCE/DIRECTORY 双面核准值；部署记录必须写实际 PREV SHA 与回滚能力核对结果，不得沿用申请时的旧值（bdf9732 为历史）。
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

### 工具（src/mcp/server.ts 的 dispatch_* 注册；src/core.ts 的 setDispatchPause/dispatchStatus/dispatchAudit）

```sh
sh "$SCK" call dispatch_status '{}'
sh "$SCK" call dispatch_pause '{"expectedEpoch":<E>,"reason":"<原因>","idempotencyKey":"<唯一串>","drainTimeoutSeconds":120}'
sh "$SCK" call dispatch_restore '{"expectedEpoch":<E>,"reason":"<原因>","idempotencyKey":"<唯一串>"}'
sh "$SCK" call dispatch_audit '{"operationId":"<dispatch_pause 或 dispatch_restore 返回的 operationId>"}'
```

| 工具 | 输入约束 | 返回 |
|---|---|---|
| dispatch_status | 无 | paused、epoch、changedAt、runningPasses（最多 50 条，含 instance、epoch、startedAt）、oldRunning |
| dispatch_pause | expectedEpoch 为非负整数；reason 为 2 至 500 字；idempotencyKey 为 8 至 200 字符；drainTimeoutSeconds 为 10 至 900，默认 120 | operationId、operation、paused、epoch、before、drained（含 drained、blocking、waitedMs，或为 null）、replayed |
| dispatch_restore | 同上，不含 drainTimeoutSeconds | 同上，drained 为 null，不排空 |
| dispatch_audit | operationId 为 8 至 100 字符，必须是 dispatch_pause 或 dispatch_restore 的返回值（`type::string($audit)`，形如 audit:`<uuid>，id 部分带回点，含 audit: 前缀；回读时按去掉 audit: 与回点后的 uuid 定位该行） | action、actor、paused 与 previous_paused、epoch 与 previous_epoch、sequence、at、evidence；仅限这两类 action 的审计行 |

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
- 若该 pass 对应的进程已不存在（插件重载、崩溃或被强制结束）：新版派工器启动时自动收口——同一主机、pid 经信号 0 确证不存在（ESRCH）的 running 行改为 abandoned，并在同一事务写一条 audit（action 为 dispatch_pass_reaped，见第 7 节第 1 条）。重启一次派工进程，然后保持暂停并用新的 idempotencyKey、相同的 expectedEpoch（E+1）重新 dispatch_pause 即可排空。若该行仍计入 oldRunning，说明其 pid 无法确证死亡（跨主机、格式异常、存活未知或读写失败，均为设计上的失败关闭）：不得手工删除或改写 dispatch_pass 行，不得改用 owner 路径，报 GM 决定。
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
4. 审计行读取用 dispatch_audit（gm manage，按 operationId 回读，仅限 dispatch_pause/dispatch_restore 两类行）：第 2 步与第 6 步返回的 operationId 各查一次，核对 actor、paused/epoch 前后与 sequence。

## 5. 旧版矩阵

| 组合 | 新租约闸门（claimLease） | dispatch_* 工具 | 可否用于维护停派 |
|---|---|---|---|
| 旧版（bdf9732 等历史版本） | 无，只有派工 pass 级布尔 gate | 无 | 否（历史对照，非生产现状） |
| 新版 MCP 与新版插件（同一 release） | 有，在事务内 | 有 | 是（第 4 节） |
| 新版 MCP 与旧版插件 | 旧插件的派工与侧车 claim 无闸门 | 插件侧无 | 否，Q3 失败 |
| 旧版 MCP 与新版插件 | 插件侧有；MCP 的 claim_next 无闸门 | 插件侧有，MCP 无 | 否，Q3 失败 |
| 新版但 MCP 未完成 bootstrap | 未知 | 视 MCP 而定 | 否，/ready 非 200，Q3 失败 |

屏障必须覆盖所有 claim 入口，因此插件与 MCP 两面必须是同一个新 release。

## 6. 迁移与环境需求

- 迁移：schema/025-dispatch-pause.surql。定义 `dispatch_pass` 表（SCHEMALESS，PERMISSIONS NONE）与 state 索引，均为 IF NOT EXISTS。加法迁移，不改写存量行，不需要冻结写入。由 MCP bootstrap 执行（src/database.ts:126 至 :127）。编号历史：本迁移最初为 021，main 依次占用 021（worktree 审计事件）、022（编制额度限制）、023（query snapshot）与 024（snapshot quota），故最终集成为 025。集成时 main 已到 027（QA 观察），执行顺序 024→025→027（026 保留给 SYS02），schema_version 依次 25、27。所有迁移都是加法，先后只决定执行顺序。
- schema_version：新版由 20 改为 25（条件 WHERE schema_version < 25）；中间经过 main 的 21、22、23、24。旧版的条件为 < 20，不会把 21–25 降回去（ddc8402 的 src/database.ts:99）。
- 新增的数据字段与记录：company_meta:config.pause_epoch（缺省为 0）；company_meta:dispatch_gate；audit 中的 dispatch_pause 与 dispatch_restore 行；dispatch_pass 行。每个 pass 一行，已结束且超过 1 天的行在新 pass 开始时删除，running 行不删除。启动回收把确证死亡的同主机行改为 abandoned（不删行），abandoned 行由此进入同一条 1 天清理。
- 环境变量：分支没有新增 process.env 读取。RUN_SCK_DISPATCH_PAUSE_TESTS 只用于 fork 测试。install 沿用 SCK_RELEASE_KEEP 与 SCK_COMPONENTS。
- 主机准备：无。
- 插件构建：plugin/paseo-plugin.json 的 build 步骤运行 scripts/vendor.sh，生成 plugin/server/vendor/（已被 .gitignore 忽略）。release 在切换前必须已生成 vendor。
- 本地测试：只用公司 fork SurrealDB（~/.surrealdb/surreal），不用上游官方 SurrealDB。

## 7. 已知限制

标 ★ 的条目需要 GM 决定。

1. ★ 陈旧 running 行（已修复，SYS-DISP 876e36e2 H1）。旧缺陷：进程被强制结束时 pass 的 finally 不执行，行保持 running，之后所有 dispatch_pause 的 drained 都无法为 true。现在两个派工器入口都在首个 pass 前调用一次 reapStaleRunningPasses（src/dispatch-pause.ts）：独立进程在 src/dispatcher/run.ts 的 bootstrap 之后；插件在 plugin/server/dispatch.ts 的循环内、company 引导完成后、首次 tick 之前。规则：只处理 instance 为 `<主机>:<pid>:<uuid>` 三段、主机与本进程相同、且信号 0 返回 ESRCH（进程确证已死）的 running 行；把这些行改为 abandoned，并在同一事务写一条 audit（actor 为 system:dispatcher，action 为 dispatch_pass_reaped，含 instance 与证据）。跨主机、缺段或格式异常、pid 非法、pid 仍在应答（含 EPERM）、本进程自身 pid、账本读写失败，全部保持 running——死亡必须可证，绝不猜测，失败关闭。abandoned 不是 running，drain 查询自动不计；不删除任何历史行。回归：tests/dispatch-pause-reap.test.ts（判定表与失败关闭，注入探针）；tests/dispatch-pause.fork.test.ts 的 H1 用例（真实公司 fork：孤儿→回收→dispatch_pause 排空可达 true；活进程与跨主机、格式异常行保持 running 且仍计入 blocking；重复回收不重复审计）。
2. 无任务派工不经过租约闸门。GM 与 eval 的唤醒与 spawn 走 assign（src/dispatcher/dispatcher.ts:1504，调用点 :1251、:1280、:1336），没有 task，不调用 claimLease。它们只受 pass 级 gate（:934）与排空约束。drained 为 false 时，仍在运行的旧 pass 可能完成一次无任务唤醒或生成。
3. 持有租约的员工继续续租、提交与复核，静默收尾提醒照常发出。暂停不停止在办任务。
4. admin config 拒绝维护键（SYS-DISP 876e36e2 H2）。src/admin.ts 的 `config paused` 与 `config pause_epoch` 在任何写入之前被拒绝：输出 {ok:false, code:"invalid"}、退出码 1，文案指向 sck call dispatch_pause / dispatch_restore（gm manage）、dispatch_status（读取）、dispatch_audit（审计回读）。此前该入口经 writePause 直接落状态：没有比较并交换、不等待排空，是与 GM 入口并存的旁路；受权 API 两面接线完成后（core、MCP、sidecar 白名单），旁路取消。老板 UI 与 owner_command 的 pause/resume 不变，仍走 writePause 事务（见第 5 条）。config 其余键（max_running、eval_enabled 等）行为不变。回归：tests/dispatch-pause-tick.fork.test.ts 的 R-A 两用例（拒绝先于写入、无审计行产生、其余键照常可写、报错文案含两条真实命令；以及 gm 停派/恢复生命周期经 dispatch_audit 可核验）。
5. 老板路径（UI 按钮、owner_command 的 pause 与 resume）调用 owner.setPaused（src/owner.ts:319）。它同样经过 PAUSE_TXN（纪元、审计、gate），但不做比较并交换，也不排空。老板的恢复可以解除 GM 的暂停，这是设计。
6. ★ 复用不检查 def.enabled。staffingPool 的复用分支（src/dispatcher/dispatcher.ts:233 至 :253）没有 def.enabled 检查，只有新建分支检查（:261）。因此 def_ensure 写 enabled=false 不是停派手段。本分支未改此行为，按决定保留披露。
7. drainTimeoutSeconds 默认 120 秒是设计默认值，未在生产测量。
8. 本分支未经生产验证。第 4 节的生产验证由 3381c477 执行。
9. ★ 审计行读取（已修复，SYS-DISP 876e36e2 裁决第 6 条）：dispatch_audit（gm manage、MCP 与 sidecar 白名单内）按 operationId 回读一条 dispatch_pause/dispatch_restore 审计行，返回 actor、paused/previous_paused、epoch/previous_epoch、sequence、at、evidence。仅限这两类 action；其他审计行（任务、凭证、worktree）不经此面暴露。部署 QA 由此核验两条维护审计，无需裸库访问。回归在 R-A 端到端用例（含 forbidden、invalid、not_found 三态）。
10. 安装顺序与恢复风险：`company-service.sh install` 先重指插件（remove+install），再重启 MCP；`docs/company-service-operations.md` 第 3 节写的是 MCP ready 后再切插件。实际顺序意味着插件先指向新 release，若随后 MCP 重启或 bootstrap 失败，两面会短暂不一致。恢复：立即用 PREV 重新 install（双面回滚），或在 MCP 就绪后用 PREV/REL 的 plugin 重新 install+reload；不得只改 active。本迁移为加法，可以接受；非加法迁移前需统一顺序（待 GM 决定）。

## 8. 本手册编写期间的执行情况

- 未执行任何 pause、restore、install、服务或插件启停，未写入任何生产数据。
- 未读取 token、凭证、env 或 private/ 目录。
- 代码未改动。本手册只描述 PR #1494 现有代码。
- 证据目录：`/Users/y/Library/Application Support/SurrealCKCompany/evidence/afdb562c-e217-493e-8060-3c60bbf50bfe/`。
