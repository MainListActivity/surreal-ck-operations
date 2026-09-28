-- v4: 任务权重与绩效评分。
-- employee_def.weight 控制派工选中概率；scorecard 记录每轮任务各员工的绩效；
-- task.evaluated_at 标记已评审，防止重复派评审。

-- employee_def.role 加入 'eval'（评审岗位：只读任务历史 + 写 scorecard，不领普通任务）。
DEFINE FIELD OVERWRITE role ON employee_def TYPE string
  ASSERT $value IN ['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs', 'eval'];
DEFINE FIELD IF NOT EXISTS weight ON employee_def TYPE int DEFAULT 10 ASSERT $value >= 0 AND $value <= 1000;
DEFINE FIELD IF NOT EXISTS scored ON employee_def TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS avg_score ON employee_def TYPE option<float>;

DEFINE FIELD IF NOT EXISTS scored ON employee TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS avg_score ON employee TYPE option<float>;

DEFINE FIELD IF NOT EXISTS evaluated_at ON task TYPE option<datetime>;

DEFINE TABLE IF NOT EXISTS scorecard SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS task ON scorecard TYPE record<task>;
DEFINE FIELD IF NOT EXISTS employee ON scorecard TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS role ON scorecard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS def ON scorecard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS provider ON scorecard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS model ON scorecard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS quality ON scorecard TYPE float ASSERT $value >= 1 AND $value <= 5;
DEFINE FIELD IF NOT EXISTS evidence ON scorecard TYPE float ASSERT $value >= 1 AND $value <= 5;
DEFINE FIELD IF NOT EXISTS discipline ON scorecard TYPE float ASSERT $value >= 1 AND $value <= 5;
DEFINE FIELD IF NOT EXISTS timeliness ON scorecard TYPE float ASSERT $value >= 1 AND $value <= 5;
DEFINE FIELD IF NOT EXISTS overall ON scorecard TYPE float ASSERT $value >= 1 AND $value <= 5;
DEFINE FIELD IF NOT EXISTS notes ON scorecard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS metrics ON scorecard TYPE option<object>;
DEFINE FIELD IF NOT EXISTS eval_by ON scorecard TYPE string;
DEFINE FIELD IF NOT EXISTS at ON scorecard TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS scorecard_task ON scorecard FIELDS task;
DEFINE INDEX IF NOT EXISTS scorecard_employee ON scorecard FIELDS employee;
