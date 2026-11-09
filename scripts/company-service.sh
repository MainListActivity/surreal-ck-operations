#!/bin/sh
set -eu

# Manages user launchd services from one immutable release:
#   org.surrealck.company-mcp         MCP task service + GitHub projection (the default)
#   org.surrealck.company-dispatcher  legacy standalone dispatcher; the Paseo plugin `sck-company`
#                                     now runs dispatching, so installing it too double-dispatches
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
domain="gui/$(id -u)"
action=${1:-}
components=${SCK_COMPONENTS:-mcp}
. "$(dirname "$0")/release-content.sh"
. "$(dirname "$0")/acceptance-guard.sh"

label() { echo "org.surrealck.company-$1"; }

# launchctl bootout is asynchronous; bootstrapping before the old job is gone fails with EIO.
unload() {
  launchctl bootout "$domain/$(label "$1")" 2>/dev/null || true
  i=0
  while launchctl print "$domain/$(label "$1")" >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
}
plist() { echo "$HOME/Library/LaunchAgents/$(label "$1").plist"; }

write_plist() {
  SERVICE_HOME="$service_home" PLIST="$(plist "$1")" LABEL="$(label "$1")" COMPONENT="$1" /usr/bin/python3 - <<'PY'
import os, plistlib
from pathlib import Path
home = Path(os.environ['SERVICE_HOME'])
component = os.environ['COMPONENT']
suffix = '' if component == 'mcp' else f'-{component}'
payload = {
    'Label': os.environ['LABEL'],
    'ProgramArguments': [str(home / 'bin/run.sh'), component],
    'RunAtLoad': True,
    'KeepAlive': True,
    'StandardOutPath': str(home / f'logs/stdout{suffix}.log'),
    'StandardErrorPath': str(home / f'logs/stderr{suffix}.log'),
    # Background QoS throttles Bun.password.verify (argon2) ~500x — every valid
    # credential would take ~60s to authenticate and every request would hang.
    'ProcessType': 'Adaptive',
}
path = Path(os.environ['PLIST'])
path.write_bytes(plistlib.dumps(payload))
path.chmod(0o600)
PY
}

case "$action" in
  install)
    release=${2:?usage: company-service.sh install /absolute/release/path}
    case "$release" in /*) ;; *) echo 'Release path must be absolute' >&2; exit 1;; esac
    [ -f "$release/src/mcp/run.ts" ] && [ -f "$release/src/dispatcher/run.ts" ] || { echo 'Release is incomplete' >&2; exit 1; }
    [ -f "$service_home/private/service.env" ] || { echo 'Private config is missing' >&2; exit 1; }
    # Deploy gate: releases are cut from merged main only — the directory name is the
    # commit it snapshots and must be reachable from origin/main of the ops repo.
    sha=${release##*/}
    case "$sha" in *[!0-9a-f]*) bad=1;; *) bad=; [ ${#sha} -eq 40 ] || bad=1;; esac
    [ -z "$bad" ] || { echo "refused: release dir '$sha' is not a commit sha — release dirs are named releases/<main commit>" >&2; exit 1; }
    ops_repo=${SCK_OPS_REPO:-$(/usr/bin/sed -n 's/^SCK_AGENT_CWD=//p' "$service_home/private/service.env" | /usr/bin/tr -d "\"'")}
    [ -n "$ops_repo" ] && [ -d "$ops_repo/.git" ] || { echo "refused: cannot verify release — set SCK_OPS_REPO to the ops checkout" >&2; exit 1; }
    git -C "$ops_repo" fetch origin main --quiet 2>/dev/null || echo "warning: git fetch failed; checking against last-known origin/main" >&2
    git -C "$ops_repo" merge-base --is-ancestor "$sha" origin/main 2>/dev/null || {
      echo "refused: $sha is not on origin/main — merge the change into main first, then cut the release from main HEAD" >&2; exit 1; }
    # The name only says which commit this claims to be: the content must be that commit's (SYS01 AC-B, review B2). A directory
    # named after a real commit but holding other code is refused here, before anything is switched.
    release_matches_commit "$release" "$sha" "$ops_repo" || {
      echo "refused: $release does not match commit $sha — cut the release from 'git archive $sha' (dependencies and vendor are prepared after), then install again" >&2; exit 1; }
    acceptance_target_supported "$release" || { acceptance_refuse "$release"; exit 1; }
    mkdir -p "$service_home/bin" "$service_home/logs" "$HOME/Library/LaunchAgents"
    chmod 700 "$service_home" "$service_home/bin" "$service_home/logs" "$service_home/private"
    # 老板令牌：不存在时生成（0600），供编制外 agent 通过 owner CLI / HTTP 接口代老板操作。
    if [ ! -s "$service_home/private/owner-token" ]; then
      /usr/bin/openssl rand -base64 32 | /usr/bin/tr -d '\n' | /usr/bin/sed 's/^/sck_/' > "$service_home/private/owner-token"
      printf '\n' >> "$service_home/private/owner-token"
    fi
    chmod 600 "$service_home/private/owner-token"
    cp "$(dirname "$0")/run-service.sh" "$service_home/bin/run.sh"
    # Keep the already-installed provider wrapper current without changing daemon configuration.
    if [ -d "$service_home/sandbox" ]; then
      install -m 0755 "$release/scripts/sandbox/launch.sh" "$service_home/sandbox/launch.sh"
      sh "$release/scripts/sandbox/build-ps.sh" "$service_home/sandbox" || echo "warning: sandbox ps shim build failed" >&2
    fi
    cp "$(dirname "$0")/sck.sh" "$service_home/bin/sck"
    cp "$(dirname "$0")/bun-runtime.sh" "$service_home/bin/bun-runtime.sh"
    chmod 700 "$service_home/bin/run.sh" "$service_home/bin/sck" "$service_home/bin/bun-runtime.sh"

    prev_release=""
    if [ -L "$service_home/active" ]; then prev_release=$(readlink "$service_home/active"); fi
    ln -s "$release" "$service_home/active.next"
    # rename(2) swaps the symlink atomically without following it; `mv -h` is
    # BSD-only and GNU `mv` would dereference the destination symlink instead.
    RELEASE_LINK="$service_home/active" NEXT_LINK="$service_home/active.next" /usr/bin/python3 - <<'PY'
import os
os.rename(os.environ['NEXT_LINK'], os.environ['RELEASE_LINK'])
PY
    for c in $components; do
      write_plist "$c"
      unload "$c"
      launchctl bootstrap "$domain" "$(plist "$c")"
    done
    # Release retention: snapshots run ~300MB each and used to accumulate without
    # bound (100 dirs ≈ 30GB filled the disk once already). Event-point cleanup —
    # after a successful install keep exactly: this release, the release it
    # replaced (rollback), the currently registered plugin source, and the newest
    # other snapshot as a spare. SCK_RELEASE_KEEP overrides the spare count.
    releases_dir="$service_home/releases"
    keep=" ${release##*/} ${prev_release##*/} "
    PASEO="${PASEO:-/Applications/Paseo.app/Contents/Resources/bin/paseo}"
    if [ -x "$PASEO" ]; then
      if plugin_json=$("$PASEO" plugin ls sck-company --json 2>/dev/null); then
        if cur_src=$(printf '%s\n' "$plugin_json" | /usr/bin/python3 -c '
import json, sys
rows = json.load(sys.stdin) or []
print(((rows[0].get("installation") or {}).get("identity") or {}).get("path", "") if rows else "")' 2>/dev/null); then
          case "$cur_src" in "$releases_dir"/*/plugin) keep="$keep $(basename "$(dirname "$cur_src")") ";; esac
          spare=${SCK_RELEASE_KEEP:-1}
          valid_spare=1
          case "$spare" in
            ''|*[!0-9]*)
              echo "warning: invalid SCK_RELEASE_KEEP='$spare'; skipping release pruning" >&2
              valid_spare=0
              ;;
          esac
          if [ "$valid_spare" -eq 1 ]; then
            spare=$(printf '%s' "$spare" | /usr/bin/sed 's/^0*//')
            [ -n "$spare" ] || spare=0
            # Emit only validated basenames so command substitution cannot split the
            # default macOS service path at its spaces.
            if release_names=$(/usr/bin/python3 - "$releases_dir" <<'PY'
import os
import re
import sys

root = sys.argv[1]
entries = []
try:
    with os.scandir(root) as children:
        for child in children:
            if not re.fullmatch(r'[0-9a-f]{40}', child.name):
                continue
            try:
                if child.is_symlink() or not child.is_dir(follow_symlinks=False):
                    continue
                entries.append((child.stat(follow_symlinks=False).st_mtime, child.name))
            except OSError:
                continue
except OSError:
    raise SystemExit(1)

for _, name in sorted(entries, key=lambda item: (-item[0], item[1])):
    print(name)
PY
          ); then
            for b in $release_names; do
              case "$keep" in *" $b "*) continue;; esac
              d="$releases_dir/$b"
              [ -d "$d" ] && [ ! -L "$d" ] || continue
              [ -f "$d/src/mcp/run.ts" ] && [ -f "$d/src/dispatcher/run.ts" ] && [ -d "$d/plugin" ] || {
                echo "release retained: $b (incomplete snapshot)" >&2
                continue
              }
              # Git worktrees remain protected; reclaim them through worktree
              # lifecycle tooling instead of deleting their registered directory.
              [ ! -e "$d/.git" ] || { echo "release retained: $b (registered Git worktree)" >&2; continue; }
              # A running daemon may still hold a cwd, executable, or file under
              # an older release. Treat an unavailable or indeterminate lsof
              # check as a reason to retain rather than risk deleting live code.
              if lsof_bin=$(command -v lsof 2>/dev/null); then
                lsof_status=0
                "$lsof_bin" +D "$d" >/dev/null 2>&1 || lsof_status=$?
                case "$lsof_status" in
                  0) echo "release retained: $b (open file handle)" >&2; continue ;;
                  1) : ;;
                  *) echo "release retained: $b (unable to verify open file handles)" >&2; continue ;;
                esac
              else
                echo "release retained: $b (lsof unavailable)" >&2
                continue
              fi
              if [ "$spare" -gt 0 ]; then spare=$((spare - 1)); keep="$keep $b "; continue; fi
              if rm -rf "$d" && [ ! -e "$d" ]; then
                echo "release pruned: $b"
              else
                echo "warning: failed to prune release: $b" >&2
              fi
            done
          else
            echo "warning: unable to enumerate releases; skipping release pruning" >&2
          fi
          else
            echo "warning: invalid SCK_RELEASE_KEEP; skipping release pruning" >&2
          fi
        else
          echo "warning: invalid sck-company plugin metadata; skipping release pruning" >&2
        fi
      else
        echo "warning: unable to query sck-company plugin source; skipping release pruning" >&2
      fi
    else
      echo "warning: Paseo CLI is unavailable; skipping release pruning" >&2
    fi
    ;;
  start)
    for c in $components; do launchctl bootstrap "$domain" "$(plist "$c")"; done
    ;;
  stop)
    for c in $components; do unload "$c"; done
    ;;
  restart)
    for c in $components; do launchctl kickstart -k "$domain/$(label "$c")"; done
    ;;
  status)
    for c in $components; do
      echo "== $(label "$c")"
      launchctl print "$domain/$(label "$c")" | /usr/bin/grep -E 'state =|pid =|last exit code =' || echo 'not loaded'
    done
    ;;
  uninstall)
    for c in $components; do
      unload "$c"
      rm -f "$(plist "$c")"
    done
    ;;
  *)
    echo 'usage: company-service.sh install <release> | start | stop | restart | status | uninstall  (SCK_COMPONENTS=mcp by default; "mcp dispatcher" only for the legacy standalone dispatcher)' >&2
    exit 1
    ;;
esac
