-- Additive only: legacy live agents keep their current workspace and lease.
DEFINE FIELD IF NOT EXISTS workspace_scope ON employee TYPE option<string>;
DEFINE INDEX IF NOT EXISTS employee_workspace_scope ON employee FIELDS workspace_repo, workspace_scope;
