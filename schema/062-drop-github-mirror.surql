-- 062：删除 GitHub 镜像（0.7.0）。镜像投影已删除，outbox 只为它服务，事件表与序号计数器一并移除。
-- 只删不改既有行。降级到 0.6.1 不会恢复镜像投影（见发布说明）。

REMOVE INDEX IF EXISTS outbox_sequence ON TABLE outbox;
REMOVE TABLE IF EXISTS outbox;
DELETE company_meta:outbox_counter;
