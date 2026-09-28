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
cd "$service_home/active"
exec /Users/y/.bun/bin/bun src/mcp/run.ts
