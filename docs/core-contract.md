# 核心契约 v1（0.7.0）

`src/contracts.ts` 是核心的导出边界。核心（`SurrealCompanyCore`，`src/core.ts`）由插件进程内的员工通道（sidecar）与老板接口调用。调用方只能传入自己持有的凭证，由核心从数据库凭证摘要查出 `Principal`。调用方不能在参数中指定 employeeId、role 或 capabilities。

`LocalEnrollmentAdmin`（`src/enrollment.ts`）是独立对象，仅供本机运维命令使用，不对员工开放。

## 写入、租约与版本

- 任务写入时，`deliveryId + fence + expectedVersion` 共同约束本次领取和乐观版本。成功状态变更返回新的 `TaskView.version`，下一次写入必须用新版本。
- 重试时同一 `idempotencyKey` 返回原结果，或无副作用地确认完成。同一键被不同内容重用时必须冲突。
- 租约的生效与过期由数据库时间决定（`time::unix(time::now())`）。旧执行人的过期写入会被拒绝。
- 默认租约时长为 600 秒（`DEFAULT_LEASE_SECONDS`，`src/core.ts`）。构造选项 `leaseSeconds` 只能由受控测试进程设置在 1 到 3600 秒之间，员工请求参数不能设置租约时长。
- sidecar 在写工具（`checkpoint`、`submit`、`review`、`report_blocker`）调用时组装 `LeaseProof`（`taskId`、`deliveryId`、`fence`、`expectedVersion`），员工不传这些字段。

## 权限

- `createTask` 由管理能力控制，输入可以带上下文与依赖。
- `claim` 由当前任务的岗位与执行或验收能力控制。验收人不能是 `submittedBy`。
- `block` 保存恢复岗位与状态；`resume` 仅管理岗位可用。
- 验收通过（`accept`）会解锁依赖任务。

## 审计

核心的每次状态转移都在同一事务内写入审计（`audit` 表，`CREATE audit` 与状态变更同事务提交）。审计不包含凭证值。

0.7.0 删除了 `outbox` 事件表与 `company_meta:outbox_counter` 计数器（schema 062）。核心不再写 outbox 事件，也没有 `listOutbox()` 接口。下游如需同步任务变化，只能通过审计表或直接查询任务状态。

待确认：`src/core.ts`、`src/owner.ts`、`src/owner-api.ts` 与 `src/database.ts` 在当前工作区仍包含 outbox 的写入与读取，删除需要与 schema 062 在同一变更中完成。

## 错误

`CompanyError.code` 为错误码的权威来源（`src/core-errors.ts`）。完整列表包括：

`unauthorized`、`forbidden`、`not_found`、`conflict`、`invalid`、`worktree_busy`、`already_claimed`、`lease_expired`、`self_review`、`temporarily_unavailable`、`checkpoint_limit`、`not_configured`、`unavailable`、`payment_approval_required`、`upstream_error`、`login_failed`、`limit_reached`、`response_too_large`、`snapshot_gone`、`retire_refused`。

`retryable` 为 true 的只有 `temporarily_unavailable`，表示数据库争用已在内部有限次重试后仍失败。其他错误需要调用方改变请求或状态后再试。

## 数据库访问

- `CompanyDatabase.connect()` 之后先执行 bootstrap，再创建 `SurrealCompanyCore`。
- 节点上的核心连接由插件的运行配置决定，凭证路径与角色见 `src/config.ts`。节点更新器只使用 runner 角色，并且只连接云端库（需要 `COMPANY_DB_URL`）。
- 数据库访问凭证不进入日志、Issue 或员工会话。
- 测试只使用公司 fork（`~/.surrealdb/surreal`）。测试进程只认环境变量显式给出的地址，不读取服务目录中的生产配置。
