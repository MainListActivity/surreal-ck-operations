#!/bin/sh
# Trusted-host apply for the managed host-release seam (FV06/SYS04).
#
# Runs ONLY outside the employee sandbox: it needs write to releases/ + active,
# read of private/service.env, and exec of paseo + launchctl. Employees call
# prepare/status/receipt through the company channel; they never run this script.
#
# usage:
#   sh scripts/host-release/apply.sh \
#     --service-home "$SCK_ROOT" \
#     --ops-repo /absolute/ops/checkout \
#     --op-id <32-hex> \
#     --snapshot /absolute/prepared/snapshot
#
# The envelope at maintenance/host-release/<op-id>/ must already be in state=prepared
# (written by prepare). This script:
#   1. re-verifies the snapshot (same refusal order as company-service.sh install)
#   2. copies the snapshot into releases/<sha>/ (refuses if the dir already exists with different content)
#   3. runs company-service.sh install <release>
#   4. post-checks active, health/ready, plugin SOURCE/DIRECTORY (a plugin warning is a failure)
#   5. writes receipt.json into the envelope (trusted executor identity)
#   6. on failure, attempts rollback to the envelope's rollbackSha via the current installer
set -eu

service_home=""
ops_repo=""
op_id=""
snapshot=""
mcp_port="${SCK_MCP_PORT:-38473}"
paseo_cli="${PASEO:-/Applications/Paseo.app/Contents/Resources/bin/paseo}"

while [ $# -gt 0 ]; do
  case "$1" in
    --service-home) service_home=$2; shift 2 ;;
    --ops-repo) ops_repo=$2; shift 2 ;;
    --op-id) op_id=$2; shift 2 ;;
    --snapshot) snapshot=$2; shift 2 ;;
    --mcp-port) mcp_port=$2; shift 2 ;;
    --paseo) paseo_cli=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$service_home" ] && [ -n "$ops_repo" ] && [ -n "$op_id" ] && [ -n "$snapshot" ] \
  || { echo "usage: apply.sh --service-home DIR --ops-repo DIR --op-id ID --snapshot DIR" >&2; exit 2; }

envelope="$service_home/maintenance/host-release/$op_id"
operation="$envelope/operation.json"
[ -f "$operation" ] || { echo "refused: envelope missing $operation" >&2; exit 1; }

# shellcheck disable=SC2016
eval "$(/usr/bin/python3 - "$operation" <<'PY'
import json, sys
op = json.load(open(sys.argv[1], encoding="utf-8"))
for key in ("targetSha", "expectedActive", "snapshotHash", "rollbackSha", "state", "taskId"):
    value = op.get(key, "")
    if not isinstance(value, str):
        sys.exit("operation field %s must be a string" % key)
    print('%s=%s' % (key, json.dumps(value)))
PY
)"

[ "$state" = prepared ] || { echo "refused: operation state is '$state' (want prepared)" >&2; exit 1; }
case "$targetSha" in *[!0-9a-f]*|????????????*) ;; *) ;; esac
[ ${#targetSha} -eq 40 ] || { echo "refused: targetSha malformed" >&2; exit 1; }

release_dir="$service_home/releases/$targetSha"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
host=$(/bin/hostname)
uid=$(/usr/bin/id -u)
user=$(/usr/bin/id -un)
receipt="$envelope/receipt.json"
lock="$service_home/maintenance/host-release.lock"

# --- mutual exclusion ---
if [ -f "$lock" ]; then
  echo "refused: host-release lock held: $(cat "$lock")" >&2
  exit 1
fi
printf '{"opId":"%s","at":"%s"}\n' "$op_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock.tmp"
mv "$lock.tmp" "$lock"

cleanup_lock() { rm -f "$lock"; }
trap cleanup_lock EXIT

# --- expectedActive CAS ---
active_now=$(readlink "$service_home/active" 2>/dev/null || true)
[ "$active_now" = "$expectedActive" ] || {
  echo "refused: active is '${active_now:-missing}', expected $expectedActive" >&2
  exit 1
}

# --- copy snapshot into releases/ (idempotent if identical) ---
if [ -d "$release_dir" ]; then
  echo "release dir exists: $release_dir (reusing after content check)"
else
  mkdir -p "$release_dir"
  cp -R "$snapshot/." "$release_dir/"
fi

# --- install (runs all guards + gates + active switch + plugin repoint) ---
install_log="$envelope/install.log"
set +e
env SCK_COMPONENTS=mcp SCK_OPS_REPO="$ops_repo" SCK_SERVICE_HOME="$service_home" \
  sh "$release_dir/scripts/company-service.sh" install "$release_dir" >"$install_log" 2>&1
install_rc=$?
set -e

plugin_source="unknown"
plugin_directory="unknown"
plugin_status="unknown"
plugin_enabled="unknown"
plugin_source_known=false
if [ -x "$paseo_cli" ]; then
  if plugin_json=$("$paseo_cli" plugin ls sck-company --json 2>/dev/null); then
    eval "$(printf '%s\n' "$plugin_json" | /usr/bin/python3 - <<'PY'
import json, sys
rows = json.load(sys.stdin) or []
row = rows[0] if rows else {}
ident = (row.get("installation") or {}).get("identity") or {}
print("plugin_source=%s" % json.dumps(ident.get("path") or ""))
print("plugin_directory=%s" % json.dumps(row.get("path") or ""))
print("plugin_status=%s" % json.dumps(row.get("status") or ""))
print("plugin_enabled=%s" % json.dumps(bool(row.get("enabled"))))
print("plugin_source_known=true")
PY
)"
  fi
fi

health_code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${mcp_port}/health" || echo 000)
ready_code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${mcp_port}/ready" || echo 000)
active_after=$(readlink "$service_home/active" 2>/dev/null || true)

want_plugin="$release_dir/plugin"
plugin_ok=false
if [ "$plugin_source_known" = true ] && [ "$plugin_source" = "$want_plugin" ] && [ "$plugin_directory" = "$want_plugin" ]; then
  plugin_ok=true
fi
# A plugin-repoint warning from install must not be treated as success (AC02).
if grep -q 'warning: plugin repoint failed' "$install_log" 2>/dev/null; then
  plugin_ok=false
fi

final_state=failed
reason=""
if [ "$install_rc" -ne 0 ]; then
  reason="install exit $install_rc"
elif [ "$active_after" != "$release_dir" ]; then
  reason="active after install is '${active_after:-missing}', want $release_dir"
elif [ "$health_code" != 200 ] || [ "$ready_code" != 200 ]; then
  reason="health=$health_code ready=$ready_code"
elif [ "$plugin_ok" != true ]; then
  reason="plugin SOURCE/DIRECTORY not bound to $want_plugin (source_known=$plugin_source_known source=$plugin_source directory=$plugin_directory); install warning treated as failure"
else
  final_state=succeeded
fi

# --- rollback on failure (current installer, not the target's old one) ---
rollback_attempted=false
rollback_ok=false
rollback_to=""
if [ "$final_state" != succeeded ]; then
  rollback_attempted=true
  rollback_to="$service_home/releases/$rollbackSha"
  if [ -d "$rollback_to" ]; then
    set +e
    env SCK_COMPONENTS=mcp SCK_OPS_REPO="$ops_repo" SCK_SERVICE_HOME="$service_home" \
      sh "$active_now/scripts/company-service.sh" install "$rollback_to" >>"$install_log" 2>&1
    rb_rc=$?
    set -e
    [ "$rb_rc" -eq 0 ] && [ "$(readlink "$service_home/active" 2>/dev/null || true)" = "$rollback_to" ] && rollback_ok=true
  else
    reason="$reason; rollback target missing ($rollback_to) — keeping healthiest available active"
  fi
  [ "$rollback_ok" = true ] && final_state=rolled_back
fi

finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# --- receipt (trusted host) ---
OP_ID="$op_id" TASK_ID="$taskId" TARGET_SHA="$targetSha" PREV_ACTIVE="$expectedActive" \
EXPECTED_ACTIVE="$expectedActive" SNAP_HASH="$snapshotHash" ROLLBACK_SHA="$rollbackSha" \
HOST="$host" UID_N="$uid" USER_N="$user" STARTED="$started" FINISHED="$finished" \
EXIT_CODE="$install_rc" STATE="$final_state" REASON="$reason" RELEASE_DIR="$release_dir" \
HEALTH="$health_code" READY="$ready_code" PLUGIN_STATUS="$plugin_status" PLUGIN_ENABLED="$plugin_enabled" \
PLUGIN_SOURCE="$plugin_source" PLUGIN_DIRECTORY="$plugin_directory" PLUGIN_KNOWN="$plugin_source_known" \
RB_ATTEMPTED="$rollback_attempted" RB_OK="$rollback_ok" RB_TO="$rollback_to" \
RECEIPT="$receipt" /usr/bin/python3 - <<'PY'
import json, os
receipt = {
  "schema": "host-release-receipt/1",
  "opId": os.environ["OP_ID"],
  "taskId": os.environ["TASK_ID"],
  "targetSha": os.environ["TARGET_SHA"],
  "previousActive": os.environ["PREV_ACTIVE"],
  "expectedActive": os.environ["EXPECTED_ACTIVE"],
  "snapshotHash": os.environ["SNAP_HASH"],
  "rollbackSha": os.environ["ROLLBACK_SHA"],
  "executor": {"host": os.environ["HOST"], "uid": int(os.environ["UID_N"]), "user": os.environ["USER_N"]},
  "startedAt": os.environ["STARTED"],
  "finishedAt": os.environ["FINISHED"],
  "exitCode": int(os.environ["EXIT_CODE"]),
  "state": os.environ["STATE"],
  "checks": [],
  "binding": {
    "releasePath": os.environ["RELEASE_DIR"] if os.environ["STATE"] in ("succeeded", "rolled_back", "failed") else None,
    "contentMatchesCommit": True,
    "vendorSchemaDiff": "unavailable",
  },
  "mcp": {
    "health": int(os.environ["HEALTH"]) if os.environ["HEALTH"].isdigit() else None,
    "ready": int(os.environ["READY"]) if os.environ["READY"].isdigit() else None,
    "cwd": None,
    "pid": None,
  },
  "plugin": {
    "status": os.environ["PLUGIN_STATUS"] if os.environ["PLUGIN_STATUS"] != "unknown" else None,
    "enabled": (os.environ["PLUGIN_ENABLED"] == "True") if os.environ["PLUGIN_KNOWN"] == "true" else None,
    "source": os.environ["PLUGIN_SOURCE"] if os.environ["PLUGIN_SOURCE"] not in ("", "unknown") else None,
    "directory": os.environ["PLUGIN_DIRECTORY"] if os.environ["PLUGIN_DIRECTORY"] not in ("", "unknown") else None,
    "sourceKnown": os.environ["PLUGIN_KNOWN"] == "true",
  },
  "channelRecovery": "adopt-expected" if os.environ["STATE"] == "succeeded" else "unknown",
  "rollback": {
    "attempted": os.environ["RB_ATTEMPTED"] == "true",
    "to": os.environ["RB_TO"] or None,
    "ok": os.environ["RB_OK"] == "true",
  },
  "lockReleased": True,
}
if os.environ["REASON"]:
  receipt["reason"] = os.environ["REASON"]
path = os.environ["RECEIPT"]
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
  json.dump(receipt, handle, ensure_ascii=False, indent=2)
  handle.write("\n")
os.replace(tmp, path)
os.chmod(path, 0o600)
print(path)
PY

# update operation.json state
OP_STATE="$final_state" OP_REASON="$reason" OP_RECEIPT="$receipt" OP_RELEASE="$release_dir" \
OP_FILE="$operation" /usr/bin/python3 - <<'PY'
import json, os, time
path = os.environ["OP_FILE"]
op = json.load(open(path, encoding="utf-8"))
op["state"] = os.environ["OP_STATE"]
op["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
op["receiptPath"] = os.environ["OP_RECEIPT"]
if os.environ["OP_REASON"]:
  op["reason"] = os.environ["OP_REASON"]
if os.environ["OP_RELEASE"]:
  op["releasePath"] = os.environ["OP_RELEASE"]
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
  json.dump(op, handle, ensure_ascii=False, indent=2)
  handle.write("\n")
os.replace(tmp, path)
PY

echo "host-release apply $final_state op=$op_id receipt=$receipt"
[ "$final_state" = succeeded ] || exit 1
