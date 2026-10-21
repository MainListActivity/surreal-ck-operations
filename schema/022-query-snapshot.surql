-- v21: 分页读取的存储快照（SYS01 C4）。仅新增两张表，不改写任何既有行。
-- query_snapshot 记录一次任务、历史或工作树列表的归属（调用人、查询摘要、岗位）与期限；
-- query_snapshot_row 保存该列表在快照时刻的各行（已序列化的 JSON 文本，按 seq 排序）。
-- 这两张表只是读取缓存，不是业务状态：任务、审计、出站事件不读写它们，schema 020 及更早版本的代码也不读写它们。
DEFINE TABLE IF NOT EXISTS query_snapshot SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS owner ON query_snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON query_snapshot TYPE string ASSERT $value IN ['context', 'history', 'worktrees'];
DEFINE FIELD IF NOT EXISTS digest ON query_snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS role ON query_snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS state ON query_snapshot TYPE string ASSERT $value IN ['building', 'ready'];
DEFINE FIELD IF NOT EXISTS row_count ON query_snapshot TYPE int;
DEFINE FIELD IF NOT EXISTS byte_count ON query_snapshot TYPE int;
DEFINE FIELD IF NOT EXISTS taken_at ON query_snapshot TYPE string;
DEFINE FIELD IF NOT EXISTS created_ms ON query_snapshot TYPE int;
DEFINE FIELD IF NOT EXISTS expires_ms ON query_snapshot TYPE int;
DEFINE INDEX IF NOT EXISTS query_snapshot_owner ON query_snapshot FIELDS owner;
DEFINE TABLE IF NOT EXISTS query_snapshot_row SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS snapshot ON query_snapshot_row TYPE string;
DEFINE FIELD IF NOT EXISTS seq ON query_snapshot_row TYPE int;
DEFINE FIELD IF NOT EXISTS body ON query_snapshot_row TYPE string;
DEFINE INDEX IF NOT EXISTS query_snapshot_row_seq ON query_snapshot_row FIELDS snapshot, seq UNIQUE;
