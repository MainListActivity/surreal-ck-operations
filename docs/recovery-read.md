# FV06 恢复取证子租约（recovery read grant）

本文件描述 `recovery_read_grant` 的现役边界与状态语义。它只用于**终态（done）源任务**的一次性只读取证；
grant 不是执行租约，不能写任务、不能 checkpoint/submit/review/report_blocker，也不能调用其它 ops 工具。

## 1. 授权与通道

- 只有 gm 能签发，必须绑定：源任务（done 且已有 fault episode）、员工、单一别名、四条精确 GET 路径、
  截止时间与一份同目标已完成的 `authorization_task`；签发者不得自授。
- 每个源任务一条 `recovery_read_chain` 链头；并发的两笔签发只有一笔能建成链，另一笔按已有链拒绝。
  新 grant / rearm 从上一链原样承接 `login_attempts`、`per_path` 等计数，**不清零**。
- dispatcher 只唤醒 grant 指定的员工；员工正持有执行租约时通道拒绝绑定，grant 保持可重试。
- 通道绑定在 sidecar 的独立 `recoveryClaims` 中，不伪造 doing/review claim；请求里的
  `taskId`/`sourceTaskId`/`grantId` 一律丢弃或拒绝，源任务 id 只来自通道绑定。

## 2. 链级顺序、计数与停止

固定顺序：一次 `ops_operator_login`，随后四条 GET（temporary-grant → platform-operators →
internal-ai/runtime → runtime-version），最后按需 `ops_logout`。

- 每次调用先在链上原子 `reserve`：登录最多 1 次；GET 必须是下一个未调用路径且每条最多 1 次；
  同一时刻只允许一个 `in_flight`，并发第二个 reserve 返回 busy，不递增任何计数。
- `settle` 记录真实结果：第 1 项 temporary-grant 的预期结果是 **503 +
  `endpoint-probe-temporary-grant-not-configured`**（属于成功取证，不因非 2xx 停止）；第 2–4 项要求
  200 且严格视图完整。其它 status/body、解析拒绝或传输失败都会停止余项。
- `stopped` 是链级终态：不得另发 grant 自动清零次数；`rearm` 必须另附授权且保留计数。
- 必要 `ops_logout` 在 stopped/expired/revoked 下仍然允许：只丢弃本 grant 的本地会话，不重登、
  不声称远端注销；停止/到期/撤销时也会自动清理本地会话。

## 3. status 超期推进（惰性、幂等、不扩权限）

`status`、`reserve`、`bind`、`grantFor`、`grantsFor` 在读到**已超过 deadline 的 inFlight** 时，会把它
惰性推进为 `stopped(unknown_outcome)`，并写一条 `recovery_read_stop` 审计：

- 只推进本次 grant 的状态，不重试该路径、不补发请求；
- 不授予执行租约、不改源任务状态或 fault 预算、不 lift；
- 重复读到同一超期 inFlight 只产生一次推进（幂等）；
- 不扩大任何角色或工具的权限；status 仍是只读入口，调用方不能借它改写 grant。

## 4. 预算：退款与成功结算的区别

broker 在调用前 `reserveFault` 预留一次故障预算；如果随后**链级 reserve 拒绝**（busy/forbidden/顺序等），
这次调用**没有执行**，必须走 `refundFault`：

- 退款只撤销本次预留，恢复 `attempts`、`total_attempts`、`deadline`、`next_allowed_at`、
  `last_attempt_at`、`failed` 到预留前；`stopped`、`incident`、`last_errno` 等事实不动。
- 退款用 CAS：只有 budget 行仍精确等于本次预留写入的后状态才成功；并发新失败、stop、lift 或真实成功
  会让退款变成 superseded no-op，绝不覆盖更新的状态；同一 token 重复退款也不会重复扣减。
- `failed=false` 的首次调用（未 charged）与必要 logout 不产生退款或结算。
- 真实上游成功仍走 `settleFault`：`failed=false`、`attempts=0`、`next_allowed_at=now`，累计
  `total_attempts` 保留。**不得**用 `settleFault` 处理未执行的调用。
- 源任务 id 保持不变；本流程不新建任务、不换预算键、不自动 lift。
