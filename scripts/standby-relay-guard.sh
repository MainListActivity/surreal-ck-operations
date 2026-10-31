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

# Where the marker search runs, and with which runtime. The decision "is this occurrence code or a
# comment?" is made by the repository's own TypeScript parser (scripts/standby-relay-scan.mjs with
# node_modules/typescript), not by a lexer written here: a hand-written lexer has to guess the
# lexical state of every construct (is this slash a regex or a division, whose brace is this, does
# this colon close a ternary, does this line end a statement), and a state read wrongly turns a
# comment into code — the fail-open this guard exists to prevent. The parser knows the comment
# ranges of the file, so:
# - a marker occurrence outside every comment range is code. String and template text is code, so
#   the query markers written in template literals count; a marker that only appears in a comment
#   does not, and a comment-only release cannot pass;
# - an anchored declaration probe matches a code line. Comment text is blanked and the line
#   structure is kept, so a declaration inside a comment cannot stand in for the declaration, and a
#   declaration cannot be assembled across a comment either;
# - a file the parser cannot read - one that ends inside a template literal or inside a block
#   comment, where the parser cannot tell template text from a comment - is refused, not guessed;
# - when the parser cannot be loaded, or a file cannot be read, nothing is decided: the scan fails
#   and the target is refused. The guard never answers "safe" on an unreadable tree.
#
# The parser is the one the release was type-checked with, so the guard and the compiler agree on
# what the source says. The scanner runs on the runtime the services run with when this shell
# resolved it (scripts/bun-runtime.sh), otherwise on bun or node from PATH. Its answer is read from
# what it prints, not from its exit code, so a runtime that cannot run it at all (a stub, a wrong
# interpreter) refuses the target instead of passing it.
standby_relay_scanner=''
standby_relay_runtime=''

standby_relay_resolve_scanner() {
  [ -n "$standby_relay_scanner" ] && return 0
  if [ -n "${STANDBY_RELAY_SCANNER:-}" ] && [ -f "${STANDBY_RELAY_SCANNER}" ]; then
    standby_relay_scanner=${STANDBY_RELAY_SCANNER}
    return 0
  fi
  # This file is sourced, so $0 is the caller's path; under bash BASH_SOURCE names this file.
  for standby_relay_self in "${BASH_SOURCE:-}" "$0"; do
    [ -n "$standby_relay_self" ] || continue
    case "$standby_relay_self" in */*) ;; *) continue ;; esac
    standby_relay_dir=$(dirname "$standby_relay_self")
    case "$standby_relay_dir" in /*) ;; *) standby_relay_dir=$(cd "$standby_relay_dir" 2>/dev/null && pwd) || continue ;; esac
    if [ -f "$standby_relay_dir/standby-relay-scan.mjs" ]; then
      standby_relay_scanner="$standby_relay_dir/standby-relay-scan.mjs"
      return 0
    fi
  done
  # The working directory and its parents: a caller that sources the guard without a path of its
  # own still finds the scanner beside the checkout it runs in.
  standby_relay_dir=$PWD
  standby_relay_up=0
  while [ "$standby_relay_up" -lt 6 ]; do
    if [ -f "$standby_relay_dir/scripts/standby-relay-scan.mjs" ]; then
      standby_relay_scanner="$standby_relay_dir/scripts/standby-relay-scan.mjs"
      return 0
    fi
    [ "$standby_relay_dir" = / ] && break
    standby_relay_dir=$(dirname "$standby_relay_dir")
    standby_relay_up=$((standby_relay_up + 1))
  done
  return 1
}

standby_relay_resolve_runtime() {
  [ -n "$standby_relay_runtime" ] && return 0
  for standby_relay_candidate in "${STANDBY_RELAY_RUNTIME:-}" "${SCK_BUN:-}" "${BUN:-}"; do
    if [ -n "$standby_relay_candidate" ] && [ -x "$standby_relay_candidate" ]; then
      standby_relay_runtime=$standby_relay_candidate
      return 0
    fi
  done
  # The runtime the services run with, when this shell can resolve it.
  if command -v resolve_bun >/dev/null 2>&1; then
    standby_relay_home=${service_home:-${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}}
    standby_relay_candidate=$(resolve_bun "$standby_relay_home" >/dev/null 2>&1; printf '%s' "${BUN:-}")
    if [ -n "$standby_relay_candidate" ] && [ -x "$standby_relay_candidate" ]; then
      standby_relay_runtime=$standby_relay_candidate
      return 0
    fi
  fi
  for standby_relay_candidate in bun node; do
    standby_relay_path=$(command -v "$standby_relay_candidate" 2>/dev/null) || continue
    standby_relay_runtime=$standby_relay_path
    return 0
  done
  return 1
}

# Run the scanner and print its verdict: "yes" when the check holds, "no" when it does not. The
# verdict is read from the output, not from the exit code, so a runtime that prints nothing (a
# stub, a wrong interpreter) cannot pass a check by accident.
standby_relay_scan() {
  standby_relay_resolve_scanner || return 3
  standby_relay_resolve_runtime || return 3
  "$standby_relay_runtime" "$standby_relay_scanner" "$@"
}

# 0 when the scanner answered that the check holds.
standby_relay_scan_holds() {
  standby_relay_verdict=$(standby_relay_scan "$@") || :
  case "$standby_relay_verdict" in
    yes*) return 0 ;;
    *) return 1 ;;
  esac
}

# 0 when the marker occurs in code (not in a comment) in <file>.
standby_relay_has_code_marker() {
  standby_relay_scan_holds marker "$1" "$2" && return 0
  return 1
}

# 0 when a code line of <file> matches the POSIX ERE <pattern>.
standby_relay_has_code_pattern() {
  standby_relay_scan_holds pattern "$1" "$2" && return 0
  return 1
}

# Kept for callers of the earlier signature: <file> <fixed|pattern> <needle>.
standby_relay_has_code() {
  case "$2" in
    pattern) standby_relay_has_code_pattern "$1" "$3" ;;
    *) standby_relay_has_code_marker "$1" "$3" ;;
  esac
}

# The files a tree must carry.
standby_relay_root_present() {
  standby_relay_root=$1
  [ -d "$standby_relay_root" ] || return 1
  [ -f "$standby_relay_root/src/standby-relay-capability.ts" ] || return 1
  [ -f "$standby_relay_root/src/core.ts" ] || return 1
  [ -f "$standby_relay_root/src/contracts.ts" ] || return 1
  [ -f "$standby_relay_root/src/dispatcher/dispatcher.ts" ] || return 1
  [ -f "$standby_relay_root/src/workforce.ts" ] || return 1
  return 0
}

# The contract of one tree, one "kind<TAB>file<TAB>needle" check per line: the protocol
# declaration and its value, the resume write and the two refusal messages of the core, the view
# field, the budget interface field, its default, the row key it is read from, the audit action,
# the wake interval and the timeout message.
standby_relay_root_checks() {
  standby_relay_root=$1
  printf 'pattern\t%s\t%s\n' "$standby_relay_root/src/standby-relay-capability.ts" '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+STANDBY_RELAY_PROTOCOL[[:space:]]*='
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/standby-relay-capability.ts" "$STANDBY_RELAY_PROTOCOL_EXPECTED"
  # The resume transaction writes progress_at and standby_until (min of the window deadline and the budget).
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/core.ts" 'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END'
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/core.ts" 'standby employee unavailable'
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/core.ts" 'standby denied: unmet dependencies remain'
  # The view surfaces the deadline; the config carries the budget. The budget lives in the config
  # interface (CompanyConfig.standbyBudgetSeconds), its default (DEFAULT_CONFIG), and the company_meta
  # config row key it is read from (standby_budget_seconds).
  printf 'pattern\t%s\t%s\n' "$standby_relay_root/src/contracts.ts" '^[[:space:]]*standbyUntil[?]:'
  printf 'pattern\t%s\t%s\n' "$standby_relay_root/src/workforce.ts" '^[[:space:]]*standbyBudgetSeconds:[[:space:]]*number;'
  printf 'pattern\t%s\t%s\n' "$standby_relay_root/src/workforce.ts" '^[[:space:]]*standbyBudgetSeconds:[[:space:]]*STANDBY_BUDGET_SECONDS_DEFAULT'
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/workforce.ts" 'standby_budget_seconds'
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/dispatcher/dispatcher.ts" 'standby timeout'
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/workforce.ts" 'standby_timeout'
  printf 'marker\t%s\t%s\n' "$standby_relay_root/src/dispatcher/dispatcher.ts" 'STANDBY_WAKE_RETRY_SECONDS'
}

# The scanner's answer for a tree: 0 when it holds, and the checks that did not hold in
# standby_relay_missing.
standby_relay_probe_root() {
  standby_relay_root=$1
  standby_relay_root_present "$standby_relay_root" || return 1
  standby_relay_verdict=$(standby_relay_root_checks "$standby_relay_root" | standby_relay_scan batch) || :
  case "$standby_relay_verdict" in
    yes*) return 0 ;;
    *) return 1 ;;
  esac
}

# 0 when <release> may be switched to. Scope `full` (local install/rollback) also checks the plugin
# vendor, which runs the same core; scope `core` is the remote MCP deploy (service core only).
standby_relay_target_supported() {
  standby_relay_release=$1
  standby_relay_scope=${2:-full}
  [ -d "$standby_relay_release" ] || return 1
  standby_relay_root_present "$standby_relay_release" || return 1
  standby_relay_vendor=''
  if [ "$standby_relay_scope" != core ] && [ -d "$standby_relay_release/plugin" ]; then
    [ -d "$standby_relay_release/plugin/server/vendor" ] || return 1
    standby_relay_root_present "$standby_relay_release/plugin/server/vendor" || return 1
    standby_relay_vendor="$standby_relay_release/plugin/server/vendor"
  fi
  standby_relay_verdict=$(
    {
      standby_relay_root_checks "$standby_relay_release"
      if [ -n "$standby_relay_vendor" ]; then standby_relay_root_checks "$standby_relay_vendor"; fi
    } | standby_relay_scan batch
  ) || :
  case "$standby_relay_verdict" in
    yes*) return 0 ;;
    *) return 1 ;;
  esac
}

# Why a target was refused, in the caller's words (target, reason, and what could not be read).
standby_relay_refusal_reason() {
  standby_relay_release=$1
  standby_relay_scope=${2:-full}
  [ -d "$standby_relay_release" ] || { echo "目标目录不存在：$standby_relay_release"; return 0; }
  if [ ! -f "$standby_relay_release/src/standby-relay-capability.ts" ]; then
    echo "目标代码没有 standby 接力能力契约（src/standby-relay-capability.ts 缺失）：该版本不认识有界待命协议，会把 standby 直派当成普通 doing 租约、既不节流唤醒也不按窗口纪律收回"
    return 0
  fi
  standby_relay_verdict=$(standby_relay_root_checks "$standby_relay_release" | standby_relay_scan batch) || :
  standby_relay_unreadable=0
  standby_relay_missing=''
  case "$standby_relay_verdict" in
    yes*) ;;
    no*) standby_relay_missing=${standby_relay_verdict#no} ;;
    *) standby_relay_unreadable=1 ;;
  esac
  if [ "$standby_relay_unreadable" -ne 0 ]; then
    echo "目标代码的 standby 接力契约无法判定（代码扫描器不可用或源码不可读）：无法证明它会在待命期内豁免收回、超时回经理关口"
    return 0
  fi
  if [ -n "$standby_relay_missing" ]; then
    echo "目标代码的 standby 接力契约不完整（capability/core/contracts/dispatcher/workforce 标记不满足）：无法证明它会在待命期内豁免收回、超时回经理关口"
    echo "缺少的契约证据：$standby_relay_missing"
    return 0
  fi
  [ "$standby_relay_scope" = core ] && { echo "目标代码不支持 standby 接力契约"; return 0; }
  if [ -d "$standby_relay_release/plugin" ] && [ ! -d "$standby_relay_release/plugin/server/vendor" ]; then
    echo "目标发布缺少插件 vendor 树：无法证明插件面与核心同样支持 standby 接力（未知按不兼容处理）"
    return 0
  fi
  if [ -d "$standby_relay_release/plugin" ]; then
    standby_relay_verdict=$(standby_relay_root_checks "$standby_relay_release/plugin/server/vendor" | standby_relay_scan batch) || :
    standby_relay_missing=''
    case "$standby_relay_verdict" in
      yes*) ;;
      no*) standby_relay_missing=${standby_relay_verdict#no} ;;
      *) standby_relay_missing='代码扫描器无法判定插件 vendor 树' ;;
    esac
    if [ -n "$standby_relay_missing" ]; then
      echo "目标的插件 vendor 代码不支持 standby 接力契约：双面不同源，切换会让插件面按旧语义对待待命任务"
      echo "缺少的契约证据：$standby_relay_missing"
      return 0
    fi
  fi
  echo "目标代码不支持 standby 接力契约"
}

standby_relay_refuse() {
  standby_relay_release=$1
  standby_relay_scope=${2:-full}
  standby_relay_reason=$(standby_relay_refusal_reason "$standby_relay_release" "$standby_relay_scope")
  echo "refused: $standby_relay_reason" >&2
  echo "refused: target=$standby_relay_release" >&2
  echo "refused: standby items=unknown (no authorised read seam in the switch script; this is not a claim that none stand by)" >&2
  echo "refused: only a target that proves the standby relay contract may be switched to; otherwise keep the current healthy release, hold, or land an audited forward fix (see docs/company-service-operations.md)" >&2
}
