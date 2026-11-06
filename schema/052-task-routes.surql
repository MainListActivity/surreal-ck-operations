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

-- 052 阶段二：路由表、任务新字段与消息步骤扩展。历史任务的 goal/dependencies 字段不再写入；tag 承担分组。

DEFINE TABLE IF NOT EXISTS route SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS label ON route TYPE string;
DEFINE FIELD IF NOT EXISTS executor_role ON route TYPE string;
DEFINE FIELD IF NOT EXISTS reviewer_role ON route TYPE string;
DEFINE FIELD IF NOT EXISTS code ON route TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS execute_body ON route TYPE option<string>;
DEFINE FIELD IF NOT EXISTS review_body ON route TYPE option<string>;
DEFINE FIELD IF NOT EXISTS next ON route TYPE option<string>;
DEFINE FIELD IF NOT EXISTS hold ON route TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS enabled ON route TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS updated_at ON route TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_by ON route TYPE string;

-- task 新字段（schemaless 历史行兼容）：type 驱动路由；parent 指向链上前一个任务；
-- proposed_in 记录提议它的 submit 审计 id；tag 为可选分组（替代 goal）。
DEFINE FIELD IF NOT EXISTS type ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS parent ON task TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS proposed_in ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tag ON task TYPE option<string>;

-- outbound_message.step 扩展：notice 覆盖重启续作、持有人通知等系统直发消息。
DEFINE FIELD OVERWRITE step ON outbound_message TYPE string ASSERT $value IN ['execute','review','rework','nudge','eval','notice'];

-- 路由种子：INSERT IGNORE 遇到既有 id 直接跳过，从不覆盖老板改过的行。
INSERT IGNORE INTO route [
  { id: route:software,  label: '软件需求',   executor_role: 'engineering',      reviewer_role: 'qa',      code: true,  execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:product,   label: '运营事务',   executor_role: 'product',          reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:content,   label: 'AI 内容',    executor_role: 'ai-content',       reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:concept,   label: '原型/概念设计', executor_role: 'concept-design', reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:asset,     label: '量产制作',   executor_role: 'asset-production', reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:script,    label: '剧本',       executor_role: 'screenwriter',     reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:story,     label: '长篇故事',   executor_role: 'story-author',     reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:film,      label: '摄影摄像',   executor_role: 'cinematography',   reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:cs,        label: '客户成功',   executor_role: 'cs',               reviewer_role: 'qa',      code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:qa,        label: '测试',       executor_role: 'qa',               reviewer_role: 'product', code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
  { id: route:gate,      label: '老板关口',   executor_role: 'product',          reviewer_role: 'owner',   code: false, execute_body: NONE, review_body: NONE, next: NONE, hold: false, enabled: true, updated_at: time::now(), updated_by: 'system' },
];

-- model_evaluation_reopened 事件在 DELETE 时 $after 为 NONE，原定义（033，不改历史文件）会对任意 done 任务的删除抛
-- UPDATE NONE。这里用 OVERWRITE 收紧触发条件到 UPDATE 事件本身，删除任务不再触发它。
DEFINE EVENT OVERWRITE model_evaluation_reopened ON TABLE task WHEN $event = 'UPDATE' AND $before.state = 'done' AND $after.state != 'done' THEN {
  UPDATE $after.id SET evaluated_at = NONE;
  DELETE model_scorecard WHERE task = $after.id;
};
