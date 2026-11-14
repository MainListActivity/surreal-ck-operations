-- 070 完工分析：员工每次交出结果（提交、退回、老板驳回、受阻）后，由老板端定时任务让模型读任务卡与这次结果，
-- 写下完成情况、还缺什么、建议下一条消息的开头一段和把握。本版只记录并在任务详情展示，不改任何派工消息，也不决定任务流转。
-- 一条审计行一条分析；source_hash 是被分析文本的哈希；失败记下时间与次数，三次后不再重试。
DEFINE TABLE IF NOT EXISTS turn_analysis SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS source ON turn_analysis TYPE record<audit>;
DEFINE FIELD IF NOT EXISTS task ON turn_analysis TYPE record<task>;
DEFINE FIELD IF NOT EXISTS action ON turn_analysis TYPE string;
DEFINE FIELD IF NOT EXISTS source_hash ON turn_analysis TYPE string;
DEFINE FIELD IF NOT EXISTS status ON turn_analysis TYPE option<string> ASSERT $value = NONE OR $value IN ['completed', 'partial', 'blocked', 'rejected'];
DEFINE FIELD IF NOT EXISTS summary ON turn_analysis TYPE option<string>;
DEFINE FIELD IF NOT EXISTS needs ON turn_analysis TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS next ON turn_analysis TYPE option<string>;
DEFINE FIELD IF NOT EXISTS confidence ON turn_analysis TYPE option<string> ASSERT $value = NONE OR $value IN ['high', 'low'];
DEFINE FIELD IF NOT EXISTS low_reason ON turn_analysis TYPE option<string>;
DEFINE FIELD IF NOT EXISTS attempts ON turn_analysis TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS failed_at ON turn_analysis TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS at ON turn_analysis TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS turn_analysis_source ON turn_analysis FIELDS source UNIQUE;
DEFINE INDEX IF NOT EXISTS turn_analysis_task ON turn_analysis FIELDS task;
