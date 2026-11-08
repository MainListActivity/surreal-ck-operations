-- 059：移除 055 的 runner / automation 字段守卫（需求、验收、正文、保留）。
-- 老板定（2026-11-08）：持有任务的员工可执行老板端全部操作；云端执行端以 runner 身份代员工与老板写库（含 task.create），
-- 字段守卫会挡住建单、改单与消息管理。权限由网关的命令守卫（command-guard + 按目标锁 + 仅老板清单）承担；
-- protected_command / agent_policy / ops_audit 的守卫（056）不变。
REMOVE EVENT IF EXISTS task_owner_fields_update ON TABLE task;
REMOVE EVENT IF EXISTS task_owner_fields_create ON TABLE task;
REMOVE EVENT IF EXISTS outbound_message_owner_fields ON TABLE outbound_message;
