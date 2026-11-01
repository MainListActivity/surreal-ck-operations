-- SYS04 故障修复凭据消耗（本 lane 取号 047）。
--
-- 只新增一张表与 fault_repair 的一个可选字段：不改写 task / audit / outbox / fault_* 的既有字段或行。
--
-- 凭据：修复任务的完成审计（accept / owner_approve），且写于本迁移之后。database.ts 在首次升到 047 时把
-- company_meta:installation.fault_credential_since 记为起点；起点之前的完成不是凭据（旧版会对同一个 done 修复反复清零，
-- 这正是本次要封住的缺口），所以升级本身不解除任何预算。没有审计记录、只是直接改成 done 的修复任务也不是凭据。
--
-- 规则：一条凭据对同一源任务、同一 incident 最多自动解除一次恢复预算。消费记录的 id 即唯一键（task|incident|credential），
-- 与解除在同一事务中写入：重复的 done 事件、并发调用与进程重启后的重放都命中同一条记录，不会再次清零。
-- 同一 incident 之后再次耗尽或停止时，已消耗的修复不能充当绿灯：修复链推进一轮（fault_repair.rounds 追加新的修复任务），
-- 只有新一轮的真实完成凭据才能再解除一次；或由 gm 显式审计地人工解除（仍受默认 3 次 / 120 秒窗口约束；人工解除时一并
-- 消耗当时尚未消耗的凭据）。
--
-- RB01：旧版 release 读不到这张表与这个字段，因此忽略它们。回滚到旧版后，旧版会重新按 done 修复自动清零（本次修复的缺口
-- 重新出现），所以回滚只作为应急；正向修复是升级到本版本。

-- 凭据的消耗事实：一个 (task, incident, credential) 一条。via：repair（自动解除）| gm（人工解除时一并消耗）。
DEFINE TABLE IF NOT EXISTS fault_repair_consumption SCHEMAFULL PERMISSIONS NONE;
-- 唯一键：taskId|incident|credential，与记录 id 相同。
DEFINE FIELD IF NOT EXISTS key ON fault_repair_consumption TYPE string ASSERT string::len($value) > 0;
-- 被解除恢复预算的源任务。
DEFINE FIELD IF NOT EXISTS task ON fault_repair_consumption TYPE record<task>;
DEFINE FIELD IF NOT EXISTS incident ON fault_repair_consumption TYPE string ASSERT string::len($value) > 0;
-- 凭据所属的修复任务（所在轮次）。
DEFINE FIELD IF NOT EXISTS repair ON fault_repair_consumption TYPE record<task>;
-- 凭据：修复任务的完成审计记录 id（accept / owner_approve）。
DEFINE FIELD IF NOT EXISTS credential ON fault_repair_consumption TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS via ON fault_repair_consumption TYPE string ASSERT $value IN ['repair', 'gm'];
DEFINE FIELD IF NOT EXISTS consumed_at ON fault_repair_consumption TYPE datetime;
DEFINE INDEX IF NOT EXISTS fault_repair_consumption_key ON fault_repair_consumption FIELDS key UNIQUE;
DEFINE INDEX IF NOT EXISTS fault_repair_consumption_task ON fault_repair_consumption FIELDS task;

-- 修复链的全部修复任务，按轮次排序；当前轮是最后一个。完成后仍复发，链推进一轮，由新的修复任务承接。
-- 旧记录没有此字段时，以 fault_repair.task 为唯一一轮。
DEFINE FIELD IF NOT EXISTS rounds ON fault_repair TYPE option<array<record<task>>>;
