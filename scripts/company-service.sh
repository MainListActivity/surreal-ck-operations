#!/bin/sh
set -eu

# Manages two user launchd services from one immutable release:
#   org.surrealck.company-mcp         MCP task service + GitHub projection
#   org.surrealck.company-dispatcher  Paseo dispatcher (no LLM polling)
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
domain="gui/$(id -u)"
action=${1:-}
components=${SCK_COMPONENTS:-"mcp dispatcher"}

label() { echo "org.surrealck.company-$1"; }
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
    'ProcessType': 'Background',
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
    mkdir -p "$service_home/bin" "$service_home/logs" "$HOME/Library/LaunchAgents"
    chmod 700 "$service_home" "$service_home/bin" "$service_home/logs" "$service_home/private"
    cp "$(dirname "$0")/run-service.sh" "$service_home/bin/run.sh"
    cp "$(dirname "$0")/sck.sh" "$service_home/bin/sck"
    chmod 700 "$service_home/bin/run.sh" "$service_home/bin/sck"
    ln -s "$release" "$service_home/active.next"
    mv -h -f "$service_home/active.next" "$service_home/active"
    for c in $components; do
      write_plist "$c"
      launchctl bootout "$domain/$(label "$c")" 2>/dev/null || true
      launchctl bootstrap "$domain" "$(plist "$c")"
    done
    ;;
  start)
    for c in $components; do launchctl bootstrap "$domain" "$(plist "$c")"; done
    ;;
  stop)
    for c in $components; do launchctl bootout "$domain/$(label "$c")" || true; done
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
      launchctl bootout "$domain/$(label "$c")" 2>/dev/null || true
      rm -f "$(plist "$c")"
    done
    ;;
  *)
    echo 'usage: company-service.sh install <release> | start | stop | restart | status | uninstall  (SCK_COMPONENTS="mcp dispatcher")' >&2
    exit 1
    ;;
esac
