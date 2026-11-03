-- FV06 恢复取证子租约（recovery read grant），本 lane 取号 049。
--
-- 只新增两张表：不改写 task / audit / fault_* / employee 的任何既有字段或行。终态（done）源任务保持 done，
-- 不回到可租约状态；grant 不是执行租约，不能写任务，只能让被授权员工在原 taskId 的 fault 键下做一次登录、
-- 按固定顺序四次 GET 和必要 logout。
--
-- 旧版 release 读不到这两张表即忽略（RB01）；运行面只有 core 与 broker 使用它们。

DEFINE TABLE IF NOT EXISTS recovery_read_grant SCHEMAFULL PERMISSIONS NONE;
-- 源任务：必须终态 done，且已有 fault episode；grant 不改变它的状态、持有人或租约。
DEFINE FIELD IF NOT EXISTS source_task ON recovery_read_grant TYPE record<task>;
DEFINE FIELD IF NOT EXISTS employee ON recovery_read_grant TYPE record<employee>;
-- 唯一别名，签发时固定；broker 的 ops_operator_login 必须与它完全一致。
DEFINE FIELD IF NOT EXISTS alias ON recovery_read_grant TYPE string;
DEFINE FIELD IF NOT EXISTS methods ON recovery_read_grant TYPE array<string>;
-- 四条的精确路径，顺序即执行顺序。
DEFINE FIELD IF NOT EXISTS paths ON recovery_read_grant TYPE array<string>;
DEFINE FIELD IF NOT EXISTS max_login ON recovery_read_grant TYPE int;
DEFINE FIELD IF NOT EXISTS max_calls_per_path ON recovery_read_grant TYPE int;
DEFINE FIELD IF NOT EXISTS expires_at ON recovery_read_grant TYPE datetime;
-- 同目标、已完成、正文写明源任务/四条路径/次数/截止的经理或老板批准任务。
DEFINE FIELD IF NOT EXISTS authorization_task ON recovery_read_grant TYPE record<task>;
DEFINE FIELD IF NOT EXISTS reason ON recovery_read_grant TYPE string;
DEFINE FIELD IF NOT EXISTS state ON recovery_read_grant TYPE string
  ASSERT $value IN ['issued', 'bound', 'running', 'completed', 'stopped', 'revoked', 'expired'];
-- 单调计数：只增不减；新 grant / rearm 从上一链原样承接，不清零。
DEFINE FIELD IF NOT EXISTS login_attempts ON recovery_read_grant TYPE int;
DEFINE FIELD IF NOT EXISTS per_path ON recovery_read_grant TYPE array<int>;
-- 一次只允许一个 inFlight；并发第二个 reserve 看到它即 busy，不递增任何计数。
DEFINE FIELD IF NOT EXISTS in_flight ON recovery_read_grant TYPE option<object>;
DEFINE FIELD IF NOT EXISTS in_flight.path ON recovery_read_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS in_flight.started_at ON recovery_read_grant TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS in_flight.deadline ON recovery_read_grant TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS in_flight.call_id ON recovery_read_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS stop_reason ON recovery_read_grant TYPE string;
DEFINE FIELD IF NOT EXISTS result_digest ON recovery_read_grant TYPE string;
DEFINE FIELD IF NOT EXISTS created_by ON recovery_read_grant TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON recovery_read_grant TYPE datetime;
DEFINE FIELD IF NOT EXISTS bound_at ON recovery_read_grant TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS closed_at ON recovery_read_grant TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS fence ON recovery_read_grant TYPE int;
DEFINE FIELD IF NOT EXISTS version ON recovery_read_grant TYPE int;
DEFINE INDEX IF NOT EXISTS recovery_read_grant_source ON recovery_read_grant FIELDS source_task;
DEFINE INDEX IF NOT EXISTS recovery_read_grant_employee ON recovery_read_grant FIELDS employee;

-- 每个源任务一条链头（id = 源任务的确定性哈希）。签发事务通过它串行化：并发的两笔签发只有一笔能建成链，
-- 另一笔按“已有链”拒绝；rearm 在同一笔事务里推进链头并承接上一 grant 的计数。
DEFINE TABLE IF NOT EXISTS recovery_read_chain SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS task ON recovery_read_chain TYPE record<task>;
DEFINE FIELD IF NOT EXISTS latest_grant ON recovery_read_chain TYPE record<recovery_read_grant>;
DEFINE FIELD IF NOT EXISTS version ON recovery_read_chain TYPE int;
DEFINE INDEX IF NOT EXISTS recovery_read_chain_task ON recovery_read_chain FIELDS task UNIQUE;

-- 每次 recovery 调用的可读审计行（ops_call 被 historyRowsAt 排除，QA 看不到；这里只存 ID/布尔/受限字段，
-- 不含 subject、session、token、URL 或原始 body，body 只有摘要）。
DEFINE TABLE IF NOT EXISTS recovery_read_call SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS grant ON recovery_read_call TYPE record<recovery_read_grant>;
DEFINE FIELD IF NOT EXISTS source_task ON recovery_read_call TYPE record<task>;
DEFINE FIELD IF NOT EXISTS employee ON recovery_read_call TYPE record<employee>;
DEFINE FIELD IF NOT EXISTS ordinal ON recovery_read_call TYPE int;
DEFINE FIELD IF NOT EXISTS kind ON recovery_read_call TYPE string ASSERT $value IN ['login', 'get', 'logout'];
DEFINE FIELD IF NOT EXISTS path ON recovery_read_call TYPE string;
DEFINE FIELD IF NOT EXISTS status ON recovery_read_call TYPE int;
DEFINE FIELD IF NOT EXISTS ok ON recovery_read_call TYPE bool;
DEFINE FIELD IF NOT EXISTS outcome ON recovery_read_call TYPE string;
DEFINE FIELD IF NOT EXISTS digest ON recovery_read_call TYPE string;
DEFINE FIELD IF NOT EXISTS at ON recovery_read_call TYPE datetime;
DEFINE INDEX IF NOT EXISTS recovery_read_call_grant ON recovery_read_call FIELDS grant;
