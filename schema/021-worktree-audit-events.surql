-- WT02's stale-row drop writes `drop_stale_row` to worktree_audit. The 014 whitelist
-- predates that event, so the audit INSERT failed the ASSERT and the repo-level catch
-- aborted the whole scan after the first dropped row (2026-10-21 02:37Z incident).
-- Keep this list in sync with the `event:` literals in src/dispatcher/worktree-registry.ts;
-- tests/audit-event-whitelist.test.ts enforces it.
DEFINE FIELD OVERWRITE event ON worktree_audit TYPE string
  ASSERT $value IN ['release', 'delete', 'skip', 'fail', 'branch_retain', 'orphan_scan', 'dry_run', 'scene_release', 'drop_stale_row'];
