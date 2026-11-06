#!/bin/sh
# SYS02 C2: the switch guard for the acceptance baseline contract.
#
# A target release is compatible only when its own code carries the acceptance baseline contract (baseline declarations and the
# criteria merger in src/acceptance.ts, the acceptance_evidence / acceptance_criteria schema markers, and the acceptance_gate
# bootstrap in src/database.ts). The caller binds the release content to its commit (release-content.sh) before asking, so the
# probe reads reviewed code.
#
# The rule is fail-closed and has NO zero-row exception: an incompatible or unreadable target is refused even when no gated task
# exists today. Sourced by scripts/company-service.sh (install/rollback) and scripts/deploy-mcp-remote.sh (remote switch). No
# credentials are read here, and nothing in this file performs a side effect.

acceptance_probe_root() {
  root=$1
  [ -d "$root" ] || return 1
  acceptance="$root/src/acceptance.ts"
  core="$root/src/core.ts"
  database="$root/src/database.ts"
  [ -f "$acceptance" ] && [ -f "$core" ] && [ -f "$database" ] || return 1
  schema=
  for candidate in "$root"/schema/*acceptance*.surql; do
    [ -f "$candidate" ] && schema=$candidate && break
  done
  [ -n "$schema" ] || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+ACCEPTANCE_BASELINE_VERSION[^=]*=' "$acceptance" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+BASELINE_IDS[^=]*=' "$acceptance" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+mergeAcceptanceCriteria[[:space:]]*\(' "$acceptance" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+isTrustedCodeDeliverable[[:space:]]*\(' "$acceptance" 2>/dev/null || return 1
  grep -qF 'mergeAcceptanceCriteria(leg, criteria)' "$acceptance" 2>/dev/null || return 1
  grep -q 'mergeAcceptanceCriteria(' "$core" 2>/dev/null || return 1
  grep -q 'isTrustedCodeDeliverable(' "$core" 2>/dev/null || return 1
  grep -q 'acceptance_evidence' "$schema" 2>/dev/null || return 1
  grep -q 'acceptance_criteria' "$schema" 2>/dev/null || return 1
  grep -q 'acceptance_gate' "$database" 2>/dev/null || return 1
  migration=$(basename "$schema")
  grep -qF "$migration" "$database" 2>/dev/null || return 1
  return 0
}

# 0 when <release> may be switched to. Scope `full` also checks the plugin vendor (the plugin runs the same core).
acceptance_target_supported() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || return 1
  acceptance_probe_root "$release" || return 1
  [ "$scope" = core ] && return 0
  if [ -d "$release/plugin" ]; then
    [ -d "$release/plugin/server/vendor" ] || return 1
    acceptance_probe_root "$release/plugin/server/vendor" || return 1
  fi
  return 0
}

acceptance_refusal_reason() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || { echo "目标目录不存在：$release"; return 0; }
  if [ ! -f "$release/src/acceptance.ts" ]; then
    echo "目标代码没有 SYS02 验收基线契约（src/acceptance.ts 缺失）：该版本不认识必填机器证据与独立签署基线"
    return 0
  fi
  if ! acceptance_probe_root "$release"; then
    echo "目标代码的 SYS02 验收基线不完整或不可读（基线声明/评估器合并/schema/bootstrap 标记不满足）"
    return 0
  fi
  [ "$scope" = core ] && { echo "目标代码不支持 SYS02 验收基线"; return 0; }
  if [ -d "$release/plugin" ] && [ ! -d "$release/plugin/server/vendor" ]; then
    echo "目标发布缺少插件 vendor 树：无法证明插件面与核心同样支持 SYS02 验收基线"
    return 0
  fi
  if [ -d "$release/plugin" ] && ! acceptance_probe_root "$release/plugin/server/vendor"; then
    echo "目标的插件 vendor 代码不支持 SYS02 验收基线：双面不同源"
    return 0
  fi
  echo "目标代码不支持 SYS02 验收基线"
}

acceptance_refuse() {
  release=$1
  scope=${2:-full}
  reason=$(acceptance_refusal_reason "$release" "$scope")
  echo "refused: $reason" >&2
  echo "refused: target=$release" >&2
  echo "refused: row counts are not a safety proof; only a target whose content proves the SYS02 baseline contract may be switched to; otherwise hold the current healthy release or land an audited forward fix" >&2
}
