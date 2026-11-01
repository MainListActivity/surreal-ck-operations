-- 验收要求修订的持有人通知（编号 047）。
-- 只放宽 holder_notice.kind 的白名单，新增 'acceptance_amend' 一种通知；不改写任何既有字段、索引或行，
-- 也不新增任务字段（修订正文追加在既有 task.context，旧版 release 照旧能读到）。旧版 release 不产生这类
-- 通知，读到未知 kind 时按既有通用文本投递一次，不会回滚也不会丢状态（RB01）。
DEFINE FIELD OVERWRITE kind ON holder_notice TYPE string ASSERT $value IN ['disposition_decided', 'dependency_wait', 'resumed', 'claim_revoked', 'claim_taken_over', 'external_action', 'external_action_unknown', 'acceptance_amend'];
