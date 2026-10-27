#!/bin/sh
# Read-only capability guard. The caller binds release content to its main commit first.
goal_workspace_probe_root() {
  root=$1
  [ -f "$root/src/goal-workspace-capability.ts" ] || return 1
  grep -Eq "^export const GOAL_WORKSPACE_CONTRACT = 'sck-goal-workspace/v1'" "$root/src/goal-workspace-capability.ts" || return 1
  grep -qF 'workspace goal denied' "$root/src/core.ts" 2>/dev/null || return 1
  grep -qF 'workspace_scope' "$root/src/workforce.ts" 2>/dev/null || return 1
}
goal_workspace_target_supported() {
  release=$1
  scope=${2:-full}
  goal_workspace_probe_root "$release" || return 1
  [ "$scope" = core ] && return 0
  if [ -d "$release/plugin" ]; then
    goal_workspace_probe_root "$release/plugin/server/vendor" || return 1
  fi
}
goal_workspace_refuse() {
  echo "refused: target=$1 lacks the goal conversation contract on one or both surfaces" >&2
  echo 'refused: scoped conversations=unknown; preserve the healthy release and use an audited forward fix' >&2
}
