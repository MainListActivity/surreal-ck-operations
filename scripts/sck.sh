#!/bin/sh
# Employee tool entry: SCK_EMPLOYEE_CREDENTIAL_FILE=<path> sck call <tool> '<json>' | sck list
set -eu
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
: "${SCK_EMPLOYEE_CREDENTIAL_FILE:?SCK_EMPLOYEE_CREDENTIAL_FILE is required}"
port=$(/usr/bin/sed -n 's/^SCK_MCP_PORT=//p' "$service_home/private/service.env" | /usr/bin/tr -d "\"'")
SCK_MCP_URL=${SCK_MCP_URL:-"http://127.0.0.1:${port:-38473}/mcp"}
export SCK_MCP_URL SCK_EMPLOYEE_CREDENTIAL_FILE
cd "$service_home/active"
# Global ~/.bun (1.3.11) has a broken stream/SSE client that leaves calls hanging;
# the service-pinned runtime is the same build the server runs on.
BUN="${SCK_BUN:-$service_home/runtime-bun/bin/bun}"
[ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
exec "$BUN" src/mcp/client-cli.ts "$@"
