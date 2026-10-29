-- Per-task cost (tokens, USD, model time, elapsed) rolled up from Magpie request rows, kept past model_execution
-- retention. New table only; an older release ignores it (RB01).
DEFINE TABLE IF NOT EXISTS task_cost SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS task ON task_cost TYPE record<task>;
DEFINE FIELD IF NOT EXISTS at ON task_cost TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS task_cost_task ON task_cost FIELDS task;
