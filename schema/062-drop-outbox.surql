-- 062：删除 outbox 事件表、序号索引与计数器（0.7.1）。0.7.0 起核心不再写 outbox，这三样只为它服务。
-- 只删除表、索引与计数器，不改写任何其它表的既有行；IF EXISTS 让重复执行与全新库都不报错。
-- 前提：所有执行端已是 0.7.0 或更新。0.6.x 仍在任务事务里写 outbox 并用计数器分配序号，删除后它的写入会失败，或写入无序号的行。
REMOVE INDEX IF EXISTS outbox_sequence ON TABLE outbox;
REMOVE TABLE IF EXISTS outbox;
DELETE company_meta:outbox_counter;
