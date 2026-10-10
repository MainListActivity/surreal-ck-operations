-- Event-driven three-layer release: the reclaim transaction point also tears down the
-- Paseo side (workspace archive + project delete) and audits it as scene_release.
DEFINE FIELD OVERWRITE event ON worktree_audit TYPE string
  ASSERT $value IN ['release', 'delete', 'skip', 'fail', 'branch_retain', 'orphan_scan', 'dry_run', 'scene_release'];
