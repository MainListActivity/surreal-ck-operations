-- 052 task-routes（阶段一）：删除退役编排模块专属的表。
-- 路由表与新任务字段在阶段二补齐。
REMOVE TABLE IF EXISTS goal;                    -- goal-store / owner createGoal·triage·phaseSplit
REMOVE TABLE IF EXISTS goal_outcome;            -- goal-governance 结果登记
REMOVE TABLE IF EXISTS goal_evidence;           -- goal-governance 证据登记
REMOVE TABLE IF EXISTS task_wait;               -- waits.ts / wait-store.ts 结构化等待
REMOVE TABLE IF EXISTS wait_event;              -- wait-store.ts 等待事件
REMOVE TABLE IF EXISTS disposition_claim;       -- disposition.ts 处置认领
REMOVE TABLE IF EXISTS disposition_action;      -- disposition.ts 处置动作
REMOVE TABLE IF EXISTS holder_notice;           -- disposition.ts 持有人通知
REMOVE TABLE IF EXISTS external_action;         -- disposition.ts 外部动作（CI 触发等）
REMOVE TABLE IF EXISTS policy;                  -- policy-store.ts 有效契约
REMOVE TABLE IF EXISTS qa_observation_scope;    -- qa-observation 只读授权
REMOVE TABLE IF EXISTS qa_observation_session;  -- qa-observation 会话兑换
REMOVE TABLE IF EXISTS qa_review_watch;         -- review-events 订阅登记
REMOVE TABLE IF EXISTS qa_review_signal;        -- review-events 评审协同信号
REMOVE TABLE IF EXISTS qa_review_wake;          -- review-events 唤醒记录
REMOVE TABLE IF EXISTS recovery_read_grant;     -- recovery-read 恢复读取授权
REMOVE TABLE IF EXISTS recovery_read_chain;     -- recovery-read 恢复链
REMOVE TABLE IF EXISTS recovery_read_call;      -- recovery-read 调用账本
REMOVE TABLE IF EXISTS principal;               -- identity-principal 跨员工身份链
