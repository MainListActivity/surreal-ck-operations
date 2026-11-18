-- 老板改稿的脱敏差分。只新增空表，不改历史任务；旧版本忽略此表。
-- 由 migrator/bootstrap 建表，运行端只读写数据，不隐式依赖建表权限。
DEFINE TABLE IF NOT EXISTS owner_style_memory SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS owner_style_memory_at ON owner_style_memory FIELDS at;
