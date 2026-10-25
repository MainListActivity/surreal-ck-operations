-- SYS04 故障分类、持久预算与重复阻塞收敛（本 lane 取号 037）。
--
-- 只新增表与索引：不新增、不改写 task / audit / outbox / dispatch / disposition_* 的任何既有字段，也不改任何
-- 已有行的类型。回滚到旧 release 时旧版对这四张表一无所知（读不到即忽略），因此不会误派工（RB01）。
--
-- 新增状态起点（RB01 清单，旧版行为）：
--   fault_incident.fingerprint / .state      —— 一次故障的归组身份与状态；旧版不读该表：忽略（允许）
--   fault_episode.state                      —— opened|converged|exhausted|stopped|resolved；旧版不读：忽略
--   fault_budget.attempts / .deadline / .next_allowed_at / .last_attempt_at
--                                           —— 跨租约、跨进程存活的恢复预算；旧版不读：忽略
--   fault_repair.incident / .task            —— 一个 incident 一条修复链；旧版不读：忽略
--
-- 旧版读不到这些表，所以旧版不会因为「预算耗尽」而拒绝派工：它照旧派工。真正的隔离靠「原任务进入正式依赖
-- 等待」这条既有语义（任务 waits_on / blocked），而那由本线的新代码写入 task 的既有字段，不改旧字段。

-- 一次故障的归组：同一 fingerprint 的所有上报归到一条。跨任务同因共享同一个 incident。
DEFINE TABLE IF NOT EXISTS fault_incident SCHEMAFULL PERMISSIONS NONE;
-- 规范化的 fingerprint：phase|hop|errno|httpClass|status|target|environment（不含身份别名：别名由员工自己书写，
-- 换一种写法或换成另一个账号都不该开出一条新 episode、新预算或新唤醒）。
DEFINE FIELD IF NOT EXISTS fingerprint ON fault_incident TYPE string ASSERT string::len($value) > 0;
-- incident 键：同一次故障（不含 hop，不含任务），跨任务同因共用一条修复链。
DEFINE FIELD IF NOT EXISTS incident ON fault_incident TYPE string ASSERT string::len($value) > 0;
-- opened|converged|exhausted
DEFINE FIELD IF NOT EXISTS state ON fault_incident TYPE string ASSERT $value IN ['opened', 'converged', 'exhausted'];
-- 第一个上报者的任务与别名（脱敏的 canonical alias）。
DEFINE FIELD IF NOT EXISTS first_task ON fault_incident TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS identity_alias ON fault_incident TYPE option<string>;
-- 该 incident 归到的受控目标种类（idp_authorize / product_api / workspace / ...），不记录原始地址。
DEFINE FIELD IF NOT EXISTS target ON fault_incident TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS environment ON fault_incident TYPE option<string>;
DEFINE FIELD IF NOT EXISTS first_seen_at ON fault_incident TYPE datetime;
DEFINE FIELD IF NOT EXISTS last_seen_at ON fault_incident TYPE datetime;
-- 上报次数：同一 incident 被报告了多少次（收敛判据之一）。
DEFINE FIELD IF NOT EXISTS reports ON fault_incident TYPE int DEFAULT 0;
DEFINE INDEX IF NOT EXISTS fault_incident_fingerprint ON fault_incident FIELDS fingerprint UNIQUE;
DEFINE INDEX IF NOT EXISTS fault_incident_incident ON fault_incident FIELDS incident;

-- 一个处理中的 episode：同一 fingerprint 在同一任务上的一次有效处理。重复上报收敛到这里，只发一次管理通知。
DEFINE TABLE IF NOT EXISTS fault_episode SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS episode ON fault_episode TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS fingerprint ON fault_episode TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS incident ON fault_episode TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON fault_episode TYPE record<task>;
DEFINE FIELD IF NOT EXISTS phase ON fault_episode TYPE string ASSERT string::len($value) > 0;
-- opened|converged|exhausted|stopped|resolved
--   opened    —— 已上报、经理尚未被告知；
--   converged —— 经理已被告知，之后的同证据上报不再唤醒；
--   exhausted —— 恢复预算耗尽，已生成一次结构化诊断并建唯一修复链；
--   stopped   —— 该原因不可恢复（403 / 错密码 / 权限撤销 / 非法输入），恢复立即停止；
--   resolved  —— 修复完成，允许开一个有审计的新阶段。
DEFINE FIELD IF NOT EXISTS state ON fault_episode TYPE string
  ASSERT $value IN ['opened', 'converged', 'exhausted', 'stopped', 'resolved'];
-- 证据版本：只有新证据（evidence_revision 变大）、配置版本变更或修复完成才允许开一个新阶段。
DEFINE FIELD IF NOT EXISTS evidence_revision ON fault_episode TYPE int DEFAULT 0;
-- 归组到的管理通知：同一 episode 只通知一次。
DEFINE FIELD IF NOT EXISTS notified ON fault_episode TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS opened_at ON fault_episode TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON fault_episode TYPE datetime;
DEFINE FIELD IF NOT EXISTS resolved_at ON fault_episode TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS fault_episode_episode ON fault_episode FIELDS episode UNIQUE;
DEFINE INDEX IF NOT EXISTS fault_episode_fingerprint ON fault_episode FIELDS fingerprint;
DEFINE INDEX IF NOT EXISTS fault_episode_task ON fault_episode FIELDS task;

-- 跨租约、跨进程存活的恢复预算。键绑定任务/受控目标/阶段：换持有人、换错误文案、换账号写法都不清零。
DEFINE TABLE IF NOT EXISTS fault_budget SCHEMAFULL PERMISSIONS NONE;
-- 预算键：taskId|controlledTarget|phase
DEFINE FIELD IF NOT EXISTS key ON fault_budget TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON fault_budget TYPE record<task>;
-- 受控目标种类（不记录原始地址）。
DEFINE FIELD IF NOT EXISTS target ON fault_budget TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS phase ON fault_budget TYPE string ASSERT string::len($value) > 0;
-- 已花费的次数：当前这一轮恢复里的每一次尝试（失败的那次与恢复的那次）各记一次；恢复成功后归零。
DEFINE FIELD IF NOT EXISTS attempts ON fault_budget TYPE int DEFAULT 0;
-- 累计尝试次数：只增不减，审计用（成功的尝试也计入）。
DEFINE FIELD IF NOT EXISTS total_attempts ON fault_budget TYPE int DEFAULT 0;
-- 整段恢复的总 deadline（毫秒）。
DEFINE FIELD IF NOT EXISTS deadline ON fault_budget TYPE int;
-- 最早可再试的时刻（毫秒）：上次尝试 + 最小间隔 + 退避（含 jitter）。
DEFINE FIELD IF NOT EXISTS next_allowed_at ON fault_budget TYPE int;
-- 上次尝试的时刻（毫秒）。
DEFINE FIELD IF NOT EXISTS last_attempt_at ON fault_budget TYPE option<int>;
-- 该次尝试的租约持有人（换人不清零预算）。
DEFINE FIELD IF NOT EXISTS last_holder ON fault_budget TYPE option<string>;
-- 该故障对象已经进入恢复：此后每一次尝试都要先占预算。
DEFINE FIELD IF NOT EXISTS failed ON fault_budget TYPE bool DEFAULT false;
-- 不可恢复的原因把恢复立即停掉（403 / 错密码 / 权限撤销 / 非法输入 / 未知错误）。
DEFINE FIELD IF NOT EXISTS stopped ON fault_budget TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS stop_reason ON fault_budget TYPE option<string>;
DEFINE FIELD IF NOT EXISTS stop_fingerprint ON fault_budget TYPE option<string>;
-- 停掉恢复时生成的那一次结构化诊断（脱敏；不含错误原文）。
DEFINE FIELD IF NOT EXISTS stop_diagnostic ON fault_budget TYPE option<object> FLEXIBLE;
-- 最后一次记录的故障身份与机器事实：审计可复算，诊断可重建。
DEFINE FIELD IF NOT EXISTS last_fingerprint ON fault_budget TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_incident ON fault_budget TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_errno ON fault_budget TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_hop ON fault_budget TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_http_class ON fault_budget TYPE option<string>;
DEFINE FIELD IF NOT EXISTS last_status ON fault_budget TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_elapsed_ms ON fault_budget TYPE option<int>;
-- 预算上限的快照：审计可复算（不依赖后来改过的配置）。
DEFINE FIELD IF NOT EXISTS max_attempts ON fault_budget TYPE int;
DEFINE FIELD IF NOT EXISTS total_deadline_ms ON fault_budget TYPE int;
DEFINE FIELD IF NOT EXISTS min_interval_ms ON fault_budget TYPE int;
DEFINE FIELD IF NOT EXISTS backoff_ms ON fault_budget TYPE int;
DEFINE FIELD IF NOT EXISTS jitter ON fault_budget TYPE float;
DEFINE FIELD IF NOT EXISTS created_at ON fault_budget TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON fault_budget TYPE datetime;
DEFINE INDEX IF NOT EXISTS fault_budget_key ON fault_budget FIELDS key UNIQUE;
DEFINE INDEX IF NOT EXISTS fault_budget_task ON fault_budget FIELDS task;

-- 一个 incident 一条修复链：预算耗尽时创建/关联唯一修复任务，原任务进入正式依赖等待。
DEFINE TABLE IF NOT EXISTS fault_repair SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS incident ON fault_repair TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS fingerprint ON fault_repair TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS task ON fault_repair TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS source_task ON fault_repair TYPE option<record<task>>;
-- open|done|void
DEFINE FIELD IF NOT EXISTS state ON fault_repair TYPE string ASSERT $value IN ['open', 'done', 'void'];
-- 预算耗尽时生成一次的结构化诊断（脱敏；不含错误原文）。
DEFINE FIELD IF NOT EXISTS diagnostic ON fault_repair TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON fault_repair TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON fault_repair TYPE datetime;
DEFINE INDEX IF NOT EXISTS fault_repair_incident ON fault_repair FIELDS incident UNIQUE;
