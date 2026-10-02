# 核心与 MCP adapter 契约 v1

`src/contracts.ts` 是唯一导出边界。MCP adapter 只能接收用户提供的 opaque credential，每次调用由 core 从数据库凭证哈希查出 `Principal`；调用者不能传入 employeeId、role、capabilities。`LocalEnrollmentAdmin` 在 `src/enrollment.ts` 中，是独立对象，仅供本机运维命令，不注册为普通 MCP tool；adapter 只实例化 `SurrealCompanyCore`。

任务写入时，`deliveryId + fence + expectedVersion` 共同约束本次领取和乐观版本。成功状态变更返回新 `TaskView.version`；下一次写入必须用新版本。重试时同一 `idempotencyKey` 返回原结果或无副作用地确认完成，键被不同内容重用必须冲突。数据库时间决定租约生效和过期；旧执行人的过期写入拒绝。

`createTask` 由管理能力控制，输入带上下文和依赖。`claim` 由当前任务岗位与执行/验收能力控制；验收人不能是 `submittedBy`。`block` 保存恢复岗位/状态；`resume` 仅管理岗位。`updateTaskDependencies` 仅 gm+manage，对未完成且无租约的任务事务化增删依赖边；新增边必须先存在于库中，并按更新后的全图做传递闭包环检测（含反向冗余判定），同时保持原 UNLOCK 语义（依赖阻塞任务在全部依赖完成时同事务解锁为 ready）。接受任务解锁依赖，所有转移同事务写审计及持久 outbox，供 #25 transport 与 #27 同步器消费。租约由数据库 `time::unix(time::now())` 计算；`SurrealCompanyCore` 默认 TTL 600 秒，构造选项 `leaseSeconds` 可在受控测试进程设为 1–3600 秒，MCP 请求参数不能设置 TTL。

adapter 负责 MCP initialize、工具 schema、错误映射和本地绑定；core 不承担传输或进程常驻。错误代码以 `CompanyError.code` 为准。数据库配置仅由后端环境加载，不交给 MCP 客户端。

## 本机接入

在本分支 worktree 中执行 `pnpm install --frozen-lockfile`、`pnpm run typecheck`、`pnpm run bootstrap`、`pnpm run test:db`。配置通过 `SCK_PRODUCT_ENV` 指向产品 `.env`，默认路径为 `/Users/y/IdeaProjects/surreal_ck/.env`；只读取 `SURREAL_URL`、`SURREAL_ROOT_USER`、`SURREAL_ROOT_PASS`，不读取或写入产品库数据。Namespace/database 默认 `sck_agent_company/control_plane`。更改目标需设置 `SCK_COMPANY_NS` / `SCK_COMPANY_DB`，bootstrap 会检查目标归属标记，拒绝已有无关资源。

已登记员工的本机 token 位于本 worktree `.runtime/credentials/<employee-id>.token`，目录 0700、文件 0600、Git 忽略。adapter 从安全通道接收 token，不把文件内容放入日志、Issue 或响应。`test:db` 使用独立测试 Namespace `sck_agent_company_test/control_plane`，合成数据与服务目标库分离；可通过测试库审计记录和 outbox 复核。正式服务只连接 `sck_agent_company/control_plane`。

`CompanyDatabase.connect()` 后先 `bootstrap()`，再创建 `SurrealCompanyCore`。adapter 每次调用 core 方法均传 credential。对于租约相关写入，从 `claim()` 返回的 `deliveryId`、`fence` 和 `task.version` 构造 `LeaseProof`；`checkpoint()` 等成功后用新版本更新 proof。`CompanyError` 的 `code` 和 `retryable` 映射为 MCP 工具错误，不返回数据库底层错误与凭证。代码包括 `unauthorized`、`forbidden`、`not_found`、`conflict`、`invalid`、`already_claimed`、`lease_expired`、`self_review`、`temporarily_unavailable`。只有最后一项表示数据库争用已在内部有限重试后仍失败，`retryable=true`。

`listOutbox()` 仅 gm/管理能力可访问。`after` 是上次事件 ID，内部查对应持久 `sequence`，数据库侧返回序号严格更大的最多 1000 条，按序号递增。consumer 使用最后一条事件 ID 继续取页直到返回空页；不可把少于 1000 条当成服务永久静止。所有业务事件和全局序号在同一事务提交；并发写争用同一序号记录，冲突时事务重试，因此后提交的事件不会落在已经确认的游标之前。bootstrap 把旧事件按原有 `at,id` 一次性补序号，后续重复启动不改已有序号。

事件 `kind`：`created`（payload.state）、`claimed`（employee/fence）、`checkpoint`、`submit`、`accept`、`return`、`block`（version/state）、`resumed`（state）、`dependency_unlocked`（state）、`deps_updated`（dependencies/state；gm 对未完成任务的受控依赖改写）。heartbeat 不发 outbox 事件。`taskId` 只属于本新库任务；原 GitHub queue.py v2 工单不在此 outbox。#25 的 GitHub 投影应在消费端保存处理标记，并按事件 ID 去重。
