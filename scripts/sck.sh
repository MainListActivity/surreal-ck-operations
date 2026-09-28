#!/bin/sh
# Employee tool entry: SCK_EMPLOYEE_CREDENTIAL_FILE=<path> sck call <tool> '<json>' | sck list
set -eu
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
: "${SCK_EMPLOYEE_CREDENTIAL_FILE:?SCK_EMPLOYEE_CREDENTIAL_FILE is required}"
port=$(/usr/bin/sed -n 's/^SCK_MCP_PORT=//p' "$service_home/private/service.env" | /usr/bin/tr -d "\"'")
SCK_MCP_URL=${SCK_MCP_URL:-"http://127.0.0.1:${port:-38473}/mcp"}
export SCK_MCP_URL SCK_EMPLOYEE_CREDENTIAL_FILE
cd "$service_home/active"
exec /Users/y/.bun/bin/bun src/mcp/client-cli.ts "$@"
