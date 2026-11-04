-- FV06 恢复唤醒可观测性（dispatcher 2a），本 lane 取号 050。
--
-- 只新增两个可选字段：dispatcher 最近一次唤醒尝试的时间与最近一次跳过的原因。它们只是可观测性记录，
-- 不改 state 机、登录/每路径限额、既有路径集合或任何既有行；签发、绑定、结算逻辑不读它们。
-- 旧版 release 读不到这两个字段即忽略（RB01）。

DEFINE FIELD IF NOT EXISTS last_wake_at ON recovery_read_grant TYPE option<datetime>;
-- no_instance / no_agent / state=<busy|down|exhausted> / failed；成功唤醒时清空（最近一次尝试即成功）。
DEFINE FIELD IF NOT EXISTS last_skip_reason ON recovery_read_grant TYPE option<string>;
