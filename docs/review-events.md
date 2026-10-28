# QA 评审协同的持久事件唤醒

协同任务（例如 3cf7477d）过去只能用一个**固定时间等待**去赌 QA 观察窗口：QA 真正领到 review 租约、或发出结构化
scope 请求时都没有任何东西通知它，窗口一过就错过；用 shell 监视又跨不过调度轮次重启。本能力把这件事收敛成一条
**受控持久订阅**：只唤醒，不授权。

## 两种角色，两条路径

**GM（`manage`）登记订阅** —— `review_watch_register`

- 只接受同 goal 的一对任务：`sourceTaskId`（必须是 `reviewerRole=qa` 的任务）与 `collaborationTaskId`（未终态）。
  两项都是**精确任务 id**，没有通配符、没有模式、没有跨 goal 的写法。
- `eventKinds` 只能是 `authorization` / `positive` 的子集，默认两者都要。
- 同一对任务只有一条订阅（`watch_key` 唯一）；再次登记是重开同一条，`eventKinds` 不同会被拒绝而不是改写。
- **登记即读当前状态**：登记事务落库后立刻读源任务的真实租约与已有结构化信号，把“事件已经发生”的情况补交付。
  因此“事件先于登记”不会丢唤醒。
- `review_watch_close` 按版本关闭；未交付的事件被作废，永不再放行。`review_watch_status` 是只读面：源任务当前
  `state / reviewerRole / holder / fence / leaseLive`、最近一次结构化信号、以及每个事件的交付结果与 code。

**QA（本人凭证 + 活跃 review 租约）发结构化信号** —— `qa_review_scope_signal`

- 服务端在事务里核对：`state='review'`、`reviewer_role='qa'`、`current_employee` 是本 QA、`fence` 与传入一致、
  租约未过期、且本 QA 不是源任务或任何 subject 的作者。任何一项不符就拒绝。
- `subjects` 是**同 goal 的精确任务 id**（1–50 个），不是任务文本；不存在、跨 goal、本人作者都整单拒绝。
- 两阶段：`kind=request` 是 `authorization`；`kind=retract` + `positiveReady=true` 是 `positive`。没有 request 的
  retract、同一 fence 的第二个 retract 都被拒绝。
- **checkpoint 里的 `SCOPE_REQUEST` / `SCOPE_POSITIVE_READY` 只是提示**，不是信号。只有这个工具写入的行会触发事件。

## 订阅怎么被唤醒

协同任务用 SYS05 的既有等待把自己挂到订阅上：

```
kind=feedback
reference=review-watch:<watchId>
```

`wait_task` 会核对这个引用指向的订阅是**活跃**的、且**本任务就是它的 collaboration task**：任务不能挂到别家的
订阅上，关闭的订阅也不能继续让任务停在队列外。

事件到达时只做一件事：解除这个任务自己的 feedback 等待（同一个 `releaseOne` 事务），任务回到 `ready`，调度器
下一轮重新派 GM。**它不创建 `qa_observation_scope`、不写验收证据、不改源任务租约、不把 QA 的等待变成产品 return。**

## 幂等、失效与零轮询

- 事件身份 = 订阅 + 源任务 **review fence** + 事件类型。同一 fence 的 claim 与结构化请求共用一个
  `authorization`；重复 claim、重复请求、重启重放、两个进程同时触发，都只有一个事件（唯一索引落库，重复者得到
  `duplicate`）。交付只有一次释放，其余是 `already_released`。
- **交付前重新读活租约**：fence 变了、holder 换了、任务离开 review、租约过期，事件被标为 `stale` 并写明原因，不会
  在事后唤醒任何人。return / accept 时该源任务的未交付事件一并作废，新 fence 才会产生新事件。
- 调度器的到点扫描（`releaseDue`）**从不**释放 feedback 等待；没有真实事件时，协同任务就一直是 blocked。事件只有
  三个来源：QA 的 review claim、结构化 request、结构化 retract（positive）。没有 agent、没有定时器、没有轮询。
- 所有写入都进 audit，带任务与 fence，`subjects` 只有任务 id，reason 走既有非敏感校验；payload 不含任务文本与凭证。

## 工具面

| 工具 | 角色 | 说明 |
| --- | --- | --- |
| `review_watch_register` | gm | 登记/重开一条同 goal 订阅，并补交付当前状态 |
| `review_watch_close` | gm | 按版本关闭；未交付事件作废 |
| `review_watch_status` | gm / qa | 只读：租约事实、最近信号、事件交付结果 |
| `qa_review_scope_signal` | qa（活跃复核租约持有人） | request / positive retract |
| `review_scope_signals` | gm / qa | 只读信号历史（qa 只看自己的） |

## 回滚隔离（RB01）

`schema/044-review-events.surql` 只新增 `qa_review_watch` / `qa_review_signal` / `qa_review_wake` 三张表与索引，
不改写任何既有表、字段或行。旧版发布读不到这三张表即忽略：协同任务退回“固定时间等待”，不会误派、不会误关。

## 回归

- `tests/review-events.test.ts`：纯规则（事件身份、订阅对、事件类型、subject 归一、失效判定）。
- `tests/review-events.fork.test.ts`：公司 fork 真实事务，覆盖事件先于登记、登记先于事件、20 并发、重启、旧
  fence、return 重领、重复通知、授权/撤销两阶段、零轮询，以及非 gm / 跨 goal / 假 holder / 假 fence / 跨 goal
  subject / 给别家订阅等待 / checkpoint 文本自授权的负例。
- 两个文件都在 `sidecar-review` 发布门禁里（`RUN_SCK_REVIEW_EVENT_FORK_TESTS=1`）。
