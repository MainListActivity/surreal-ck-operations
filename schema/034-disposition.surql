-- SYS03 经理处置原子认领、业务幂等与变更通知（本 lane 取号 034）。
-- 只新增表与唯一索引：不新增、不改写 task / audit / outbox / dispatch 的任何既有字段，
-- 也不改任何已有行的类型。回滚到旧 release 时旧版对这些表一无所知（读不到即忽略），
-- 旧版可见的状态机语义由处置动作本身沿既有写入路径落库，因此旧版不会误认领、误拉起（RB01）。
--
-- 新增状态起点（RB01 清单，旧版行为）：
--   disposition_claim.status = claimed | decided        —— 旧版不读该表：忽略（允许），不产生任何行为
--   disposition_action.state = requested | confirmed    —— 同上；旧版没有对应工具（unknown_tool 拒绝）
--   holder_notice.delivered_at 有/无                     —— 同上；旧版不投递也不消费
--   external_action.state = requested|result_unknown|confirmed|refused，attribution = internal_employee|unknown_actor
--                                                       —— 同上；旧版既不发起也不对账

DEFINE TABLE IF NOT EXISTS disposition_claim SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS episode ON disposition_claim TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON disposition_claim TYPE record<task>;
DEFINE FIELD IF NOT EXISTS phase ON disposition_claim TYPE string ASSERT $value IN ['execute', 'review'];
-- 阶段开始的毫秒时刻，与调度器的 wake episode / managerActionKey 同源，是 episode 身份的一部分。
DEFINE FIELD IF NOT EXISTS episode_since ON disposition_claim TYPE int;
-- 每个 episode 的处置版本：领取与接手各升一次；决定写入必须携带当时读到的版本（CAS）。
DEFINE FIELD IF NOT EXISTS episode_version ON disposition_claim TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS status ON disposition_claim TYPE string ASSERT $value IN ['claimed', 'decided'];
DEFINE FIELD IF NOT EXISTS holder ON disposition_claim TYPE option<string>;
DEFINE FIELD IF NOT EXISTS holder_role ON disposition_claim TYPE option<string>;
-- 持有人的私有令牌：只回给持有人本人，其他人读到的是 holder/租约，永远读不到 token。
DEFINE FIELD IF NOT EXISTS token ON disposition_claim TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS lease_expires_at ON disposition_claim TYPE option<int>;
DEFINE FIELD IF NOT EXISTS taken_over_from ON disposition_claim TYPE option<string>;
DEFINE FIELD IF NOT EXISTS claimed_at ON disposition_claim TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON disposition_claim TYPE datetime;
-- 决定写入后落在这里：已处理的 episode 可被任何经理读到「结果」，不需要读 audit。
DEFINE FIELD IF NOT EXISTS decision_action ON disposition_claim TYPE option<string>;
DEFINE FIELD IF NOT EXISTS decision_business_key ON disposition_claim TYPE option<string>;
DEFINE FIELD IF NOT EXISTS decision_actor ON disposition_claim TYPE option<string>;
DEFINE FIELD IF NOT EXISTS decision_at ON disposition_claim TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS decision_task_version ON disposition_claim TYPE option<int>;
DEFINE FIELD IF NOT EXISTS decision_result ON disposition_claim TYPE option<object> FLEXIBLE;
DEFINE INDEX IF NOT EXISTS disposition_claim_episode ON disposition_claim FIELDS episode UNIQUE;

DEFINE TABLE IF NOT EXISTS disposition_action SCHEMAFULL PERMISSIONS NONE;
-- 全局业务幂等键：默认由 episode + 动作导出，与员工身份无关，所以换员工、重启或网络重放
-- 读到的是同一条处置记录，不会因为换了 employeeId 再建一条修复链。
DEFINE FIELD IF NOT EXISTS business_key ON disposition_action TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS episode ON disposition_action TYPE string;
DEFINE FIELD IF NOT EXISTS task ON disposition_action TYPE record<task>;
DEFINE FIELD IF NOT EXISTS phase ON disposition_action TYPE string ASSERT $value IN ['execute', 'review'];
DEFINE FIELD IF NOT EXISTS action ON disposition_action TYPE string ASSERT $value IN ['resume', 'defer', 'dependency', 'retire', 'repair'];
DEFINE FIELD IF NOT EXISTS state ON disposition_action TYPE string ASSERT $value IN ['requested', 'confirmed'];
DEFINE FIELD IF NOT EXISTS payload_digest ON disposition_action TYPE string;
DEFINE FIELD IF NOT EXISTS request_token ON disposition_action TYPE string;
DEFINE FIELD IF NOT EXISTS episode_version ON disposition_action TYPE int;
DEFINE FIELD IF NOT EXISTS requested_by ON disposition_action TYPE string;
DEFINE FIELD IF NOT EXISTS attempts ON disposition_action TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS task_version_before ON disposition_action TYPE int;
DEFINE FIELD IF NOT EXISTS task_version_after ON disposition_action TYPE option<int>;
DEFINE FIELD IF NOT EXISTS result ON disposition_action TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS repair_task ON disposition_action TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS created_at ON disposition_action TYPE datetime;
DEFINE FIELD IF NOT EXISTS confirmed_at ON disposition_action TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS disposition_action_key ON disposition_action FIELDS business_key UNIQUE;

DEFINE TABLE IF NOT EXISTS holder_notice SCHEMAFULL PERMISSIONS NONE;
-- 持久 outbox 通知：按 notice_key 去重（同一决定/撤租/接手只投递一次），
-- delivered_at 为 NONE 的会在通道重连、插件重启或调度下一轮补发。
DEFINE FIELD IF NOT EXISTS notice_key ON holder_notice TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS episode ON holder_notice TYPE string;
DEFINE FIELD IF NOT EXISTS task ON holder_notice TYPE record<task>;
DEFINE FIELD IF NOT EXISTS holder ON holder_notice TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON holder_notice TYPE string ASSERT $value IN ['disposition_decided', 'dependency_wait', 'resumed', 'claim_revoked', 'claim_taken_over', 'external_action', 'external_action_unknown'];
DEFINE FIELD IF NOT EXISTS text ON holder_notice TYPE string;
DEFINE FIELD IF NOT EXISTS payload ON holder_notice TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON holder_notice TYPE datetime;
DEFINE FIELD IF NOT EXISTS delivered_at ON holder_notice TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS deliveries ON holder_notice TYPE int;
DEFINE FIELD IF NOT EXISTS last_attempt_at ON holder_notice TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS last_error ON holder_notice TYPE option<string>;
DEFINE INDEX IF NOT EXISTS holder_notice_key ON holder_notice FIELDS notice_key UNIQUE;
DEFINE INDEX IF NOT EXISTS holder_notice_holder ON holder_notice FIELDS holder, delivered_at;

DEFINE TABLE IF NOT EXISTS external_action SCHEMAFULL PERMISSIONS NONE;
-- 受控外部动作记录（首个用途：取消 CI 运行）。发起、结果未知、已确认三态 + 重试幂等；
-- 带外对账写出 attribution = unknown_actor，绝不为共享 GitHub 账号伪造内部归属。
DEFINE FIELD IF NOT EXISTS action_key ON external_action TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS kind ON external_action TYPE string ASSERT $value IN ['ci-run-cancel'];
DEFINE FIELD IF NOT EXISTS provider ON external_action TYPE string ASSERT $value IN ['github'];
DEFINE FIELD IF NOT EXISTS target ON external_action TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS requested_by ON external_action TYPE option<string>;
DEFINE FIELD IF NOT EXISTS reason ON external_action TYPE string;
DEFINE FIELD IF NOT EXISTS prerequisite_task ON external_action TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS prerequisite_version ON external_action TYPE option<int>;
DEFINE FIELD IF NOT EXISTS state ON external_action TYPE string ASSERT $value IN ['requested', 'result_unknown', 'confirmed', 'refused'];
DEFINE FIELD IF NOT EXISTS attempts ON external_action TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS request_token ON external_action TYPE string;
DEFINE FIELD IF NOT EXISTS attribution ON external_action TYPE string ASSERT $value IN ['internal_employee', 'unknown_actor'];
DEFINE FIELD IF NOT EXISTS external_account ON external_action TYPE option<string>;
DEFINE FIELD IF NOT EXISTS confirmed_result ON external_action TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS attribution_evidence ON external_action TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON external_action TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON external_action TYPE datetime;
DEFINE FIELD IF NOT EXISTS reconciled_at ON external_action TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS external_action_key ON external_action FIELDS action_key UNIQUE;
DEFINE INDEX IF NOT EXISTS external_action_target ON external_action FIELDS provider, state;