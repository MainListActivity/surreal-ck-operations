#!/bin/sh
# FV06 P0/P1: the switch guard for the bounded standby relay.
#
# A target release is compatible only when its own code carries the standby protocol on BOTH faces
# that run it: the core (src/: the capability marker, the standby resume write in core.ts, the view
# fields in contracts.ts) and the plugin vendor (plugin/server/vendor/src/: the same contract, since
# the plugin runs the same core). The supervision branch in dispatcher.ts and the relay-capability
# module are probed too, so a tree that carries the marker but lost the behavior cannot pass.
#
# The rule is fail-closed with no zero-row exception: an incompatible or unreadable target is refused
# even when no task is standing by today — a check that read "nothing stands by" as safe would race a
# resume(standbyEmployee) landing right after it and hand a bounded standby lease to a core that
# neither wakes the holder nor returns the timeout to the gm gate.
#
# Sourced by scripts/company-service.sh (install/rollback) and scripts/deploy-mcp-remote.sh (remote
# switch). Read-only: files are read, never executed; no credentials are touched.
STANDBY_RELAY_PROTOCOL_EXPECTED='standby-relay/1'

# 0 when the tree at <root> carries the contract (files read, never executed).
standby_relay_probe_root() {
  root=$1
  [ -d "$root" ] || return 1
  cap="$root/src/standby-relay-capability.ts"
  core="$root/src/core.ts"
  contracts="$root/src/contracts.ts"
  dispatcher="$root/src/dispatcher/dispatcher.ts"
  workforce="$root/src/workforce.ts"
  [ -f "$cap" ] && [ -f "$core" ] && [ -f "$contracts" ] && [ -f "$dispatcher" ] && [ -f "$workforce" ] || return 1
  # Declarations, not comment text: a comment-only tree cannot pass.
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+STANDBY_RELAY_PROTOCOL[[:space:]]*=' "$cap" 2>/dev/null || return 1
  grep -q "$STANDBY_RELAY_PROTOCOL_EXPECTED" "$cap" 2>/dev/null || return 1
  # The resume transaction writes progress_at and standby_until (min of the window deadline and the budget).
  grep -qF 'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END' "$core" 2>/dev/null || return 1
  grep -qF 'standby employee unavailable' "$core" 2>/dev/null || return 1
  grep -qF 'standby denied: unmet dependencies remain' "$core" 2>/dev/null || return 1
  # The view surfaces the deadline; the config carries the budget. The budget lives in the config
  # interface (CompanyConfig.standbyBudgetSeconds), its default (DEFAULT_CONFIG), and the company_meta
  # config row key it is read from (standby_budget_seconds). Probe the declarations the tree really
  # has: a comment-only or fixture-shaped tree cannot pass, and a tree that dropped the budget
  # declaration while keeping the row key cannot pass either.
  grep -Eq '^[[:space:]]*standbyUntil\?:' "$contracts" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*standbyBudgetSeconds:[[:space:]]*number;' "$workforce" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*standbyBudgetSeconds:[[:space:]]*STANDBY_BUDGET_SECONDS_DEFAULT' "$workforce" 2>/dev/null || return 1
  grep -qF 'standby_budget_seconds' "$workforce" 2>/dev/null || return 1
  # The supervision branch wakes standby holders, waives the stall/expire reclaim before the deadline
  # and returns the timeout to the gm gate (standby_timeout), never the ready pool.
  grep -qF 'standby timeout' "$dispatcher" 2>/dev/null || return 1
  grep -qF 'standby_timeout' "$workforce" 2>/dev/null || return 1
  grep -qF 'STANDBY_WAKE_RETRY_SECONDS' "$dispatcher" 2>/dev/null || return 1
  return 0
}

# 0 when <release> may be switched to. Scope `full` (local install/rollback) also checks the plugin
# vendor, which runs the same core; scope `core` is the remote MCP deploy (service core only).
standby_relay_target_supported() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || return 1
  standby_relay_probe_root "$release" || return 1
  [ "$scope" = core ] && return 0
  if [ -d "$release/plugin" ]; then
    [ -d "$release/plugin/server/vendor" ] || return 1
    standby_relay_probe_root "$release/plugin/server/vendor" || return 1
  fi
  return 0
}

# Why a target was refused, in the caller's words (target, reason, and what could not be read).
standby_relay_refusal_reason() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || { echo "目标目录不存在：$release"; return 0; }
  if [ ! -f "$release/src/standby-relay-capability.ts" ]; then
    echo "目标代码没有 standby 接力能力契约（src/standby-relay-capability.ts 缺失）：该版本不认识有界待命协议，会把 standby 直派当成普通 doing 租约、既不节流唤醒也不按窗口纪律收回"
    return 0
  fi
  if ! standby_relay_probe_root "$release"; then
    echo "目标代码的 standby 接力契约不完整或不可读（capability/core/contracts/dispatcher/workforce 标记不满足）：无法证明它会在待命期内豁免收回、超时回经理关口"
    return 0
  fi
  [ "$scope" = core ] && { echo "目标代码不支持 standby 接力契约"; return 0; }
  if [ -d "$release/plugin" ] && [ ! -d "$release/plugin/server/vendor" ]; then
    echo "目标发布缺少插件 vendor 树：无法证明插件面与核心同样支持 standby 接力（未知按不兼容处理）"
    return 0
  fi
  if [ -d "$release/plugin" ] && ! standby_relay_probe_root "$release/plugin/server/vendor"; then
    echo "目标的插件 vendor 代码不支持 standby 接力契约：双面不同源，切换会让插件面按旧语义对待待命任务"
    return 0
  fi
  echo "目标代码不支持 standby 接力契约"
}

standby_relay_refuse() {
  release=$1
  scope=${2:-full}
  reason=$(standby_relay_refusal_reason "$release" "$scope")
  echo "refused: $reason" >&2
  echo "refused: target=$release" >&2
  echo "refused: standby items=unknown (no authorised read seam in the switch script; this is not a claim that none stand by)" >&2
  echo "refused: only a target that proves the standby relay contract may be switched to; otherwise keep the current healthy release, hold, or land an audited forward fix (see docs/company-service-operations.md)" >&2
}
