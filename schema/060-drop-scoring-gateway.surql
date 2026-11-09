-- 060：删除模型评分、模型排序与本地 18779 网关的账本（0.5.0）。
-- 只删不改既有行。员工会话改为直连 VPS magpie，按「换任务即换会话」绑定任务，故新增 employee.session_task。
-- 旧 release（0.4.3）读不到这些表与字段即忽略；降级到 0.4.3 不支持（见发布说明）。

-- 模型执行台账与评分（model_execution 由 magpie 用量替代，task_cost 保留）。
REMOVE EVENT IF EXISTS model_evaluation_reopened ON TABLE task;
REMOVE TABLE IF EXISTS model_execution;
REMOVE TABLE IF EXISTS model_scorecard;
REMOVE TABLE IF EXISTS scorecard;

-- 任务上的评审字段（Jev 与 LLM 评审两条路径都已删除）。
REMOVE FIELD IF EXISTS evaluated_at ON TABLE task;
REMOVE FIELD IF EXISTS eval_attempts ON TABLE task;
REMOVE FIELD IF EXISTS eval_via ON TABLE task;
REMOVE FIELD IF EXISTS jev_release_version ON TABLE task;
REMOVE FIELD IF EXISTS jev_route_version ON TABLE task;
REMOVE FIELD IF EXISTS model_eval_full_history ON TABLE task;

-- 员工与编制上的绩效均分。
REMOVE FIELD IF EXISTS scored ON TABLE employee;
REMOVE FIELD IF EXISTS avg_score ON TABLE employee;
REMOVE FIELD IF EXISTS scored ON TABLE employee_def;
REMOVE FIELD IF EXISTS avg_score ON TABLE employee_def;

-- 评审岗位（eval）已撤销：其编制不再参与派工。员工实例随编制停用由派工正常退出。
DELETE employee_def WHERE role = 'eval';

-- 员工会话绑定的任务：会话开启时写入，直连 magpie 的 x-magpie-session 由它与员工共同决定。
DEFINE FIELD IF NOT EXISTS session_task ON TABLE employee TYPE option<string>;
