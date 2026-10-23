#!/bin/sh
# IR06 C1: the switch guard for the source-contributor dynamic avoidance (independence).
#
# A target release is compatible only when its own code carries the independence contract: the protocol constant in
# src/independence.ts, the source guard (INDEPENDENCE_GUARD_SQL) and the gate method in src/core.ts, and the policy and
# principal views in src/contracts.ts. The caller binds the release content to its commit (release-content.sh) before
# asking, so the probe reads reviewed code.
#
# The rule is fail-closed and has NO zero-row exception: an incompatible or unreadable target is refused even when no task
# carries a policy today. A zero-row check would race a policy write that lands after the check, and it would also miss the
# case this guard exists for: production data that ALREADY carries a policy. Switching that data onto a target that does not
# enforce the policy lets an excluded contributor claim, which is the regression IR06 refused. The guard therefore never
# answers "safe because nothing is excluded yet", and it reports the affected tasks as `unknown` because it has no
# authorised read seam.
#
# Sourced by scripts/company-service.sh (install/rollback) and scripts/deploy-mcp-remote.sh (remote switch). No credentials
# are read here, and nothing in this file performs a side effect.

# 0 when the tree at <root> carries the contract (files read, never executed).
independence_probe_root() {
  root=$1
  [ -d "$root" ] || return 1
  module="$root/src/independence.ts"
  core="$root/src/core.ts"
  contracts="$root/src/contracts.ts"
  [ -f "$module" ] && [ -f "$core" ] && [ -f "$contracts" ] || return 1
  # Declarations, not comment text: a comment-only tree cannot pass (the RW06 review point, same rule here).
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+INDEPENDENCE_LIMITS[[:space:]]*=' "$module" 2>/dev/null || return 1
  # The source guard of a gated write, and the gate method that reads the exclusion before the write. An old core has
  # neither, so its lease transaction carries no guard and its claim never refuses an excluded contributor.
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+INDEPENDENCE_GUARD_SQL[[:space:]]*=' "$core" 2>/dev/null || return 1
  grep -qF 'FOR $g IN $indep_guards' "$core" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*private[[:space:]]+async[[:space:]]+independenceGate[[:space:]]*\(' "$core" 2>/dev/null || return 1
  # The stored policy and the identity link a policy is judged against. Without either view the target cannot even read
  # what production already holds, which is the same as not enforcing it.
  grep -Eq '^[[:space:]]*export[[:space:]]+interface[[:space:]]+IndependencePolicy[[:space:]]*\{' "$contracts" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*export[[:space:]]+interface[[:space:]]+IdentityPrincipalView[[:space:]]*\{' "$contracts" 2>/dev/null || return 1
  return 0
}

# 0 when <release> may be switched to. Scope `full` (local install/rollback) also checks the plugin surface, which runs the
# same core: a shipped plugin must carry a generated vendor tree with the contract, and a missing vendor is unknown (refused),
# never assumed compatible. Scope `core` is the remote MCP deploy, whose payload is the service core only.
independence_target_supported() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || return 1
  independence_probe_root "$release" || return 1
  [ "$scope" = core ] && return 0
  if [ -d "$release/plugin" ]; then
    [ -d "$release/plugin/server/vendor" ] || return 1
    independence_probe_root "$release/plugin/server/vendor" || return 1
  fi
  return 0
}

# Why a target was refused, in the caller's words (target, reason, and what could not be read).
independence_refusal_reason() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || { echo "目标目录不存在：$release"; return 0; }
  if [ ! -f "$release/src/independence.ts" ]; then
    echo "目标代码没有独立性回避能力契约（src/independence.ts 缺失）：该版本不执行来源经手人回避，已写策略的生产数据切过去会让被排除者直接认领"
    return 0
  fi
  if ! independence_probe_root "$release"; then
    echo "目标代码的独立性回避契约不完整或不可读（core/contracts 标记不满足）：无法证明它会在领取与提交前拒绝被排除的经手人"
    return 0
  fi
  [ "$scope" = core ] && { echo "目标代码不支持独立性回避契约"; return 0; }
  if [ -d "$release/plugin" ] && [ ! -d "$release/plugin/server/vendor" ]; then
    echo "目标发布缺少插件 vendor 树：无法证明插件面与核心同样执行来源经手人回避（未知按不兼容处理）"
    return 0
  fi
  if [ -d "$release/plugin" ] && ! independence_probe_root "$release/plugin/server/vendor"; then
    echo "目标的插件 vendor 代码不支持独立性回避契约：双面不同源，切换会让插件面按旧语义放行被排除者"
    return 0
  fi
  echo "目标代码不支持独立性回避契约"
}

# The refusal line shared by every switch entry point, so the operator sees the same facts everywhere.
independence_refuse() {
  release=$1
  scope=${2:-full}
  reason=$(independence_refusal_reason "$release" "$scope")
  echo "refused: $reason" >&2
  echo "refused: target=$release" >&2
  echo "refused: excluded tasks=unknown (no authorised read seam in the switch script; this is not a claim that none is excluded)" >&2
  echo "refused: only a target that proves the independence contract may be switched to; otherwise keep the current healthy release, hold, or land an audited forward fix (see docs/company-service-operations.md)" >&2
}
