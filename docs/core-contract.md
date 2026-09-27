# 核心与 MCP adapter 契约 v1

`src/contracts.ts` 是唯一导出边界。MCP adapter 只能接收用户提供的 opaque credential，每次调用由 core 从数据库凭证哈希查出 `Principal`；调用者不能传入 employeeId、role、capabilities。`EnrollmentAdmin` 仅供本机 bootstrap/运维命令，不注册为普通 MCP tool。

任务写入时，`deliveryId + fence + expectedVersion` 共同约束本次领取和乐观版本。成功状态变更返回新 `TaskView.version`；下一次写入必须用新版本。重试时同一 `idempotencyKey` 返回原结果或无副作用地确认完成，键被不同内容重用必须冲突。数据库时间决定租约生效和过期；旧执行人的过期写入拒绝。

`createTask` 由管理能力控制，输入带上下文和依赖。`claim` 由当前任务岗位与执行/验收能力控制；验收人不能是 `submittedBy`。`block` 保存恢复岗位/状态；`resume` 仅管理岗位。接受任务解锁依赖，所有转移同事务写审计及持久 outbox，供 #25 transport 与 #27 同步器消费。

adapter 负责 MCP initialize、工具 schema、错误映射和本地绑定；core 不承担传输或进程常驻。错误代码以 `CompanyError.code` 为准。数据库配置仅由后端环境加载，不交给 MCP 客户端。
