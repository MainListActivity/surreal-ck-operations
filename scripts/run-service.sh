#!/bin/sh
set -eu

service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
config="$service_home/private/service.env"
if [ ! -f "$config" ]; then
  echo 'Service configuration is missing' >&2
  exit 1
fi
set -a
. "$config"
set +a
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH
if [ -n "${SCK_GITHUB_REPOSITORY:-}" ]; then
  command -v gh >/dev/null || { echo 'GitHub CLI is unavailable to the service' >&2; exit 1; }
fi
cd "$service_home/active"
exec /Users/y/.bun/bin/bun src/mcp/run.ts
