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
# - single- and double-quoted strings close on their quote; an odd number of unescaped trailing
#   backslashes is an ECMAScript LineContinuation and carries the quote onto the next line
#   (even count / no backslash ends the quote state at EOL, so a stray quote cannot swallow later
#   comment lines). Template literals span lines and nest through ${}: a backtick inside an
#   expression opens an inner template; the matching } of ${} returns to template text;
# - a regex literal /.../[flags] is recognised by ECMAScript lexical context: after a
#   start/operator/open, after expression-prefix keywords (return/typeof/default/...), after =>,
#   and after ) that closed an if/while/for/with/switch head. After an identifier, number,
#   string/template/regex end, ), or ], a slash is division. Member names after . are never
#   keywords (stats.in / x is division). in is always the reserved binary operator (so
#   'a' in /re/ is a regex after in); of is a keyword only inside a for head
#   (for (x of /re/)), and as a bare identifier stays ident (of / 2 is division). Postfix !
#   (TS non-null) keeps an expression end; != / !== stay operators. else/do/try/finally/catch
#   bodies, labelled statements (foo: / case 1: / default:), statement-start blocks (after ;
#   or a previous block }), and TypeScript type T = { ... } are statement blocks, so a
#   following / may be a regex. ?? and ?. do not arm the ternary colon. class/function bodies
#   are expression-braced when the keyword appears in expression position (including async
#   function), so (class {} / 2) and (function () {} / 2) are division; statements and
#   export default (incl. default async) keep } as a statement boundary (regex ok).
#   Other ambiguous } stay statement-boundary / fail-closed. Non-ASCII UTF-8 identifier bytes
#   are treated as ident so non-ASCII / 2 is division;
# - text inside any quote is preserved (SQL/template markers are real code); template text
#   honours backslash escapes (so a backslash-backtick does not close and a backslash-${ does
#   not open a substitution), matching the string-literal escape rule. Comment text is
#   discarded but lines are kept, so a multi-line /* ... */ block cannot smuggle markers and an
#   anchored pattern still sees one code line per source line. A comment-only release cannot pass.
# - a file still inside a template or block comment at EOF is unreadable and refused.
standby_relay_has_code() {
  file=$1
  mode=$2
  marker=$3
  # LC_ALL=C: BSD awk regex calls towc() under UTF-8 locales and aborts on the Chinese
  # template text in dispatcher.ts; byte mode keeps the scanner ASCII-stable. Apostrophes are
  # forbidden inside this single-quoted awk program (they would end the shell string).
  LC_ALL=C awk -v mode="$mode" -v marker="$marker" '
    BEGIN {
      escape = sprintf("%c", 92); dq = sprintf("%c", 34); sq = sprintf("%c", 39); bt = sprintf("%c", 96)
      del = sprintf("%c", 127)
      letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
      id_start = letters "_$"
      digits = "0123456789"
      id_cont = id_start digits
      flags = "abcdefghijklmnopqrstuvwxyz"
      # prev_kind: "" | op | kw | arrow | ifparen | ident | num | tend
      prev_kind = ""
      word = ""
      last_kw = ""
      paren_stack = ""
      brace_stack = ""
      after_dot = 0
      stmt_boundary = 1
      pending_fn_expr = 0
      pending_async = 0
      async_before = ""
      async_before_kw = ""
      async_stmt = 0
      label_colon = 0
      saw_question = 0
      pending_case = 0
      pending_type = 0
      tpl_depth = 0
      in_tpl_text = 0
      brace_depth = 0
      bstack_n = 0
    }
    function is_id_start(c) { return index(id_start, c) > 0 || c > del }
    function is_digit(c) { return index(digits, c) > 0 }
    function is_id_cont(c) { return index(id_cont, c) > 0 || c > del }
    function is_flag(c) { return index(flags, c) > 0 }
    function in_for_head() {
      return (length(paren_stack) > 0 && substr(paren_stack, length(paren_stack), 1) == "f")
    }
    function flush_word(   w, before, before_kw, before_stmt) {
      w = word; word = ""
      if (w == "") return
      before = prev_kind; before_kw = last_kw; before_stmt = stmt_boundary
      if (after_dot) {
        prev_kind = "ident"; last_kw = ""; after_dot = 0; stmt_boundary = 0; pending_async = 0
        return
      }
      # in is an ES reserved binary operator everywhere; of is only a keyword in a for head
      # (a bare of stays ident so "const of = 4; of / 2" is division).
      if (w == "in") {
        prev_kind = "kw"; last_kw = w; pending_fn_expr = 0; pending_async = 0
      } else if (w == "of" && in_for_head()) {
        prev_kind = "kw"; last_kw = w; pending_fn_expr = 0; pending_async = 0
      } else if (w == "return" || w == "typeof" || w == "instanceof" || w == "new" || w == "delete" || w == "void" || w == "throw" || w == "do" || w == "else" || w == "yield" || w == "await") {
        prev_kind = "kw"; last_kw = w; pending_fn_expr = 0; pending_async = 0
      } else if (w == "case" || w == "default") {
        # case/default introduce a labelled clause; the next : is a case label, not a ternary.
        prev_kind = "kw"; last_kw = w; pending_fn_expr = 0; pending_async = 0; pending_case = 1
      } else if (w == "type" && (before_stmt || before == "" || before == "ident" || before == "tend" || before == "num")) {
        # TypeScript type alias: type T = { ... } ends as a statement boundary.
        # before=ident/tend/num covers ASI after a previous statement without a semicolon.
        prev_kind = "ident"; last_kw = ""; pending_type = 1; pending_fn_expr = 0; pending_async = 0
      } else if (w == "async") {
        # Remember where async appeared: async function in expression position is an expression.
        # export default async function is a declaration (same as export default function).
        async_before = before; async_before_kw = before_kw; async_stmt = before_stmt
        pending_async = 1; pending_fn_expr = 0
        prev_kind = "ident"; last_kw = ""
      } else if (w == "function" || w == "class") {
        # Expression position (after = / : / , / ( / => / keyword) → body } ends a primary.
        # Statement boundary, or after export default (incl. default async), → declaration.
        if (pending_async) {
          if (async_before_kw == "default") pending_fn_expr = 0
          else if (async_stmt == 0 && (async_before == "op" || async_before == "kw" || async_before == "arrow" || async_before == "ifparen")) pending_fn_expr = 1
          else pending_fn_expr = 0
          pending_async = 0
        } else if (before_kw == "default") {
          pending_fn_expr = 0
        } else if (before_stmt == 0 && (before == "op" || before == "kw" || before == "arrow" || before == "ifparen")) {
          pending_fn_expr = 1
        } else {
          pending_fn_expr = 0
        }
        prev_kind = "kw"; last_kw = w
      } else if (w == "try" || w == "finally" || w == "catch") {
        # Block keywords: their { ... } body is a statement block, never an object literal.
        prev_kind = "kw"; last_kw = w; pending_fn_expr = 0; pending_async = 0
      } else if (w == "if" || w == "while" || w == "for" || w == "with" || w == "switch") {
        prev_kind = "ident"; last_kw = w; pending_fn_expr = 0; pending_async = 0
      } else if (is_digit(substr(w, 1, 1))) {
        prev_kind = "num"; last_kw = ""; pending_fn_expr = 0; pending_async = 0
      } else {
        # Keep pending_fn_expr across the optional name (class Foo / function foo).
        # Keep pending_case across the case value (case 1 / case 'a' / case x).
        # Keep pending_type across the alias name (type T).
        prev_kind = "ident"; last_kw = ""; pending_async = 0
      }
      stmt_boundary = 0
    }
    function can_regex() {
      return (prev_kind == "" || prev_kind == "op" || prev_kind == "kw" || prev_kind == "arrow" || prev_kind == "ifparen")
    }
    function trailing_odd_escapes(s,   n, k, c) {
      n = 0
      for (k = length(s); k >= 1; k--) {
        c = substr(s, k, 1)
        if (c == escape) n++
        else break
      }
      return (n % 2) == 1
    }
    function enter_template() {
      if (tpl_depth > 0 && in_tpl_text == 0 && brace_depth > 0) {
        bstack[++bstack_n] = brace_depth
        brace_depth = 0
      }
      tpl_depth++
      in_tpl_text = 1
      quote = bt
      template = 1
    }
    function leave_template() {
      tpl_depth--
      quote = ""
      if (tpl_depth == 0) {
        in_tpl_text = 0
        brace_depth = 0
        template = 0
      } else if (bstack_n > 0) {
        brace_depth = bstack[bstack_n]
        delete bstack[bstack_n]
        bstack_n--
        in_tpl_text = 0
        template = 1
      } else {
        in_tpl_text = 1
        quote = bt
        template = 1
      }
      prev_kind = "tend"
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
        # Template text: backslash escapes, ` and ${ are special; everything else is code text.
        if (in_tpl_text && quote == bt) {
          code = code char
          if (char == escape && i < length(line)) {
            # \` does not close; \${ does not open a substitution (same rule as quoted strings).
            code = code next_char
            i++
            continue
          }
          if (char == "$" && next_char == "{") {
            code = code next_char
            i++
            quote = ""
            in_tpl_text = 0
            brace_depth = 1
            prev_kind = "op"
            last_kw = ""
            after_dot = 0
            continue
          }
          if (char == bt) {
            leave_template()
            last_kw = ""
            after_dot = 0
            stmt_boundary = 0
            continue
          }
          continue
        }
        if (quote != "") {
          code = code char
          if (char == escape && i < length(line)) { code = code next_char; i++; continue }
          if (char == quote) { quote = ""; template = (tpl_depth > 0) ? 1 : 0; prev_kind = "tend" }
          continue
        }
        if (char == bt) {
          flush_word()
          code = code char
          enter_template()
          last_kw = ""
          after_dot = 0
          continue
        }
        if (char == dq || char == sq) {
          flush_word()
          quote = char; code = code char; after_dot = 0; continue
        }
        if (char == "/" && next_char == "/") { flush_word(); break }
        if (char == "/" && next_char == "*") { flush_word(); in_block_comment = 1; i++; continue }
        if (char == "/" && next_char != "" && next_char != "/" && next_char != "*") {
          flush_word()
          if (can_regex()) {
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
              while (j <= length(line) && is_flag(substr(line, j, 1))) j++
              i = j - 1
              prev_kind = "tend"
              last_kw = ""
              after_dot = 0
              continue
            }
          }
        }
        if (is_id_start(char)) {
          word = word char
          code = code char
          continue
        }
        if (is_digit(char)) {
          if (word != "") { word = word char; code = code char; continue }
          flush_word()
          word = char
          while (i + 1 <= length(line) && is_id_cont(substr(line, i + 1, 1))) {
            i++; word = word substr(line, i, 1)
          }
          code = code word
          flush_word()
          after_dot = 0
          continue
        }
        if (char == "=" && next_char == ">") {
          flush_word()
          code = code "=>"
          i++
          prev_kind = "arrow"
          last_kw = ""
          after_dot = 0
          continue
        }
        if (char == "!") {
          flush_word()
          code = code "!"
          if (next_char == "=") {
            prev_kind = "op"
          } else if (prev_kind == "ident" || prev_kind == "num" || prev_kind == "tend") {
            prev_kind = "tend"
          } else {
            prev_kind = "op"
          }
          last_kw = ""
          after_dot = 0
          continue
        }
        if (char == ".") {
          flush_word()
          code = code "."
          prev_kind = "op"
          last_kw = ""
          after_dot = 1
          continue
        }
        if (char == "(") {
          flush_word()
          if (last_kw == "for") paren_stack = paren_stack "f"
          else if (last_kw == "if" || last_kw == "while" || last_kw == "with" || last_kw == "switch") paren_stack = paren_stack "i"
          else paren_stack = paren_stack "n"
          code = code char
          prev_kind = "op"
          last_kw = ""
          after_dot = 0
          label_colon = 0
          continue
        }
        if (char == ")") {
          flush_word()
          head = ""
          if (length(paren_stack) > 0) {
            head = substr(paren_stack, length(paren_stack), 1)
            paren_stack = substr(paren_stack, 1, length(paren_stack) - 1)
          }
          code = code char
          if (head == "i" || head == "f") prev_kind = "ifparen"
          else prev_kind = "tend"
          last_kw = ""
          after_dot = 0
          continue
        }
        if (char == "?") {
          flush_word()
          code = code "?"
          # ?? and ?. are operators, not a ternary lead-in. Only a lone ? sets saw_question.
          if (next_char == "?" || next_char == ".") {
            code = code next_char
            i++
            saw_question = 0
          } else {
            saw_question = 1
          }
          prev_kind = "op"
          last_kw = ""
          after_dot = 0
          stmt_boundary = 0
          continue
        }
        if (char == ":") {
          flush_word()
          code = code ":"
          # A label (foo: / case 1: / default:) takes a statement body; object properties and
          # ternaries do not. pending_case covers case/default values that are not idents.
          if (saw_question) { saw_question = 0; label_colon = 0; pending_case = 0 }
          else if (pending_case) { label_colon = 1; pending_case = 0 }
          else if (prev_kind == "ident" && (length(brace_stack) == 0 || substr(brace_stack, length(brace_stack), 1) != "e")) label_colon = 1
          else label_colon = 0
          prev_kind = "op"
          last_kw = ""
          after_dot = 0
          stmt_boundary = 0
          continue
        }
        if (char == "]") {
          flush_word()
          code = code "]"
          prev_kind = "tend"
          last_kw = ""
          after_dot = 0
          continue
        }
        if (char == "}") {
          flush_word()
          code = code "}"
          if (tpl_depth > 0 && in_tpl_text == 0 && brace_depth > 0) {
            brace_depth--
            if (brace_depth == 0) {
              quote = bt
              in_tpl_text = 1
              template = 1
              prev_kind = "tend"
              last_kw = ""
              after_dot = 0
              continue
            }
            prev_kind = "tend"
            last_kw = ""
            after_dot = 0
            continue
          }
          kind = "s"
          if (length(brace_stack) > 0) {
            kind = substr(brace_stack, length(brace_stack), 1)
            brace_stack = substr(brace_stack, 1, length(brace_stack) - 1)
          }
          # Object/class/function-expr } ends a primary (division); block } is a statement boundary.
          if (kind == "e") { prev_kind = "tend"; stmt_boundary = 0 }
          else { prev_kind = "op"; stmt_boundary = 1; saw_question = 0 }
          last_kw = ""
          after_dot = 0
          continue
        }
        if (char == "{") {
          flush_word()
          code = code "{"
          if (tpl_depth > 0 && in_tpl_text == 0 && brace_depth > 0) {
            brace_depth++
          } else if (pending_fn_expr) {
            brace_stack = brace_stack "e"
            pending_fn_expr = 0
          } else if (prev_kind == "arrow") {
            # () => {} is a block body; () => ({}) uses a paren so prev is op.
            brace_stack = brace_stack "s"
          } else if (last_kw == "else" || last_kw == "do" || last_kw == "try" || last_kw == "finally" || last_kw == "catch" || label_colon) {
            # else/do/try/finally/catch bodies and labelled statements are statement blocks.
            brace_stack = brace_stack "s"
          } else if (stmt_boundary) {
            # A block that starts a statement (after ; or a previous block }) is never an object.
            brace_stack = brace_stack "s"
          } else if (pending_type) {
            # type T = { ... } — type literal ends as a statement boundary.
            brace_stack = brace_stack "s"
            pending_type = 0
          } else if (prev_kind == "op" || prev_kind == "kw") {
            brace_stack = brace_stack "e"
          } else {
            brace_stack = brace_stack "s"
          }
          prev_kind = "op"
          last_kw = ""
          after_dot = 0
          label_colon = 0
          stmt_boundary = 0
          continue
        }
        if (char == ";") {
          flush_word()
          code = code ";"
          prev_kind = "op"
          last_kw = ""
          after_dot = 0
          stmt_boundary = 1
          pending_fn_expr = 0
          label_colon = 0
          saw_question = 0
          pending_case = 0
          pending_type = 0
          continue
        }
        if (char == "[" || char == "," || char == "~" || char == "^" || char == "%" || char == "*" || char == "+" || char == "-" || char == "<" || char == ">" || char == "|" || char == "&" || char == "=") {
          flush_word()
          if ((char == "+" || char == "-" || char == "|" || char == "&" || char == "=" || char == "<" || char == ">") && next_char == char) {
            code = code char next_char
            i++
            if (char == "+" || char == "-") prev_kind = "tend"
            else prev_kind = "op"
          } else {
            code = code char
            prev_kind = "op"
          }
          last_kw = ""
          after_dot = 0
          stmt_boundary = 0
          continue
        }
        if (char == " " || char == "\t") {
          flush_word()
          code = code char
          continue
        }
        flush_word()
        code = code char
        prev_kind = "op"
        last_kw = ""
        after_dot = 0
      }
      flush_word()
      if (quote != "" && in_tpl_text == 0 && quote != bt) {
        if (!trailing_odd_escapes(line)) quote = ""
      }
      if ((mode == "pattern" && code ~ marker) || (mode != "pattern" && index(code, marker))) found = 1
    }
    END {
      if (tpl_depth > 0 || in_block_comment) exit 1
      exit(found ? 0 : 1)
    }
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
