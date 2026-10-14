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
    mkdir -p "$service_home/bin" "$service_home/logs" "$HOME/Library/LaunchAgents"
    chmod 700 "$service_home" "$service_home/bin" "$service_home/logs" "$service_home/private"
    cp "$(dirname "$0")/run-service.sh" "$service_home/bin/run.sh"
    cp "$(dirname "$0")/sck.sh" "$service_home/bin/sck"
    chmod 700 "$service_home/bin/run.sh" "$service_home/bin/sck"
    prev_release=""
    if [ -L "$service_home/active" ]; then prev_release=$(readlink "$service_home/active"); fi
    ln -s "$release" "$service_home/active.next"
    mv -h -f "$service_home/active.next" "$service_home/active"
    # Dual-surface sync: the daemon resolves a plugin's registered source once —
    # `plugin reload` does not re-read ~/.paseo/config.json and `plugin install`
    # refuses an existing ID, so repointing is remove + install (a plugin-process
    # restart; sidecar adopt() recovers live channels across it). Only repoint
    # when the registered source lives under this service home.
    PASEO="${PASEO:-/Applications/Paseo.app/Contents/Resources/bin/paseo}"
    if [ -d "$release/plugin" ] && [ -x "$PASEO" ]; then
      want="$release/plugin"
      cur=$("$PASEO" plugin ls sck-company --json 2>/dev/null | /usr/bin/python3 -c '
import json, sys
rows = json.load(sys.stdin) or []
print(((rows[0].get("installation") or {}).get("identity") or {}).get("path", "") if rows else "")')
      case "$cur" in
        "$want") "$PASEO" plugin reload sck-company >/dev/null 2>&1 || true ;;
        "$service_home"*|""|"")
          [ -n "$cur" ] && "$PASEO" plugin remove sck-company >/dev/null 2>&1
          if "$PASEO" plugin install "$want" --id sck-company >/dev/null 2>&1; then
            echo "plugin source -> $want"
          else
            echo "warning: plugin repoint failed; run 'paseo plugin install \"$want\" --id sck-company' manually" >&2
          fi ;;
        *) echo "note: sck-company is registered outside the service home ($cur); leaving it as configured" >&2 ;;
      esac
    fi
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
    cur_src=$("$PASEO" plugin ls sck-company --json 2>/dev/null | /usr/bin/python3 -c '
import json, sys
rows = json.load(sys.stdin) or []
print(((rows[0].get("installation") or {}).get("identity") or {}).get("path", "") if rows else "")' 2>/dev/null)
    case "$cur_src" in "$releases_dir"/*/plugin) keep="$keep $(basename "$(dirname "$cur_src")") ";; esac
    spare=${SCK_RELEASE_KEEP:-1}
    for d in $(ls -td "$releases_dir"/*/ 2>/dev/null); do
      b=${d%/}; b=${b##*/}
      case "$b" in *[!0-9a-f]*) continue;; esac
      [ ${#b} -eq 40 ] || continue
      case "$keep" in *" $b "*) continue;; esac
      if [ "$spare" -gt 0 ]; then spare=$((spare - 1)); keep="$keep $b "; continue; fi
      rm -rf "$d" && echo "release pruned: $b"
    done
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
