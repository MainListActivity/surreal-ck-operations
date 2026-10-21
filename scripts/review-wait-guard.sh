#!/bin/sh
# RW06 C1: the switch guard for the persistent review-wait state.
#
# A target release is compatible only when its own code carries the review-wait contract (src/review-wait-capability.ts with the
# protocol marker, the phase-restoring unlock in src/core.ts, and the task-view facts in src/contracts.ts). The caller binds the
# release content to its commit (release-content.sh) before asking, so the probe reads reviewed code.
#
# The rule is fail-closed and has NO zero-row exception: an incompatible or unreadable target is refused even when no task is
# waiting today. A zero-row check would race a defer that lands after the check; the guard therefore never answers "safe because
# nothing waits". The affected waiting items are reported only when an authorised read seam is available to the caller; this
# script has none, so it says `unknown` instead of implying "none".
#
# Sourced by scripts/company-service.sh (install/rollback) and scripts/deploy-mcp-remote.sh (remote switch). No credentials are
# read here, and nothing in this file performs a side effect.
REVIEW_WAIT_PROTOCOL_EXPECTED='review-wait/1'

# 0 when the tree at <root> carries the contract (files read, never executed).
review_wait_probe_root() {
  root=$1
  [ -d "$root" ] || return 1
  cap="$root/src/review-wait-capability.ts"
  core="$root/src/core.ts"
  contracts="$root/src/contracts.ts"
  [ -f "$cap" ] && [ -f "$core" ] && [ -f "$contracts" ] || return 1
  # Declarations, not comment text: a comment-only tree cannot pass (review B-non-blocking).
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+REVIEW_WAIT_PROTOCOL[[:space:]]*=' "$cap" 2>/dev/null || return 1
  grep -q "$REVIEW_WAIT_PROTOCOL_EXPECTED" "$cap" 2>/dev/null || return 1
  # The unlock restores the blocked phase as a real LET statement; an old core hard-writes ready and fails this marker.
  grep -qF "LET \$restore_phase = IF \$source_phase = 'review' THEN 'review' ELSE 'ready' END" "$core" 2>/dev/null || return 1
  grep -Eq 'resume_state[[:space:]]*=' "$core" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*resumeState\?:' "$contracts" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*resumeRole\?:' "$contracts" 2>/dev/null || return 1
  return 0
}

# 0 when <release> may be switched to. Scope `full` (local install/rollback) also checks the plugin surface, which runs the
# same core: a shipped plugin must carry a generated vendor tree with the contract, and a missing vendor is unknown (refused),
# never assumed compatible. Scope `core` is the remote MCP deploy, whose payload is the service core only.
review_wait_target_supported() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || return 1
  review_wait_probe_root "$release" || return 1
  [ "$scope" = core ] && return 0
  if [ -d "$release/plugin" ]; then
    [ -d "$release/plugin/server/vendor" ] || return 1
    review_wait_probe_root "$release/plugin/server/vendor" || return 1
  fi
  return 0
}

# Why a target was refused, in the caller's words (target, reason, and what could not be read).
review_wait_refusal_reason() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || { echo "目标目录不存在：$release"; return 0; }
  if [ ! -f "$release/src/review-wait-capability.ts" ]; then
    echo "目标代码没有复核等待能力契约（src/review-wait-capability.ts 缺失）：该版本不认识持久 review-wait 状态，完成前置后会把它按 ready 解锁并误派"
    return 0
  fi
  if ! review_wait_probe_root "$release"; then
    echo "目标代码的复核等待契约不完整或不可读（core/contracts 标记不满足）：无法证明它会在解锁时恢复 review 阶段"
    return 0
  fi
  [ "$scope" = core ] && { echo "目标代码不支持复核等待契约"; return 0; }
  if [ -d "$release/plugin" ] && [ ! -d "$release/plugin/server/vendor" ]; then
    echo "目标发布缺少插件 vendor 树：无法证明插件面与核心同样支持复核等待（未知按不兼容处理）"
    return 0
  fi
  if [ -d "$release/plugin" ] && ! review_wait_probe_root "$release/plugin/server/vendor"; then
    echo "目标的插件 vendor 代码不支持复核等待契约：双面不同源，切换会让插件面按旧语义解锁"
    return 0
  fi
  echo "目标代码不支持复核等待契约"
}

# The refusal line shared by every switch entry point, so the operator sees the same facts everywhere.
review_wait_refuse() {
  release=$1
  scope=${2:-full}
  reason=$(review_wait_refusal_reason "$release" "$scope")
  echo "refused: $reason" >&2
  echo "refused: target=$release" >&2
  echo "refused: waiting items=unknown (no authorised read seam in the switch script; this is not a claim that none wait)" >&2
  echo "refused: only a target that proves the review-wait contract may be switched to; otherwise keep the current healthy release, hold, or land an audited forward fix (see docs/company-service-operations.md)" >&2
}
