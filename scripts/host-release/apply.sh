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

# --- mutual exclusion (R1): O_EXCL create, not check-then-mv ---
# Two concurrent apply.sh must not both win. Python os.open(O_CREAT|O_EXCL) is the portable atomic create.
# Heredoc MUST complete before we inspect $?; `cmd <<'PY' || { … }` is a syntax error (sh -n EOF).
# B3: under `set -e`, a non-zero python exit aborts BEFORE `lock_rc=$?` — capture with set +e.
set +e
LOCK_PATH="$lock" LOCK_OP="$op_id" /usr/bin/python3 - <<'PY'
import json, os, time
path = os.environ["LOCK_PATH"]
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
try:
    fd = os.open(path, flags, 0o600)
except FileExistsError:
    raise SystemExit(1)
try:
    payload = json.dumps({"opId": os.environ["LOCK_OP"], "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, indent=2) + "\n"
    os.write(fd, payload.encode())
finally:
    os.close(fd)
PY
lock_rc=$?
set -e
[ "$lock_rc" -eq 0 ] || {
  echo "refused: host-release lock held or uncreatable: $lock" >&2
  exit 1
}

cleanup_lock() { rm -f "$lock"; }
trap cleanup_lock EXIT

# --- AC03 activity barrier BEFORE side effects (F6/R2) ---
# Fail closed when mirrors declare pause/observation; ignore OUR own lock (we just took it).
# Missing / unreadable / non-boolean mirrors are refused for apply.
# B3: same set +e capture as the lock block — non-zero python must not abort before barrier_rc.
set +e
BARRIER_HOME="$service_home" BARRIER_OP="$op_id" /usr/bin/python3 - <<'PY'
import json, os, sys, time
home = os.environ["BARRIER_HOME"]
op = os.environ["BARRIER_OP"]
now = time.time()
maint = os.path.join(home, "maintenance")
errors = []

def require_bool(path, field, label):
    if not os.path.exists(path):
        errors.append("%s: missing authoritative mirror (apply fail-closed)" % label)
        return
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        errors.append("%s: unreadable (%s)" % (label, e))
        return
    if not isinstance(data, dict) or field not in data:
        errors.append("%s: missing boolean field %s" % (label, field))
        return
    value = data[field]
    if value is not True and value is not False:
        errors.append("%s: %s must be JSON boolean true|false, got %r" % (label, field, value))
        return
    if field == "paused" and value is True:
        errors.append("%s: company dispatch is paused" % label)
    if field == "active":
        if value is True:
            exp = data.get("expiresAt")
            if exp:
                try:
                    from datetime import datetime
                    exp_ts = datetime.fromisoformat(str(exp).replace("Z", "+00:00")).timestamp()
                    if exp_ts <= now:
                        return
                except Exception:
                    errors.append("%s: expiresAt unparsable while active=true" % label)
                    return
            errors.append("%s: active sampling/observation window" % label)

require_bool(os.path.join(maint, "dispatch-paused.json"), "paused", "dispatch-paused")
require_bool(os.path.join(maint, "qa-observation-active.json"), "active", "qa-observation-window")

# Foreign applying envelopes (ignore our own opId).
hr = os.path.join(maint, "host-release")
if os.path.isdir(hr):
    for name in os.listdir(hr):
        if name == op:
            continue
        op_path = os.path.join(hr, name, "operation.json")
        if not os.path.isfile(op_path):
            continue
        try:
            state = json.load(open(op_path, encoding="utf-8")).get("state")
        except Exception:
            continue
        if state == "applying":
            errors.append("concurrent-apply: envelope %s still applying" % name)

# Lock file: only refuse if held by a DIFFERENT opId (we hold it ourselves).
lock_path = os.path.join(maint, "host-release.lock")
if os.path.exists(lock_path):
    try:
        holder = json.load(open(lock_path, encoding="utf-8")).get("opId")
        if holder and holder != op:
            errors.append("host-release-lock: held by %s" % holder)
    except Exception as e:
        errors.append("host-release-lock: unreadable (%s)" % e)

if errors:
    for e in errors:
        print(e, file=sys.stderr)
    raise SystemExit(1)
PY
barrier_rc=$?
set -e
[ "$barrier_rc" -eq 0 ] || {
  echo "refused: activity barrier blocked apply (see above)" >&2
  exit 1
}

# --- expectedActive CAS ---
active_now=$(readlink "$service_home/active" 2>/dev/null || true)
[ "$active_now" = "$expectedActive" ] || {
  echo "refused: active is '${active_now:-missing}', expected $expectedActive" >&2
  exit 1
}

# --- shared inventory digest (one implementation for reuse, source and receipt binding) ---
# Same algorithm as src/host-release/store.ts snapshotInventoryHash: sorted rel paths + sha256 of each
# file, skipping generated/heavy trees. Prints the digest to stdout.
inventory_hash() {
  TARGET="$1" /usr/bin/python3 - <<'PY'
import hashlib, os
root = os.environ["TARGET"]
skip_prefixes = ("node_modules/", "plugin/server/vendor/", ".runtime/", ".git/", "vault/build/")
files = []
for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == ".": rel_dir = ""
    kept = []
    for name in dirnames:
        rel = f"{rel_dir}/{name}" if rel_dir else name
        if any(rel == p[:-1] or rel.startswith(p) for p in skip_prefixes):
            continue
        kept.append(name)
    dirnames[:] = kept
    for name in filenames:
        rel = f"{rel_dir}/{name}" if rel_dir else name
        if any(rel.startswith(p) for p in skip_prefixes):
            continue
        files.append(rel)
files.sort()
lines = []
for rel in files:
    digest = hashlib.sha256(open(os.path.join(root, rel), "rb").read()).hexdigest()
    lines.append(f"{rel}\0{digest}\n")
print(hashlib.sha256("".join(lines).encode()).hexdigest())
PY
}

# --- copy snapshot into releases/ (idempotent only when inventory matches envelope) ---
# Reuse must re-bind envelope.snapshotHash: installer content-bind ≠ inventory hash (F1′).
if [ -d "$release_dir" ]; then
  existing_hash=$(inventory_hash "$release_dir")
  [ "$existing_hash" = "$snapshotHash" ] || {
    echo "refused: existing $release_dir inventory $existing_hash != envelope snapshotHash $snapshotHash" >&2
    exit 1
  }
  echo "release dir exists: $release_dir (reusing; inventory matches envelope.snapshotHash)"
else
  # A fresh copy must also bind the source snapshot to the envelope hash: the installer's
  # release_matches_commit only proves commit-level content, not that this is the prepared tree.
  source_hash=$(inventory_hash "$snapshot")
  [ "$source_hash" = "$snapshotHash" ] || {
    echo "refused: snapshot $snapshot inventory $source_hash != envelope snapshotHash $snapshotHash" >&2
    exit 1
  }
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
    # F0: never pipe into `python - <<'PY'` — the heredoc steals stdin from the pipe.
    # Same algorithm as src/host-release/plugin-parse.ts (unit-tested); kept inline so apply.sh
    # has no bun dependency on the trusted host.
    eval "$(PLUGIN_JSON="$plugin_json" /usr/bin/python3 -c '
import json, os
rows = json.loads(os.environ["PLUGIN_JSON"]) or []
if not isinstance(rows, list):
    raise SystemExit("paseo plugin ls JSON must be an array")
row = rows[0] if rows else {}
ident = (row.get("installation") or {}).get("identity") or {}
print("plugin_source=%s" % json.dumps(ident.get("path") or ""))
print("plugin_directory=%s" % json.dumps(row.get("path") or ""))
print("plugin_status=%s" % json.dumps(row.get("status") or ""))
print("plugin_enabled=%s" % json.dumps(bool(row.get("enabled"))))
print("plugin_source_known=true")
')"
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

# F2′: contentMatchesCommit is observed, never hard-coded. Prefer install log markers;
# fall back to whether install exited 0 (installer refuses content mismatch before switch).
content_matches=false
if grep -Eqi 'does not match commit|content.?bind|release_matches_commit' "$install_log" 2>/dev/null; then
  content_matches=false
elif [ "$install_rc" -eq 0 ]; then
  content_matches=true
fi

# channelRecovery: only claim adopt-expected when plugin SOURCE actually points at this release.
# This is an EXPECTATION derived from the plugin binding, not an observed live-channel probe; a real
# lease/channel observation is still out of reach for this script (documented as unresolved).
channel_recovery=unknown
if [ "$final_state" = succeeded ] && [ "$plugin_ok" = true ]; then
  channel_recovery=adopt-expected
fi

# --- AC04 evidence sampling (post-install, before mint): real values, never constant placeholders ---
# MCP runtime: the process actually listening on the service port, its cwd, and — when that cwd is a
# release dir — the inventory digest of the code it is running.
mcp_pid=""
mcp_cwd=""
mcp_sha=""
if [ -x /usr/sbin/lsof ]; then
  set +e
  listening_pid=$(/usr/sbin/lsof -nP -iTCP:"$mcp_port" -sTCP:LISTEN -t 2>/dev/null | head -1)
  set -e
  if [ -n "$listening_pid" ]; then
    mcp_pid=$listening_pid
    set +e
    cwd_out=$(/usr/sbin/lsof -a -p "$mcp_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    set -e
    if [ -n "$cwd_out" ]; then
      mcp_cwd=$cwd_out
      case "$mcp_cwd" in
        "$service_home"/releases/*) mcp_sha=$(inventory_hash "$mcp_cwd") ;;
      esac
    fi
  fi
fi

# vendor/schema binding: digest the release schema and the vendored schema copy the plugin actually ships.
schema_hash=""
vendor_schema_hash=""
vendor_schema_diff=unavailable
if [ -d "$release_dir/schema" ]; then
  schema_hash=$(inventory_hash "$release_dir/schema")
fi
if [ -d "$release_dir/plugin/server/vendor/schema" ]; then
  vendor_schema_hash=$(inventory_hash "$release_dir/plugin/server/vendor/schema")
fi
if [ -n "$schema_hash" ] && [ -n "$vendor_schema_hash" ]; then
  if [ "$schema_hash" = "$vendor_schema_hash" ]; then
    vendor_schema_diff=none
  else
    vendor_schema_diff=differ
  fi
fi

# Plugin modules: sha256 of the files the plugin loads from the bound SOURCE (manifest + server/shared
# sources, excluding node_modules). Empty when SOURCE is unknown — the receipt then says so honestly.
plugin_modules_json=""
if [ "$plugin_source_known" = true ] && [ -d "$plugin_source" ]; then
  set +e
  plugin_modules_json=$(PLUGIN_DIR="$plugin_source" /usr/bin/python3 - <<'PY'
import hashlib, json, os
root = os.environ["PLUGIN_DIR"]
exts = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".json")
modules = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
    for name in filenames:
        if not name.endswith(exts):
            continue
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, root)
        try:
            data = open(path, "rb").read()
        except OSError:
            continue
        modules.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
modules.sort(key=lambda m: m["path"])
print(json.dumps(modules[:400], separators=(",", ":")))
PY
)
  set -e
fi

# Structured post-check results: readers should not have to parse the aggregate reason string.
CHECKS="$(
  INSTALL_RC="$install_rc" ACTIVE_OK="$([ "$active_after" = "$release_dir" ] && echo true || echo false)" \
  HEALTH="$health_code" READY="$ready_code" PLUGIN_OK="$plugin_ok" \
  ROLLBACK_OK="$rollback_ok" ROLLBACK_ATTEMPTED="$rollback_attempted" \
  SNAPSHOT_BOUND="$([ "$final_state" = succeeded ] || [ "$rollback_ok" = true ] && echo true || echo false)" \
  /usr/bin/python3 -c '
import json, os
def ok(v): return v == "true"
checks = [
  {"name": "install", "ok": os.environ["INSTALL_RC"] == "0",
   "detail": None if os.environ["INSTALL_RC"] == "0" else "install exit %s" % os.environ["INSTALL_RC"]},
  {"name": "active", "ok": ok(os.environ["ACTIVE_OK"])},
  {"name": "mcp-health", "ok": os.environ["HEALTH"] == "200",
   "detail": None if os.environ["HEALTH"] == "200" else "health=%s" % os.environ["HEALTH"]},
  {"name": "mcp-ready", "ok": os.environ["READY"] == "200",
   "detail": None if os.environ["READY"] == "200" else "ready=%s" % os.environ["READY"]},
  {"name": "plugin-source", "ok": ok(os.environ["PLUGIN_OK"])},
]
if ok(os.environ["ROLLBACK_ATTEMPTED"]):
  checks.append({"name": "rollback", "ok": ok(os.environ["ROLLBACK_OK"])})
print(json.dumps([{k: v for k, v in c.items() if v is not None} for c in checks], separators=(",", ":")))
'
)"

# lockReleased: observed — true only after we successfully unlink our lock file below.
lock_released=false

# --- receipt (trusted host) ---
# F4: mint hostTag with private/host-release.hmac (employee sandbox cannot read private/).
hmac_key="$service_home/private/host-release.hmac"
if [ ! -f "$hmac_key" ]; then
  mkdir -p "$service_home/private"
  # Env assignment MUST precede the command; trailing P=… is argv, not environ (KeyError).
  P="$hmac_key" /usr/bin/python3 -c 'import os; open(os.environ["P"],"wb").write(os.urandom(32))'
  chmod 600 "$hmac_key"
fi
OP_ID="$op_id" TASK_ID="$taskId" TARGET_SHA="$targetSha" PREV_ACTIVE="$expectedActive" \
EXPECTED_ACTIVE="$expectedActive" SNAP_HASH="$snapshotHash" ROLLBACK_SHA="$rollbackSha" \
HOST="$host" UID_N="$uid" USER_N="$user" STARTED="$started" FINISHED="$finished" \
EXIT_CODE="$install_rc" APPLY_EXIT="$([ "$final_state" = succeeded ] && echo 0 || echo 1)" \
STATE="$final_state" REASON="$reason" RELEASE_DIR="$release_dir" \
HEALTH="$health_code" READY="$ready_code" PLUGIN_STATUS="$plugin_status" PLUGIN_ENABLED="$plugin_enabled" \
PLUGIN_SOURCE="$plugin_source" PLUGIN_DIRECTORY="$plugin_directory" PLUGIN_KNOWN="$plugin_source_known" \
RB_ATTEMPTED="$rollback_attempted" RB_OK="$rollback_ok" RB_TO="$rollback_to" \
CONTENT_MATCHES="$content_matches" CHANNEL_RECOVERY="$channel_recovery" LOCK_RELEASED="$lock_released" \
MCP_PID="$mcp_pid" MCP_CWD="$mcp_cwd" MCP_SHA="$mcp_sha" \
SCHEMA_HASH="$schema_hash" VENDOR_SCHEMA_HASH="$vendor_schema_hash" VENDOR_SCHEMA_DIFF="$vendor_schema_diff" \
PLUGIN_MODULES="$plugin_modules_json" CHECKS_JSON="$CHECKS" \
HMAC_KEY="$hmac_key" RECEIPT="$receipt" /usr/bin/python3 - <<'PY'
import hashlib, hmac, json, os
state = os.environ["STATE"]
content_matches = os.environ["CONTENT_MATCHES"] == "true"
executor = {"host": os.environ["HOST"], "uid": int(os.environ["UID_N"]), "user": os.environ["USER_N"]}
# Build the receipt FIRST (without hostTag), then sign the full evidence payload so
# binding/mcp/plugin/channelRecovery/lockReleased/rollback/checks/reason are covered (F4).
receipt = {
  "schema": "host-release-receipt/1",
  "opId": os.environ["OP_ID"],
  "taskId": os.environ["TASK_ID"],
  "targetSha": os.environ["TARGET_SHA"],
  "previousActive": os.environ["PREV_ACTIVE"],
  "expectedActive": os.environ["EXPECTED_ACTIVE"],
  "snapshotHash": os.environ["SNAP_HASH"],
  "rollbackSha": os.environ["ROLLBACK_SHA"],
  "executor": executor,
  "startedAt": os.environ["STARTED"],
  "finishedAt": os.environ["FINISHED"],
  "exitCode": int(os.environ["APPLY_EXIT"]),
  "installerExitCode": int(os.environ["EXIT_CODE"]),
  "state": state,
  "checks": json.loads(os.environ["CHECKS_JSON"] or "[]"),
  "binding": {
    "releasePath": os.environ["RELEASE_DIR"] if state in ("succeeded", "rolled_back", "failed") else None,
    "contentMatchesCommit": content_matches,
    "vendorSchemaDiff": os.environ["VENDOR_SCHEMA_DIFF"],
    "schemaHash": os.environ["SCHEMA_HASH"] or None,
    "vendorSchemaHash": os.environ["VENDOR_SCHEMA_HASH"] or None,
  },
  "mcp": {
    "health": int(os.environ["HEALTH"]) if os.environ["HEALTH"].isdigit() else None,
    "ready": int(os.environ["READY"]) if os.environ["READY"].isdigit() else None,
    "cwd": os.environ["MCP_CWD"] or None,
    "pid": int(os.environ["MCP_PID"]) if os.environ["MCP_PID"].isdigit() else None,
    "sha": os.environ["MCP_SHA"] or None,
  },
  "plugin": {
    "status": os.environ["PLUGIN_STATUS"] if os.environ["PLUGIN_STATUS"] != "unknown" else None,
    # B2: json.dumps(bool) prints "true"/"false"; compare lowercase, not Python True.
    "enabled": (os.environ["PLUGIN_ENABLED"] == "true") if os.environ["PLUGIN_KNOWN"] == "true" else None,
    "source": os.environ["PLUGIN_SOURCE"] if os.environ["PLUGIN_SOURCE"] not in ("", "unknown") else None,
    "directory": os.environ["PLUGIN_DIRECTORY"] if os.environ["PLUGIN_DIRECTORY"] not in ("", "unknown") else None,
    "sourceKnown": os.environ["PLUGIN_KNOWN"] == "true",
    "modules": json.loads(os.environ["PLUGIN_MODULES"]) if os.environ["PLUGIN_MODULES"] else None,
  },
  "channelRecovery": os.environ["CHANNEL_RECOVERY"],
  "rollback": {
    "attempted": os.environ["RB_ATTEMPTED"] == "true",
    "to": os.environ["RB_TO"] or None,
    "ok": os.environ["RB_OK"] == "true",
  },
  "lockReleased": False,
}
if os.environ["REASON"]:
  receipt["reason"] = os.environ["REASON"]
# Canonical payload MUST match src/host-release/provenance.ts receiptTagPayload key order.
tag_obj = {
  "opId": receipt["opId"],
  "taskId": receipt["taskId"],
  "targetSha": receipt["targetSha"],
  "previousActive": receipt["previousActive"],
  "expectedActive": receipt["expectedActive"],
  "snapshotHash": receipt["snapshotHash"],
  "rollbackSha": receipt["rollbackSha"],
  "executor": {"host": executor["host"], "uid": executor["uid"], "user": executor["user"]},
  "startedAt": receipt["startedAt"],
  "finishedAt": receipt["finishedAt"],
  "exitCode": receipt["exitCode"],
  "installerExitCode": receipt["installerExitCode"],
  "state": receipt["state"],
  "checks": receipt["checks"],
  "binding": receipt["binding"],
  "mcp": receipt["mcp"],
  "plugin": receipt["plugin"],
  "channelRecovery": receipt["channelRecovery"],
  "rollback": receipt["rollback"],
  "lockReleased": receipt["lockReleased"],
}
if "reason" in receipt:
  tag_obj["reason"] = receipt["reason"]
tag_payload = json.dumps(tag_obj, separators=(",", ":"))
key = open(os.environ["HMAC_KEY"], "rb").read()
receipt["hostTag"] = hmac.new(key, tag_payload.encode(), hashlib.sha256).hexdigest()
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

# Release the lock, then flip receipt.lockReleased and RE-SIGN hostTag (B1).
# Signing with lockReleased=false then flipping without resign makes verifyHostTag fail.
trap - EXIT
if rm -f "$lock"; then
  lock_released=true
fi
RECEIPT="$receipt" LOCK_RELEASED="$lock_released" HMAC_KEY="$hmac_key" /usr/bin/python3 - <<'PY'
import hashlib, hmac, json, os
path = os.environ["RECEIPT"]
receipt = json.load(open(path, encoding="utf-8"))
receipt["lockReleased"] = os.environ["LOCK_RELEASED"] == "true"
# Canonical payload MUST match the mint block / src/host-release/provenance.ts receiptTagPayload.
tag_obj = {
  "opId": receipt["opId"],
  "taskId": receipt["taskId"],
  "targetSha": receipt["targetSha"],
  "previousActive": receipt["previousActive"],
  "expectedActive": receipt["expectedActive"],
  "snapshotHash": receipt["snapshotHash"],
  "rollbackSha": receipt["rollbackSha"],
  "executor": {
    "host": receipt["executor"]["host"],
    "uid": receipt["executor"]["uid"],
    "user": receipt["executor"]["user"],
  },
  "startedAt": receipt["startedAt"],
  "finishedAt": receipt["finishedAt"],
  "exitCode": receipt["exitCode"],
  "installerExitCode": receipt["installerExitCode"],
  "state": receipt["state"],
  "checks": receipt["checks"],
  "binding": receipt["binding"],
  "mcp": receipt["mcp"],
  "plugin": receipt["plugin"],
  "channelRecovery": receipt["channelRecovery"],
  "rollback": receipt["rollback"],
  "lockReleased": receipt["lockReleased"],
}
if "reason" in receipt:
  tag_obj["reason"] = receipt["reason"]
tag_payload = json.dumps(tag_obj, separators=(",", ":"))
key = open(os.environ["HMAC_KEY"], "rb").read()
receipt["hostTag"] = hmac.new(key, tag_payload.encode(), hashlib.sha256).hexdigest()
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
  json.dump(receipt, handle, ensure_ascii=False, indent=2)
  handle.write("\n")
os.replace(tmp, path)
PY

echo "host-release apply $final_state op=$op_id receipt=$receipt"
[ "$final_state" = succeeded ] || exit 1
