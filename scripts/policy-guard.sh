#!/bin/sh
# SYS06 C1: the switch guard for the versioned machine policy (effective-policy).
#
# A target release is compatible only when its own code carries the policy execution layer: the judgement in
# src/policy.ts (resolveEffective / checkWriteAuthority / dispatchVerdict), the read layer in src/policy-store.ts, the
# dry-run and isolation methods plus the policy_blocked audit in src/core.ts, the dispatcher seam in src/workforce.ts,
# the plan contract and the task-view facts in src/contracts.ts, and the policy table with the task/lease registration
# fields of the effective-policy migration (loaded by src/database.ts). The caller binds the release content to its
# commit (release-content.sh) before asking, so the probe reads reviewed code.
#
# The rule is fail-closed and has NO zero-row exception: an incompatible or unreadable target is refused even when the
# policy table is empty today. A zero-row check would race a policy write that lands right after the check, and it would
# miss the case this guard exists for: production data that ALREADY carries a policy — policy rows, the task
# policy_*/lease_policy_* registrations, and tasks already quarantined as blocked + blocked_to=gm. Switching that data
# onto a target that does not enforce the layer hands the dispatch decision back to a release that cannot see any of it,
# so a task the current contract no longer authorises is dispatched as an ordinary ready task. The guard therefore never
# answers "safe because no policy is written yet", and it reports the affected tasks as `unknown` because it has no
# authorised read seam.
#
# Sourced by scripts/company-service.sh (install/rollback) and scripts/deploy-mcp-remote.sh (remote switch). No
# credentials are read here, and nothing in this file performs a side effect.

# 0 when the tree at <root> carries the contract (files read, never executed).
policy_probe_root() {
  root=$1
  [ -d "$root" ] || return 1
  judgement="$root/src/policy.ts"
  store="$root/src/policy-store.ts"
  core="$root/src/core.ts"
  workforce="$root/src/workforce.ts"
  contracts="$root/src/contracts.ts"
  database="$root/src/database.ts"
  [ -f "$judgement" ] && [ -f "$store" ] && [ -f "$core" ] && [ -f "$workforce" ] && [ -f "$contracts" ] && [ -f "$database" ] || return 1
  # 迁移文件名会随 main 的迁移号变化（本线就从 033 改到 035），所以按语义 glob，再要求 bootstrap 真的加载它。
  schema=
  for candidate in "$root"/schema/*effective-policy*.surql; do
    [ -f "$candidate" ] && schema=$candidate && break
  done
  [ -n "$schema" ] || return 1
  # Declarations, not comment text: a comment-only tree cannot pass (the RW06 review point, same rule here).
  # 判定只有一处（policy.ts），读取只有一处（policy-store.ts）：少一个，目标就没有"同一份判定"可言。
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+resolveEffective[[:space:]]*\(' "$judgement" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+checkWriteAuthority[[:space:]]*\(' "$judgement" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+dispatchVerdict[[:space:]]*\(' "$judgement" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+readEffectiveContract[[:space:]]*\(' "$store" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+readTaskPolicyRow[[:space:]]*\(' "$store" 2>/dev/null || return 1
  # 试算与隔离两个方法，以及隔离写下的审计动作：旧 core 一个都没有，它的候选集与租约事务里也就没有策略这一层。
  grep -Eq '^[[:space:]]*async[[:space:]]+policyPlan[[:space:]]*\(' "$core" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*async[[:space:]]+policyEnforce[[:space:]]*\(' "$core" 2>/dev/null || return 1
  grep -qF "action: 'policy_blocked'" "$core" 2>/dev/null || return 1
  grep -q 'policy_block_reason' "$core" 2>/dev/null || return 1
  # 调度器派工前的判定与 core 同源；没有它，切换后的派工候选集不看策略。
  grep -Eq '^[[:space:]]*async[[:space:]]+policyDispatchVerdict[[:space:]]*\(' "$workforce" 2>/dev/null || return 1
  # 试算契约与任务视图上的策略事实：缺了它，目标连"这条任务登记过什么契约"都答不出来。
  grep -Eq '^[[:space:]]*export[[:space:]]+interface[[:space:]]+PolicyPlanInput[[:space:]]*\{' "$contracts" 2>/dev/null || return 1
  grep -Eq '^[[:space:]]*policyBlockReason\?:' "$contracts" 2>/dev/null || return 1
  # 迁移：policy 表与任务/租约上的登记字段，且这一版真的被 bootstrap 加载。
  grep -qF 'DEFINE TABLE IF NOT EXISTS policy' "$schema" 2>/dev/null || return 1
  grep -q 'policy_hash' "$schema" 2>/dev/null || return 1
  grep -q 'lease_policy_hash' "$schema" 2>/dev/null || return 1
  grep -q 'policy_block_reason' "$schema" 2>/dev/null || return 1
  grep -qF "$(basename "$schema")" "$database" 2>/dev/null || return 1
  return 0
}

# 0 when <release> may be switched to. Scope `full` (local install/rollback) also checks the plugin surface, which runs the
# same core: a shipped plugin must carry a generated vendor tree with the contract, and a missing vendor is unknown (refused),
# never assumed compatible. Scope `core` is the remote MCP deploy, whose payload is the service core only.
policy_target_supported() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || return 1
  policy_probe_root "$release" || return 1
  [ "$scope" = core ] && return 0
  if [ -d "$release/plugin" ]; then
    [ -d "$release/plugin/server/vendor" ] || return 1
    policy_probe_root "$release/plugin/server/vendor" || return 1
  fi
  return 0
}

# Why a target was refused, in the caller's words (target, reason, and what could not be read).
policy_refusal_reason() {
  release=$1
  scope=${2:-full}
  [ -d "$release" ] || { echo "目标目录不存在：$release"; return 0; }
  if [ ! -f "$release/src/policy.ts" ] || [ ! -f "$release/src/policy-store.ts" ]; then
    echo "目标代码没有有效策略执行层（src/policy.ts / src/policy-store.ts 缺失）：该版本既不判定也不隔离，已写策略与已隔离任务的生产数据切过去会让失去授权的任务被直接派工"
    return 0
  fi
  if ! policy_probe_root "$release"; then
    echo "目标代码的有效策略执行层不完整或不可读（判定/读取层/试算与隔离/调度器接缝/迁移标记不满足）：无法证明它会按同一份判定拒绝失去授权的任务"
    return 0
  fi
  [ "$scope" = core ] && { echo "目标代码不支持有效策略执行层"; return 0; }
  if [ -d "$release/plugin" ] && [ ! -d "$release/plugin/server/vendor" ]; then
    echo "目标发布缺少插件 vendor 树：无法证明插件面与核心同样执行有效策略（未知按不兼容处理）"
    return 0
  fi
  if [ -d "$release/plugin" ] && ! policy_probe_root "$release/plugin/server/vendor"; then
    echo "目标的插件 vendor 代码不支持有效策略执行层：双面不同源，切换会让插件面按旧语义放行失去授权的任务"
    return 0
  fi
  echo "目标代码不支持有效策略执行层"
}

# The refusal line shared by every switch entry point, so the operator sees the same facts everywhere.
policy_refuse() {
  release=$1
  scope=${2:-full}
  reason=$(policy_refusal_reason "$release" "$scope")
  echo "refused: $reason" >&2
  echo "refused: target=$release" >&2
  echo "refused: affected tasks=unknown (no authorised read seam in the switch script; this is not a claim that none is affected)" >&2
  echo "refused: only a target that proves the effective-policy contract may be switched to; otherwise keep the current healthy release, hold, or land an audited forward fix (see docs/company-service-operations.md)" >&2
}