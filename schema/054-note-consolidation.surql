-- 054 笔记整理：定期合并近似笔记、清理超出软目标的旧笔记，每次运行记一条可撤销的整理记录。
-- 只新增 note_consolidation 表与 lane_note 的两个可选字段，不改既有行；旧 release 读不到新表、不认识新字段即忽略（RB01）。
DEFINE TABLE IF NOT EXISTS note_consolidation SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS at ON note_consolidation TYPE datetime;
DEFINE INDEX IF NOT EXISTS note_consolidation_at ON note_consolidation FIELDS at;
DEFINE FIELD IF NOT EXISTS merged_into ON lane_note TYPE option<record<lane_note>>;
DEFINE FIELD IF NOT EXISTS removed_reason ON lane_note TYPE option<string> ASSERT $value = NONE OR $value IN ['merged', 'aged_out'];
