#!/bin/sh
set -eu

label=org.surrealck.company-mcp
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
plist="$HOME/Library/LaunchAgents/$label.plist"
target="gui/$(id -u)/$label"
action=${1:-}

case "$action" in
  install)
    release=${2:?usage: company-service.sh install /absolute/release/path}
    case "$release" in /*) ;; *) echo 'Release path must be absolute' >&2; exit 1;; esac
    [ -f "$release/src/mcp/run.ts" ] || { echo 'Release is incomplete' >&2; exit 1; }
    [ -f "$service_home/private/service.env" ] || { echo 'Private config is missing' >&2; exit 1; }
    mkdir -p "$service_home/bin" "$service_home/logs" "$HOME/Library/LaunchAgents"
    chmod 700 "$service_home" "$service_home/bin" "$service_home/logs" "$service_home/private"
    cp "$(dirname "$0")/run-service.sh" "$service_home/bin/run.sh"
    chmod 700 "$service_home/bin/run.sh"
    ln -s "$release" "$service_home/active.next"
    mv -h -f "$service_home/active.next" "$service_home/active"
    SERVICE_HOME="$service_home" PLIST="$plist" LABEL="$label" /usr/bin/python3 - <<'PY'
import os, plistlib
from pathlib import Path
home = Path(os.environ['SERVICE_HOME'])
payload = {
    'Label': os.environ['LABEL'],
    'ProgramArguments': [str(home / 'bin/run.sh')],
    'RunAtLoad': True,
    'KeepAlive': True,
    'StandardOutPath': str(home / 'logs/stdout.log'),
    'StandardErrorPath': str(home / 'logs/stderr.log'),
    'ProcessType': 'Background',
}
path = Path(os.environ['PLIST'])
path.write_bytes(plistlib.dumps(payload))
path.chmod(0o600)
PY
    launchctl bootout "$target" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ;;
  start)
    launchctl bootstrap "gui/$(id -u)" "$plist"
    ;;
  stop)
    launchctl bootout "$target"
    ;;
  restart)
    launchctl kickstart -k "$target"
    ;;
  status)
    launchctl print "$target" | /usr/bin/grep -E 'state =|pid =|last exit code =|program =|path ='
    ;;
  uninstall)
    launchctl bootout "$target" 2>/dev/null || true
    rm -f "$plist"
    ;;
  *)
    echo 'usage: company-service.sh install <release> | start | stop | restart | status | uninstall' >&2
    exit 1
    ;;
esac
