-- SYS05 P1 时间与外部事件等待状态机（本 lane 取号 040；039 已由主干 task-recovery 使用）。
--
-- 只新增表与索引：不新增、不改写 task / audit / outbox / dispatch / disposition_* / fault_* 的任何既有字段，
-- 也不改任何已有行的类型。新代码在 task 上写入的是 schemaless 的新字段（wait_* 与 users 既有字段的清除），
-- 旧版不读这些字段。
--
-- 回滚隔离（RB01）：
--   进入等待时任务置为 state='blocked'、blocked_to=NONE、resume_state=ready|review。旧版调度器的派工队列只取
--   ready/doing/review，因此旧版不会认领或拉起一个等待中的任务；旧版的依赖解锁 SQL 也不会在没有依赖完成事件时
--   动它，新版本另外在 UNLOCK_CHILDREN_SQL 里排除 wait_state='waiting'，双重保证到点前不会被别的解锁路径放行。
--   task_wait / wait_event 两张表旧版完全不读：忽略（允许），不会误派工。
--
-- 新增状态起点（RB01 清单，旧版行为）：
--   task.wait_state = 'waiting'                          —— 旧版不读：任务看起来是一条普通依赖阻塞（不派工，允许）
--   task.wait_kind / wait_not_before / wait_expires_at / wait_next_check_at / wait_episode / wait_owner_role
--                                                        —— 旧版不读：忽略
--   task_wait.state = waiting|released|held|expired|cancelled|superseded
--                                                        —— 旧版不读该表：忽略
--   wait_event.accepted / event_key                      —— 旧版不读：忽略

-- 一次等待：一个任务的一段时间/一个外部事件条件。同一任务可以先后有多个等待，但同一时刻只有一个 waiting。
DEFINE TABLE IF NOT EXISTS task_wait SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS wait_key ON task_wait TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON task_wait TYPE record<task>;
-- time|dependency|upstream_repair|customer_activation|owner_handoff|feedback
DEFINE FIELD IF NOT EXISTS kind ON task_wait TYPE string
  ASSERT $value IN ['time', 'dependency', 'upstream_repair', 'customer_activation', 'owner_handoff', 'feedback'];
-- waiting|released|held|expired|cancelled|superseded
--   waiting    —— 条件尚未满足；任务不在派工队列、不占租约与容量；
--   released   —— 条件已由时钟或受信事件解除，任务已回到 resume_state；
--   held       —— 时间已到但依赖/老板关口未清，不能放行（只释放时间条件，不代替依赖或批准）；
--   expired    —— 精确到期已过且没有到期前的受信事件；不自动放行，等待延期或取消；
--   cancelled  —— 授权人取消；
--   superseded —— 同一任务进入了新的等待。
DEFINE FIELD IF NOT EXISTS state ON task_wait TYPE string
  ASSERT $value IN ['waiting', 'released', 'held', 'expired', 'cancelled', 'superseded'];
-- 事件来源：time|dependency|webhook|authorized_person|owner。provider/account 只写非敏感别名。
DEFINE FIELD IF NOT EXISTS source ON task_wait TYPE object FLEXIBLE;
-- 谁负责解除：owner / 岗位名。
DEFINE FIELD IF NOT EXISTS owner_role ON task_wait TYPE string ASSERT string::len($value) > 0;
-- 已交接物的非敏感引用（id、票据键）；禁止密钥、邀请链接与高熵材料（core 校验）。
DEFINE FIELD IF NOT EXISTS reference ON task_wait TYPE option<string>;
-- 依赖/上游修复等待指向的精确任务。
DEFINE FIELD IF NOT EXISTS reference_task ON task_wait TYPE option<record<task>>;
-- 绝对时刻，unix 毫秒；display timezone 不参与判定。
DEFINE FIELD IF NOT EXISTS not_before ON task_wait TYPE option<int>;
-- 工具返回的精确到期；缺省时 expires_source=unknown，绝不由时长自行推算。
DEFINE FIELD IF NOT EXISTS expires_at ON task_wait TYPE option<int>;
DEFINE FIELD IF NOT EXISTS expires_source ON task_wait TYPE string ASSERT $value IN ['exact', 'unknown'];
DEFINE FIELD IF NOT EXISTS next_check_at ON task_wait TYPE option<int>;
DEFINE FIELD IF NOT EXISTS timezone ON task_wait TYPE option<string>;
-- 进入等待时原子保存的进度快照（持有人、任务版本、最后 checkpoint 摘要）；不是对外部世界的断言。
DEFINE FIELD IF NOT EXISTS progress ON task_wait TYPE object FLEXIBLE;
-- 老板交接卡的技术项与待办动作；已脱敏、限长。
DEFINE FIELD IF NOT EXISTS completed ON task_wait TYPE array<string>;
DEFINE FIELD IF NOT EXISTS pending_action ON task_wait TYPE option<string>;
-- 受控 handoff 文件的路径；卡片只显示文件名，不显示 secret 内容。邀请链接只留在这个文件里。
DEFINE FIELD IF NOT EXISTS handoff_file ON task_wait TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reason ON task_wait TYPE string ASSERT string::len($value) >= 10;
DEFINE FIELD IF NOT EXISTS version ON task_wait TYPE int ASSERT $value >= 1;
-- 进入等待的持有人与任务版本；旧 fence 的晚到写入不会复活这个等待。
DEFINE FIELD IF NOT EXISTS entered_by ON task_wait TYPE string;
DEFINE FIELD IF NOT EXISTS entered_version ON task_wait TYPE int;
DEFINE FIELD IF NOT EXISTS entered_at ON task_wait TYPE datetime;
DEFINE FIELD IF NOT EXISTS released_at ON task_wait TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS released_by ON task_wait TYPE option<string>;
DEFINE FIELD IF NOT EXISTS release_source ON task_wait TYPE option<string>;
DEFINE FIELD IF NOT EXISTS held_reason ON task_wait TYPE option<string>;
DEFINE FIELD IF NOT EXISTS cancelled_reason ON task_wait TYPE option<string>;
DEFINE FIELD IF NOT EXISTS previous_wait ON task_wait TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at ON task_wait TYPE datetime;
DEFINE INDEX IF NOT EXISTS task_wait_key ON task_wait FIELDS wait_key UNIQUE;
DEFINE INDEX IF NOT EXISTS task_wait_task ON task_wait FIELDS task, state;
DEFINE INDEX IF NOT EXISTS task_wait_due ON task_wait FIELDS state, kind, not_before;
DEFINE INDEX IF NOT EXISTS task_wait_check ON task_wait FIELDS state, next_check_at;
-- 同一任务同一时刻只能有一个 waiting：并发进入等待留一条，另一条被拒。
DEFINE INDEX IF NOT EXISTS task_wait_open ON task_wait FIELDS task, state;

-- 受信事件：签名 webhook、授权人确认或 owner relay 的决定。event_key 唯一，重复事件被拒。
DEFINE TABLE IF NOT EXISTS wait_event SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS event_key ON wait_event TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS wait_key ON wait_event TYPE string;
DEFINE FIELD IF NOT EXISTS task ON wait_event TYPE record<task>;
DEFINE FIELD IF NOT EXISTS kind ON wait_event TYPE string
  ASSERT $value IN ['dependency', 'webhook', 'authorized_person', 'owner'];
DEFINE FIELD IF NOT EXISTS provider ON wait_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS account ON wait_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS external_id ON wait_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS at_ms ON wait_event TYPE int;
DEFINE FIELD IF NOT EXISTS accepted ON wait_event TYPE bool;
DEFINE FIELD IF NOT EXISTS refusal ON wait_event TYPE option<string>;
-- 谁确认的：员工 id 或受信通道名（webhook:<provider>）。
DEFINE FIELD IF NOT EXISTS actor ON wait_event TYPE string;
DEFINE FIELD IF NOT EXISTS payload_digest ON wait_event TYPE option<string>;
-- owner relay 转录的老板原话（脱敏、限长）；模型自述不会走到这里。
DEFINE FIELD IF NOT EXISTS owner_quote ON wait_event TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON wait_event TYPE datetime;
DEFINE INDEX IF NOT EXISTS wait_event_key ON wait_event FIELDS event_key UNIQUE;
DEFINE INDEX IF NOT EXISTS wait_event_wait ON wait_event FIELDS wait_key, created_at;
