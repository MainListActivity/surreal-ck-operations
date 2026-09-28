-- v5: Jev（TypeSafe System One 决策模型）直评通道。
-- scorecard 记录评审来源（jev/llm）、逐题置信度与概率分布；
-- task.eval_attempts / eval_via 记录评审引擎的尝试与最终路径。

DEFINE FIELD IF NOT EXISTS judge ON scorecard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS confidence ON scorecard TYPE option<float>;
DEFINE FIELD IF NOT EXISTS probabilities ON scorecard TYPE option<object>;
DEFINE FIELD IF NOT EXISTS flagged ON scorecard TYPE option<bool>;

DEFINE FIELD IF NOT EXISTS eval_attempts ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS eval_via ON task TYPE option<string>;
