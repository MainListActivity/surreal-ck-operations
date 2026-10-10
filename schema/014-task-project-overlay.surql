-- Task-level project overlay (task_project_update / create_task project param).
-- Additive only: no existing data rewritten, no deletion policy. NONE keeps goal.project routing.
DEFINE FIELD IF NOT EXISTS project ON task TYPE option<record<project>>;
