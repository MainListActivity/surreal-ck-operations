-- 053 线的笔记：一条线 = 项目 × 职能，一条经验一行。只新增表，不改既有行；旧 release 读不到新表即忽略（RB01）。
-- proposed 等任务 done 后由调度器转 active；void 或退回的执行线提议转 removed。老板手写直接 active。
DEFINE TABLE IF NOT EXISTS lane_note SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS lane ON lane_note TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS text ON lane_note TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS state ON lane_note TYPE string ASSERT $value IN ['proposed', 'active', 'removed'];
DEFINE FIELD IF NOT EXISTS phase ON lane_note TYPE option<string> ASSERT $value = NONE OR $value IN ['execute', 'review'];
DEFINE FIELD IF NOT EXISTS source_task ON lane_note TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS author ON lane_note TYPE string;
DEFINE FIELD IF NOT EXISTS pinned ON lane_note TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS created_at ON lane_note TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON lane_note TYPE datetime;
DEFINE INDEX IF NOT EXISTS lane_note_lane ON lane_note FIELDS lane, state;
DEFINE INDEX IF NOT EXISTS lane_note_task ON lane_note FIELDS source_task, state;
