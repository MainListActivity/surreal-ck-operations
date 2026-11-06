#!/bin/sh
# Employee tool entry: SCK_EMPLOYEE_CREDENTIAL_FILE=<path> sck call <tool> '<json>' | sck list
set -eu
# The Bun runtime is resolved exactly as the services resolve it (scripts/bun-runtime.sh, installed beside this file as
# bin/bun-runtime.sh): SCK_BUN, then the SCK_BUN line of private/service.env, then runtime-bun, then ~/.bun. PATH is never searched.
. "$(dirname "$0")/bun-runtime.sh"
service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
if [ "${1:-}" = "sync-gate" ]; then
  resolve_bun "$service_home"
  cd "$service_home/active"
  exec "$BUN" src/mcp/sync-gate.ts
fi
# Owner CLI: bin/sck owner <command> '<JSON>' — reads private/owner-token by path, never prints it.
if [ "${1:-}" = "owner" ]; then
  [ -n "${2:-}" ] || { echo 'usage: sck owner <command> <JSON>' >&2; exit 2; }
  command=$2
  payload=${3:-"{}"}
  token_file="$service_home/private/owner-token"
  [ -r "$token_file" ] || { echo 'owner token missing' >&2; exit 1; }
  port=$(/usr/bin/sed -n 's/^SCK_PREVIEW_PORT=//p' "$service_home/private/service.env" 2>/dev/null | /usr/bin/tr -d "\"'")
  port=${port:-18777}
  /usr/bin/python3 -I - "$command" "$payload" "$token_file" "$port" <<'PY'
import json, sys, urllib.request
command, payload, token_file, port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(token_file, "r", encoding="utf-8") as f:
    token = f.readline().strip()
try: args = json.loads(payload)
except ValueError as error:
    print(json.dumps({"ok": False, "error": "invalid JSON: %s" % error}, ensure_ascii=False)); sys.exit(2)
if not isinstance(args, dict): args = {}
args["command"] = command
request = urllib.request.Request("http://127.0.0.1:%s/api/owner/%s" % (port, command),
    data=json.dumps(args, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token,
             "X-Owner-Agent": __import__("os").environ.get("SCK_OWNER_AGENT", "cli")}, method="POST")
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        print(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    print(error.read().decode("utf-8")); sys.exit(1)
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False)); sys.exit(1)
PY
  exit $?
fi
# Spawn env is one-shot: Paseo strips SCK_COMM_* on session resume/refresh, but
# always re-injects PASEO_AGENT_ID. The sidecar's pointer file also carries the
# freshest channel key across plugin restarts (adopt() re-keys channels), so it
# takes precedence over whatever env the process was spawned with.
if [ -n "${PASEO_AGENT_ID:-}" ] && [ -f "$service_home/comm-agents/$PASEO_AGENT_ID" ]; then
  SCK_COMM_DIR=$(/usr/bin/sed -n '1p' "$service_home/comm-agents/$PASEO_AGENT_ID")
  SCK_COMM_KEY=$(/usr/bin/sed -n '2p' "$service_home/comm-agents/$PASEO_AGENT_ID")
  export SCK_COMM_DIR SCK_COMM_KEY
fi
# Comm mode: the plugin sidecar owns the credential; the agent relays through
# $SCK_COMM_DIR and carries no auth material at all.
if [ -n "${SCK_COMM_DIR:-}" ]; then
  resolve_bun "$service_home"
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
resolve_bun "$service_home"
exec "$BUN" src/mcp/client-cli.ts "$@"
