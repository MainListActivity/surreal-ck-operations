-- v17: explicit code-repo binding (bind_task_code_repo). task.code_repo_path lets gm point a
-- blocked execute-phase task at the ops repo or a registered project repo_path for worktree
-- allocation and dispatch repoHome/cwd only; business project routing (taskProject →
-- claim.json.project, opsScope, broker quotas) is untouched. Additive only: optional field,
-- no row rewritten.

DEFINE FIELD IF NOT EXISTS code_repo_path ON task TYPE option<string>;
