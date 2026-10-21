-- v24: 分页快照的全库配额（SYS01 R4）。仅新增一张计数表，并在 query_snapshot 上新增三个可缺省的字段；不改写任何既有行。
-- query_snapshot_quota:global 是唯一计数记录，由快照存储在首次使用时以 INSERT IGNORE 创建。
-- 每次预留、提交、淘汰与释放都与快照行在同一事务内改动计数并递增 version，因此跨进程的上限与释放恰好一次。
-- 既有快照没有这三个字段（读作 NONE），存储代码以 ?? 0 处理；schema 021 及更早版本的代码不读写这些字段。
DEFINE TABLE IF NOT EXISTS query_snapshot_quota SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS listings ON query_snapshot_quota TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS bytes ON query_snapshot_quota TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS version ON query_snapshot_quota TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS seq ON query_snapshot_quota TYPE int ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS created_seq ON query_snapshot TYPE option<int>;
DEFINE FIELD IF NOT EXISTS written_rows ON query_snapshot TYPE option<int>;
DEFINE FIELD IF NOT EXISTS written_bytes ON query_snapshot TYPE option<int>;
