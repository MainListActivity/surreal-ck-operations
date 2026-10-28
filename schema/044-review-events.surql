-- SYS-INT · QA 评审协同的持久事件唤醒（本 lane 取号 044）。
--
-- 只新增三张表与索引：不改写 task / audit / outbox / task_wait / wait_event / qa_observation_* 的任何既有字段
-- 或行，也不改任何已有行的类型。协同任务的等待仍走 SYS05 的 task_wait（kind=feedback），事件到达后由同一
-- releaseOne 事务解除，所以旧版调度器读不到这三张表即忽略，行为退回“固定时间等待”（RB01：不误派、不误关）。
--
-- 回滚隔离（RB01）：
--   qa_review_watch / qa_review_signal / qa_review_wake 旧版完全不读：忽略（允许），不会误派工。
--   协同任务的 wait_* 是 040 已有的 schemaless 字段，旧版已能安全处理等待行。
--   事件只解除等待并把任务放回 ready（由 dispatcher 重新派 GM），不生成 qa_observation_scope、不写验收证据。

-- 一条订阅：GM 登记的同 goal（源任务, 协同任务）有序对。watch_key 唯一，同一对任务重复登记就是同一条订阅。
DEFINE TABLE IF NOT EXISTS qa_review_watch SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS watch_key ON qa_review_watch TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS goal ON qa_review_watch TYPE record<goal>;
DEFINE FIELD IF NOT EXISTS source_task ON qa_review_watch TYPE record<task>;
DEFINE FIELD IF NOT EXISTS collaboration_task ON qa_review_watch TYPE record<task>;
-- authorization|positive（登记时显式给出，只能是这两个）。
DEFINE FIELD IF NOT EXISTS event_kinds ON qa_review_watch TYPE array<string>;
-- active|closed。关闭后不再产生新事件，未交付事件一并作废。
DEFINE FIELD IF NOT EXISTS state ON qa_review_watch TYPE string ASSERT $value IN ['active', 'closed'];
DEFINE FIELD IF NOT EXISTS version ON qa_review_watch TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS reason ON qa_review_watch TYPE string ASSERT string::len($value) >= 8;
DEFINE FIELD IF NOT EXISTS created_by ON qa_review_watch TYPE record<employee>;
DEFINE FIELD IF NOT EXISTS created_at ON qa_review_watch TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON qa_review_watch TYPE datetime;
DEFINE FIELD IF NOT EXISTS closed_at ON qa_review_watch TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS closed_by ON qa_review_watch TYPE option<record<employee>>;
DEFINE FIELD IF NOT EXISTS closed_reason ON qa_review_watch TYPE option<string>;
DEFINE INDEX IF NOT EXISTS qa_review_watch_key ON qa_review_watch FIELDS watch_key UNIQUE;
DEFINE INDEX IF NOT EXISTS qa_review_watch_source ON qa_review_watch FIELDS state, source_task;
DEFINE INDEX IF NOT EXISTS qa_review_watch_collab ON qa_review_watch FIELDS collaboration_task, state;

-- 一条结构化信号：当前 QA 复核租约的持有人对一批 subject 任务请求/撤销授权。
-- 身份 = 任务 + review fence + 持有人；同一 fence 只允许一个 request，之后只能由它转成 retract。
DEFINE TABLE IF NOT EXISTS qa_review_signal SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS signal_key ON qa_review_signal TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON qa_review_signal TYPE record<task>;
DEFINE FIELD IF NOT EXISTS goal ON qa_review_signal TYPE record<goal>;
DEFINE FIELD IF NOT EXISTS actor ON qa_review_signal TYPE string;
DEFINE FIELD IF NOT EXISTS fence ON qa_review_signal TYPE int ASSERT $value >= 1;
-- request|retract：本行最近一次写入的动作。
DEFINE FIELD IF NOT EXISTS kind ON qa_review_signal TYPE string ASSERT $value IN ['request', 'retract'];
-- requested|retracted：当前阶段。只有 requested 可以转成 retracted。
DEFINE FIELD IF NOT EXISTS state ON qa_review_signal TYPE string ASSERT $value IN ['requested', 'retracted'];
-- 一批 subject 任务 id（不是任务文本）；同 goal、非作者，core 校验。
DEFINE FIELD IF NOT EXISTS subjects ON qa_review_signal TYPE array<string>;
-- 撤销时声明正向取证完成（第二阶段的 positive 事件）；请求阶段恒为 false。
DEFINE FIELD IF NOT EXISTS positive_ready ON qa_review_signal TYPE bool;
DEFINE FIELD IF NOT EXISTS reason ON qa_review_signal TYPE string ASSERT string::len($value) >= 8;
DEFINE FIELD IF NOT EXISTS version ON qa_review_signal TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS created_at ON qa_review_signal TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON qa_review_signal TYPE datetime;
DEFINE FIELD IF NOT EXISTS retracted_at ON qa_review_signal TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS qa_review_signal_key ON qa_review_signal FIELDS signal_key UNIQUE;
DEFINE INDEX IF NOT EXISTS qa_review_signal_task ON qa_review_signal FIELDS task, fence;

-- 一个已产生、待交付或已交付的唤醒事件。event_key 唯一，重复的 claim/请求/重启重放不会产生第二个事件。
DEFINE TABLE IF NOT EXISTS qa_review_wake SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS event_key ON qa_review_wake TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS watch ON qa_review_wake TYPE record<qa_review_watch>;
DEFINE FIELD IF NOT EXISTS source_task ON qa_review_wake TYPE record<task>;
DEFINE FIELD IF NOT EXISTS collaboration_task ON qa_review_wake TYPE record<task>;
DEFINE FIELD IF NOT EXISTS kind ON qa_review_wake TYPE string ASSERT $value IN ['authorization', 'positive'];
DEFINE FIELD IF NOT EXISTS fence ON qa_review_wake TYPE int ASSERT $value >= 1;
-- 产生事件的持有人（claim 的 QA 或结构化信号的 QA）。
DEFINE FIELD IF NOT EXISTS actor ON qa_review_wake TYPE string;
DEFINE FIELD IF NOT EXISTS subjects ON qa_review_wake TYPE array<string>;
DEFINE FIELD IF NOT EXISTS reason ON qa_review_wake TYPE option<string>;
-- 交付结果：delivered=true 且 code=released 表示协同任务的等待真的被解除。
DEFINE FIELD IF NOT EXISTS delivered ON qa_review_wake TYPE bool;
DEFINE FIELD IF NOT EXISTS delivered_at ON qa_review_wake TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS code ON qa_review_wake TYPE option<string>;
DEFINE FIELD IF NOT EXISTS wait_key ON qa_review_wake TYPE option<string>;
-- 旧 fence / 换人 / 租约失效 / 订阅关闭时写明作废原因；作废事件永不唤醒。
DEFINE FIELD IF NOT EXISTS invalidated_reason ON qa_review_wake TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON qa_review_wake TYPE datetime;
DEFINE INDEX IF NOT EXISTS qa_review_wake_key ON qa_review_wake FIELDS event_key UNIQUE;
DEFINE INDEX IF NOT EXISTS qa_review_wake_pending ON qa_review_wake FIELDS delivered, collaboration_task;
DEFINE INDEX IF NOT EXISTS qa_review_wake_watch ON qa_review_wake FIELDS watch, created_at;
