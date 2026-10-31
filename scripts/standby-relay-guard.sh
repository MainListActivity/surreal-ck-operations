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

# Search source outside comments only, with a line-based JS/TS lexer:
# - single- and double-quoted strings end at the closing quote or, if unterminated, at end of line
#   (JS/TS strings cannot span lines), so a stray quote cannot swallow later comment lines;
# - template literals may span lines: the backtick state carries across lines until it closes;
# - a regex literal /.../[flags] is recognised where JS allows one (after an operator or opener),
#   so a quote inside a regex does not open a string;
# - text inside any quote is preserved (SQL/template markers are real code); comment text is
#   discarded but lines are kept, so a multi-line /* ... */ block cannot smuggle markers and an
#   anchored pattern still sees one code line per source line. A comment-only release cannot pass.
standby_relay_has_code() {
  file=$1
  mode=$2
  marker=$3
  awk -v mode="$mode" -v marker="$marker" '
    BEGIN {
      escape = sprintf("%c", 92); dq = sprintf("%c", 34); sq = sprintf("%c", 39); bt = sprintf("%c", 96)
    }
    {
      line = $0
      code = ""
      for (i = 1; i <= length(line); i++) {
        char = substr(line, i, 1)
        next_char = substr(line, i + 1, 1)
        if (in_block_comment) {
          if (char == "*" && next_char == "/") { in_block_comment = 0; i++ }
          continue
        }
        if (quote != "") {
          code = code char
          if (char == escape && i < length(line)) { code = code next_char; i++; continue }
          if (char == quote) { quote = ""; template = 0 }
          continue
        }
        if (char == dq || char == sq || char == bt) { quote = char; template = (char == bt) ? 1 : 0; code = code char; continue }
        if (char == "/" && next_char == "/") break
        if (char == "/" && next_char == "*") { in_block_comment = 1; i++; continue }
        if (char == "/" && next_char != "" && next_char != "/" && next_char != "*" && prev_code_char ~ /[=(,:[!&|?{};+-]$/) {
          # Regex literal: scan to the closing slash honouring escapes and character classes.
          j = i + 1; in_class = 0; closed = 0
          while (j <= length(line)) {
            rc = substr(line, j, 1)
            if (rc == escape) { j += 2; continue }
            if (in_class) { if (rc == "]") in_class = 0 }
            else if (rc == "[") { in_class = 1 }
            else if (rc == "/") { closed = 1; break }
            j++
          }
          if (closed) {
            code = code "re"
            j++
            while (j <= length(line) && substr(line, j, 1) ~ /[a-z]/) j++
            i = j - 1
            prev_code_char = ""
            continue
          }
        }
        if (char != " " && char != "\t") prev_code_char = char
        code = code char
      }
      if (quote != "" && template != 1) quote = ""
      if ((mode == "pattern" && code ~ marker) || (mode != "pattern" && index(code, marker))) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$file"
}
standby_relay_has_code_marker() { standby_relay_has_code "$1" fixed "$2"; }
standby_relay_has_code_pattern() { standby_relay_has_code "$1" pattern "$2"; }

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
  standby_relay_has_code_pattern "$cap" '^[[:space:]]*(export[[:space:]]+)?const[[:space:]]+STANDBY_RELAY_PROTOCOL[[:space:]]*=' || return 1
  standby_relay_has_code_marker "$cap" "$STANDBY_RELAY_PROTOCOL_EXPECTED" || return 1
  # The resume transaction writes progress_at and standby_until (min of the window deadline and the budget).
  standby_relay_has_code_marker "$core" 'standby_until = IF $assigned THEN math::min([$standby_not_after, $now + $standby_budget]) ELSE NONE END' || return 1
  standby_relay_has_code_marker "$core" 'standby employee unavailable' || return 1
  standby_relay_has_code_marker "$core" 'standby denied: unmet dependencies remain' || return 1
  # The view surfaces the deadline; the config carries the budget. The budget lives in the config
  # interface (CompanyConfig.standbyBudgetSeconds), its default (DEFAULT_CONFIG), and the company_meta
  # config row key it is read from (standby_budget_seconds). The declaration probes run through the
  # same comment-stripping scanner: a block comment that mentions the declaration cannot stand in for it.
  standby_relay_has_code_pattern "$contracts" '^[[:space:]]*standbyUntil[?]:' || return 1
  standby_relay_has_code_pattern "$workforce" '^[[:space:]]*standbyBudgetSeconds:[[:space:]]*number;' || return 1
  standby_relay_has_code_pattern "$workforce" '^[[:space:]]*standbyBudgetSeconds:[[:space:]]*STANDBY_BUDGET_SECONDS_DEFAULT' || return 1
  standby_relay_has_code_marker "$workforce" 'standby_budget_seconds' || return 1
  standby_relay_has_code_marker "$dispatcher" 'standby timeout' || return 1
  standby_relay_has_code_marker "$workforce" 'standby_timeout' || return 1
  standby_relay_has_code_marker "$dispatcher" 'STANDBY_WAKE_RETRY_SECONDS' || return 1
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
