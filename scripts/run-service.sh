#!/bin/sh
set -eu

component=${1:-mcp}
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
config="$service_home/private/service.env"
if [ ! -f "$config" ]; then
  echo 'Service configuration is missing' >&2
  exit 1
fi
set -a
. "$config"
set +a
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.bun/bin:$PATH"
export PATH
cd "$service_home/active"
case "$component" in
  mcp)
    if [ -n "${SCK_GITHUB_REPOSITORY:-}" ]; then
      command -v gh >/dev/null || { echo 'GitHub CLI is unavailable to the service' >&2; exit 1; }
    fi
    exec /Users/y/.bun/bin/bun src/mcp/run.ts
    ;;
  dispatcher)
    SCK_CREDENTIAL_DIR=${SCK_CREDENTIAL_DIR:-"$service_home/private/credentials"}
    SCK_TOOL_BIN=${SCK_TOOL_BIN:-"$service_home/bin/sck"}
    export SCK_CREDENTIAL_DIR SCK_TOOL_BIN
    : "${SCK_AGENT_CWD:?SCK_AGENT_CWD must be set in service.env}"
    exec /usr/bin/caffeinate -i /Users/y/.bun/bin/bun src/dispatcher/run.ts
    ;;
  *)
    echo "unknown component: $component" >&2
    exit 1
    ;;
esac
