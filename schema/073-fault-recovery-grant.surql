-- 073 事件恢复授权（fault_recovery_grant）：老板对一条已耗尽的恢复预算授权一次新窗口，窗口从首次真实尝试开始计时。
--
-- 只新增一张表：不改写 fault_budget / fault_episode / fault_repair 的任何既有字段或行，旧版读不到即忽略（RB01）。
-- 授权本身不改预算：它不清计数、不延长截止时间。窗口只在员工的第一次真实尝试消费授权时才开出，
-- 由 reserve 在同一事务中改写预算（total_attempts 保留累计审计）。
--
-- 规则：一个预算、一个事件只授权一次（记录 id 即唯一键）。重复的授权请求、并发的消费与进程重启后的重放都命中同一条记录，
-- 不会开第二个窗口；窗口耗尽后同一事件不能再次授权，只能走修复链。

DEFINE TABLE IF NOT EXISTS fault_recovery_grant SCHEMAFULL PERMISSIONS NONE;
-- 唯一键：预算键#事件，与记录 id 相同。
DEFINE FIELD IF NOT EXISTS key ON fault_recovery_grant TYPE string ASSERT string::len($value) > 0;
-- 预算键 taskId|target|phase：授权只属于这一个预算，换任务、别名、持有人或租约都不改变它。
DEFINE FIELD IF NOT EXISTS budget ON fault_recovery_grant TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON fault_recovery_grant TYPE record<task>;
DEFINE FIELD IF NOT EXISTS target ON fault_recovery_grant TYPE string;
DEFINE FIELD IF NOT EXISTS phase ON fault_recovery_grant TYPE string;
-- 授权绑定的事件（授权时预算登记的最近事件）；事件变了，旧授权不能再被消费。
DEFINE FIELD IF NOT EXISTS incident ON fault_recovery_grant TYPE string ASSERT string::len($value) > 0;
-- pending 待消费；consumed 已由首次真实尝试消费（窗口已开）；void 作废（恢复已成功，或修复链、手工重置已解除，未消费的授权不再适用）。
-- 预留的尝试未执行而退款时，consumed 退回 pending。
DEFINE FIELD IF NOT EXISTS state ON fault_recovery_grant TYPE string ASSERT $value IN ['pending', 'consumed', 'void'];
DEFINE FIELD IF NOT EXISTS granted_by ON fault_recovery_grant TYPE string;
-- 老板填写的依据。
DEFINE FIELD IF NOT EXISTS evidence ON fault_recovery_grant TYPE string;
-- 幂等键与请求摘要：同一键同一内容重放返回原回执，同一键不同内容拒绝。
DEFINE FIELD IF NOT EXISTS idempotency_key ON fault_recovery_grant TYPE string;
DEFINE FIELD IF NOT EXISTS payload_digest ON fault_recovery_grant TYPE string;
DEFINE FIELD IF NOT EXISTS granted_at ON fault_recovery_grant TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS consumed_at ON fault_recovery_grant TYPE option<datetime>;
-- 消费时预算的累计尝试次数（含这次）：审计可复算。
DEFINE FIELD IF NOT EXISTS consumed_total_attempts ON fault_recovery_grant TYPE option<int>;
-- 窗口截止（毫秒）：消费时刻加上总时长。退款退回 pending 时清空。
DEFINE FIELD IF NOT EXISTS window_deadline ON fault_recovery_grant TYPE option<int>;
DEFINE FIELD IF NOT EXISTS updated_at ON fault_recovery_grant TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS fault_recovery_grant_key ON fault_recovery_grant FIELDS key UNIQUE;
DEFINE INDEX IF NOT EXISTS fault_recovery_grant_task ON fault_recovery_grant FIELDS task;
