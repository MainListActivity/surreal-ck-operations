-- 071 完工分析的失败诊断：哪一步失败（读任务、调模型、校验、写库）、错误类别与耗时。只记形态，不记模型正文与员工输出。
-- 0.13.13 上线后的失败没有留下原因：这里把还没有结论的行清回未尝试，让新版本带着诊断重试。
DEFINE FIELD IF NOT EXISTS error ON turn_analysis TYPE option<string>;
DEFINE FIELD IF NOT EXISTS elapsed_ms ON turn_analysis TYPE option<int>;
UPDATE turn_analysis SET attempts = 0, failed_at = NONE WHERE summary = NONE;
