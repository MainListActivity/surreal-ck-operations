#!/bin/sh
# Employee tool entry: SCK_EMPLOYEE_CREDENTIAL_FILE=<path> sck call <tool> '<json>' | sck list
set -eu
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
if [ "${1:-}" = "sync-gate" ]; then
  BUN="${SCK_BUN:-$service_home/runtime-bun/bin/bun}"
  [ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
  cd "$service_home/active"
  exec "$BUN" src/mcp/sync-gate.ts
fi
# Comm mode: the plugin sidecar owns the credential; the agent relays through
# $SCK_COMM_DIR and carries no auth material at all.
if [ -n "${SCK_COMM_DIR:-}" ]; then
  BUN="${SCK_BUN:-$service_home/runtime-bun/bin/bun}"
  [ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
  cd "$service_home/active"
  exec "$BUN" src/mcp/client-cli.ts "$@"
fi
: "${SCK_EMPLOYEE_CREDENTIAL_FILE:?SCK_EMPLOYEE_CREDENTIAL_FILE is required}"
port=$(/usr/bin/sed -n 's/^SCK_MCP_PORT=//p' "$service_home/private/service.env" | /usr/bin/tr -d "\"'")
# Remote endpoint override: written by `sck sync-gate` (private/mcp-remote.env, mode 600);
# presence switches all sck callers to the public MCP endpoint.
remote_env="$service_home/private/mcp-remote.env"
if [ -z "${SCK_MCP_URL:-}" ] && [ -f "$remote_env" ]; then
  set -a; . "$remote_env"; set +a
fi
SCK_MCP_URL=${SCK_MCP_URL:-"http://127.0.0.1:${port:-38473}/mcp"}
export SCK_MCP_URL SCK_MCP_TOKEN SCK_EMPLOYEE_CREDENTIAL_FILE
cd "$service_home/active"
# Global ~/.bun (1.3.11) has a broken stream/SSE client that leaves calls hanging;
# the service-pinned runtime is the same build the server runs on.
BUN="${SCK_BUN:-$service_home/runtime-bun/bin/bun}"
[ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
exec "$BUN" src/mcp/client-cli.ts "$@"
