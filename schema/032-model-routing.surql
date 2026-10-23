-- Additive, internal-only execution evidence. No prompts, credentials or response text.
DEFINE TABLE IF NOT EXISTS model_execution SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS model_execution_task ON model_execution FIELDS task, employee;
DEFINE TABLE IF NOT EXISTS model_scorecard SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS model_scorecard_model ON model_scorecard FIELDS model, domain;
DEFINE FIELD IF NOT EXISTS model_tier ON task TYPE option<string> ASSERT $value = NONE OR $value IN ['high','medium','low'];
