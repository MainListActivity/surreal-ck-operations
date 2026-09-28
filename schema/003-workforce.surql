-- v3: workforce (employee definitions and runtime instances), provider health,
-- goals, owner commands/notices and dispatch bookkeeping.
-- Owner may write owner_command / employee_def rows directly; the dispatcher applies them.
DEFINE TABLE IF NOT EXISTS employee_def SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS role ON employee_def TYPE string
  ASSERT $value IN ['gm', 'product', 'engineering', 'ai-content', 'qa', 'cs'];
DEFINE FIELD IF NOT EXISTS provider ON employee_def TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS model ON employee_def TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS thinking ON employee_def TYPE option<string>;
DEFINE FIELD IF NOT EXISTS enabled ON employee_def TYPE bool DEFAULT true;
DEFINE FIELD IF NOT EXISTS max_instances ON employee_def TYPE int DEFAULT 1 ASSERT $value >= 0 AND $value <= 8;
DEFINE FIELD IF NOT EXISTS priority ON employee_def TYPE int DEFAULT 100;
DEFINE FIELD IF NOT EXISTS created_at ON employee_def TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS provider_health SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS goal SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS dispatch SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS owner_notice SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE IF NOT EXISTS direction SCHEMALESS PERMISSIONS NONE;

DEFINE TABLE IF NOT EXISTS owner_command SCHEMALESS PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS kind ON owner_command TYPE string
  ASSERT $value IN ['goal', 'approve', 'reject', 'reply', 'direction', 'pause', 'resume'];
DEFINE FIELD IF NOT EXISTS text ON owner_command TYPE option<string>;
DEFINE FIELD IF NOT EXISTS task ON owner_command TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source ON owner_command TYPE string DEFAULT 'db';
DEFINE FIELD IF NOT EXISTS status ON owner_command TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'applying', 'applied', 'failed'];
DEFINE FIELD IF NOT EXISTS created_at ON owner_command TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS owner_command_status ON owner_command FIELDS status;

DEFINE INDEX IF NOT EXISTS audit_task ON audit FIELDS task;
DEFINE INDEX IF NOT EXISTS task_state ON task FIELDS state;
DEFINE INDEX IF NOT EXISTS employee_agent ON employee FIELDS paseo_agent_id;
