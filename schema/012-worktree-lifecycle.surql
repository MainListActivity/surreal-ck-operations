-- Additive WT02 migration. No existing data rewritten or removed.
-- Enables ownership-based reclaim, orphan grace, and durable worktree audit.
DEFINE FIELD IF NOT EXISTS last_released_at ON worktree TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS cleanup_todo ON worktree TYPE option<string>;

DEFINE TABLE IF NOT EXISTS worktree_audit SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS scan_id ON worktree_audit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS repo ON worktree_audit TYPE string;
DEFINE FIELD IF NOT EXISTS path ON worktree_audit TYPE string;
DEFINE FIELD IF NOT EXISTS tree ON worktree_audit TYPE option<record<worktree>>;
DEFINE FIELD IF NOT EXISTS event ON worktree_audit TYPE string ASSERT $value IN ['release', 'delete', 'skip', 'fail', 'branch_retain', 'orphan_scan', 'dry_run'];
DEFINE FIELD IF NOT EXISTS trigger ON worktree_audit TYPE string;
DEFINE FIELD IF NOT EXISTS ownership ON worktree_audit TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS decision ON worktree_audit TYPE string;
DEFINE FIELD IF NOT EXISTS result ON worktree_audit TYPE string ASSERT $value IN ['success', 'skipped', 'failed'];
DEFINE FIELD IF NOT EXISTS reason ON worktree_audit TYPE string;
DEFINE FIELD IF NOT EXISTS task ON worktree_audit TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS at ON worktree_audit TYPE datetime;
DEFINE INDEX IF NOT EXISTS worktree_audit_at ON worktree_audit FIELDS at;
DEFINE INDEX IF NOT EXISTS worktree_audit_repo ON worktree_audit FIELDS repo;
DEFINE INDEX IF NOT EXISTS worktree_audit_scan ON worktree_audit FIELDS scan_id;
