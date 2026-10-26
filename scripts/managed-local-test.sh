#!/bin/sh
# Managed local unit-test gate (SYS02, owner-authorized exception when GitHub Actions billing is unavailable).
#
# A trusted host runs a FIXED allowlisted test command against one absolute checkout/release path, then writes a
# record under the service home that the acceptance adapter can read. The record is the execution proof: an
# employee-uploaded JSON is never trusted as the proof itself. Nothing here reads credentials or private/.
#
# usage: managed-local-test.sh <suite> /absolute/path
#   suite = sys04-runtime-diagnostics
#   path  = a clean git worktree whose HEAD is the 40-char sha being attested, OR a release dir named as that sha
set -eu

service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
suite=${1:?usage: managed-local-test.sh <suite> /absolute/path}
target=${2:?usage: managed-local-test.sh <suite> /absolute/path}
. "$(dirname "$0")/bun-runtime.sh"
. "$(dirname "$0")/release-content.sh"

case "$target" in /*) ;; *) echo 'Path must be absolute' >&2; exit 2;; esac
[ -d "$target" ] || { echo "refused: $target is not a directory" >&2; exit 2; }

# Fixed allowlist only. Adding a suite is a code change, never an argument that runs arbitrary commands.
case "$suite" in
  sys04-runtime-diagnostics)
    # The SYS04 runtime-diagnostics suite: unit files plus the role-gate fork under the company fork harness.
    unit_test='tests/plugin-runtime-diagnostics.test.ts tests/sidecar-runtime-diagnostics.test.ts'
    fork_test='tests/plugin-runtime-role-gate.fork.test.ts'
    gate_why='SYS04 plugin runtime diagnostics (unit + role-gate fork)'
    ;;
  sys02-local-evidence)
    # SYS02 acceptance seam + PR-gate substitute suite (unit only; no fork DB required for the gate record).
    unit_test='tests/acceptance.test.ts tests/pr-gate.test.ts'
    fork_test=''
    gate_why='SYS02 managed-local-test acceptance + PR-gate substitute (unit)'
    ;;
  *) echo "unknown suite: $suite (known: sys04-runtime-diagnostics, sys02-local-evidence)" >&2; exit 2;;
esac

# Resolve the sha being attested: release dir name, or git HEAD of a worktree.
base_name=${target##*/}
sha=""
case "$base_name" in
  *[!0-9a-f]*) ;;
  *)
    if [ "${#base_name}" -eq 40 ]; then sha=$base_name; fi
    ;;
esac
if [ -z "$sha" ]; then
  if [ -d "$target/.git" ] || [ -f "$target/.git" ]; then
    sha=$(git -C "$target" rev-parse HEAD)
  else
    echo 'refused: path is neither a 40-char release dir nor a git worktree' >&2; exit 2
  fi
fi
case "$sha" in *[!0-9a-f]*|'') echo "refused: sha '$sha' is not a 40-character commit sha" >&2; exit 2;; esac
[ "${#sha}" -eq 40 ] || { echo "refused: sha '$sha' is not a 40-character commit sha" >&2; exit 2; }

# Dirty trees are refused: the record must bind a clean HEAD, never a mixed working copy.
dirty=false
repo_identity=""
if [ -d "$target/.git" ] || [ -f "$target/.git" ]; then
  repo_identity=$(git -C "$target" rev-parse --git-common-dir 2>/dev/null || true)
  # Linked worktrees store .git as a file; resolve the common dir to a stable identity.
  if [ -n "$repo_identity" ]; then
    case "$repo_identity" in /*) ;; *) repo_identity=$(CDPATH= cd -- "$target/$repo_identity" && pwd);; esac
  fi
  head_now=$(git -C "$target" rev-parse HEAD)
  [ "$head_now" = "$sha" ] || { echo "refused: worktree HEAD $head_now is not the attested sha $sha" >&2; exit 2; }
  if [ -n "$(git -C "$target" status --porcelain)" ]; then
    echo "refused: worktree is dirty; commit or discard changes before recording a managed local test" >&2; exit 2
  fi
else
  # Release snapshot: content must match the commit when an ops checkout is available (same rule as release-gate).
  # Do not read private/service.env here (SYS02 v11). Host sets SCK_OPS_REPO explicitly.
  ops_repo=${SCK_OPS_REPO:-}
  if [ -n "$ops_repo" ] && [ -d "$ops_repo/.git" ]; then
    release_matches_commit "$target" "$sha" "$ops_repo" || {
      echo "refused: $target does not match commit $sha" >&2; exit 2
    }
    repo_identity=$(git -C "$ops_repo" rev-parse --git-common-dir)
    case "$repo_identity" in /*) ;; *) repo_identity=$(CDPATH= cd -- "$ops_repo/$repo_identity" && pwd);; esac
  else
    # SYS02 v11: a directory named as a 40-char sha is NOT proof the content matches that commit.
    # Without an ops checkout that can release_matches_commit, refuse rather than mint an unbound label.
    echo "refused: release snapshot has no ops checkout to prove content matches commit $sha (set SCK_OPS_REPO)" >&2
    exit 2
  fi
fi

# Every named test file must exist in the target.
for one in $unit_test $fork_test; do
  [ -n "$one" ] || continue
  [ -f "$target/$one" ] || { echo "refused: the target has no $one" >&2; exit 2; }
done

resolve_bun "$service_home"
[ -x "$BUN" ] || { echo "refused: the service Bun runtime is not executable: $BUN" >&2; exit 2; }
bun_version=$("$BUN" --version) || { echo "refused: $BUN did not report a version" >&2; exit 2; }

# Host vs dry-run (SYS02 v11): managed attestation requires a host-injected signing key that is NOT
# derived from private/service.env (employees must never mint production attestations from readable config).
# The trusted execution agent sets SCK_MANAGED_LOCAL_TEST_SIGNING_KEY (or a file via SCK_MANAGED_LOCAL_TEST_SIGNING_KEY_FILE).
# Without it, the script still runs tests and writes a dry-run record for local verification only.
host_mode=dry-run
signing_key=""
if [ -n "${SCK_MANAGED_LOCAL_TEST_SIGNING_KEY_FILE:-}" ] && [ -r "${SCK_MANAGED_LOCAL_TEST_SIGNING_KEY_FILE}" ]; then
  signing_key=$(cat "${SCK_MANAGED_LOCAL_TEST_SIGNING_KEY_FILE}")
elif [ -n "${SCK_MANAGED_LOCAL_TEST_SIGNING_KEY:-}" ]; then
  signing_key=$SCK_MANAGED_LOCAL_TEST_SIGNING_KEY
fi
# Refuse keys that look like they were copied from private/service.env (common misconfig).
case "$signing_key" in
  *SCK_AGENT_CWD=*|*SURREAL_*|*TYPESAFE_*|*JEV_API*) signing_key="";;
esac
if [ ${#signing_key} -ge 16 ]; then
  host_mode=managed
fi
runner_identity="$(/usr/bin/uname -n):$(/usr/bin/id -u 2>/dev/null || echo unknown)"
# Optional scope bindings (host agent sets these when minting a substitutable record).
# D4: defaults MUST match src/acceptance.ts MANAGED_LOCAL_TEST_OWNER_REPLY_* (asserted in unit tests).
req_task=${SCK_MANAGED_LOCAL_TEST_TASK_ID:-}
owner_audit=${SCK_MANAGED_LOCAL_TEST_OWNER_REPLY_AUDIT_ID:-wuj9vmp3vg9pqyu33p2v}
owner_task=${SCK_MANAGED_LOCAL_TEST_OWNER_REPLY_TASK_ID:-25ec8d1a-6bbf-4bee-abaf-74998adeb5af}

out_dir="$service_home/gates/managed-local-test"
mkdir -p "$out_dir"
chmod 700 "$service_home/gates" "$out_dir" 2>/dev/null || true
# D2: isolate by full sha + suite so two suites never clobber each other's json/log.
log="$out_dir/$sha.$suite.log"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The command string recorded is the allowlisted suite expansion, never a free-form caller command.
if [ -n "$fork_test" ]; then
  command_line="bun test $unit_test && bun scripts/test-worktrees.ts $fork_test"
else
  command_line="bun test $unit_test"
fi

set +e
{
  echo "=== managed-local-test suite=$suite sha=$sha started=$started hostMode=$host_mode ==="
  echo "target=$target"
  echo "bun=$BUN ($bun_version)"
  echo "command=$command_line"
  echo "--- unit ---"
  (cd "$target" && "$BUN" test $unit_test)
  unit_rc=$?
  echo "unit_exit=$unit_rc"
  if [ -n "$fork_test" ]; then
    if [ "$unit_rc" -eq 0 ]; then
      echo "--- fork ---"
      (cd "$target" && "$BUN" scripts/test-worktrees.ts $fork_test)
      fork_rc=$?
      echo "fork_exit=$fork_rc"
    else
      fork_rc=1
    fi
  else
    fork_rc=0
  fi
  if [ "$unit_rc" -eq 0 ] && [ "$fork_rc" -eq 0 ]; then rc=0; else rc=1; fi
  echo "=== finished rc=$rc ==="
} >"$log" 2>&1
set -e

result=fail
[ "$rc" -eq 0 ] && result=pass
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Content hash of the log binds the record to what was actually written; a hand-edited log fails the adapter.
if command -v sha256sum >/dev/null 2>&1; then
  log_hash=$(sha256sum "$log" | cut -d' ' -f1)
else
  log_hash=$(shasum -a 256 "$log" | cut -d' ' -f1)
fi

record="$out_dir/$sha.$suite.json"
GATE_SHA="$sha" GATE_SUITE="$suite" GATE_BUN="$bun_version" GATE_BUN_PATH="$BUN" \
  GATE_RESULT="$result" GATE_RC="$rc" GATE_STARTED="$started" GATE_FINISHED="$finished" \
  GATE_LOG="$log" GATE_LOG_HASH="$log_hash" GATE_RECORD="$record" GATE_COMMAND="$command_line" \
  GATE_TARGET="$target" GATE_REPO="$repo_identity" GATE_DIRTY="$dirty" GATE_ARCH="$(uname -m)" \
  GATE_WHY="$gate_why" GATE_HOST_MODE="$host_mode" GATE_SIGNING_KEY="$signing_key" \
  GATE_RUNNER="$runner_identity" GATE_REQ_TASK="$req_task" GATE_OWNER_AUDIT="$owner_audit" \
  GATE_OWNER_TASK="$owner_task" \
  /usr/bin/python3 - <<'PY'
import hashlib, hmac, json, os
record = {
    'gate': 'managed-local-test',
    'protocolVersion': 'managed-local-test/1',
    'suite': os.environ['GATE_SUITE'],
    'sha': os.environ['GATE_SHA'],
    'bun': os.environ['GATE_BUN'],
    'bunPath': os.environ['GATE_BUN_PATH'],
    'platform': 'darwin',
    'arch': os.environ['GATE_ARCH'],
    'result': os.environ['GATE_RESULT'],
    'exitCode': int(os.environ['GATE_RC']),
    'startedAt': os.environ['GATE_STARTED'],
    'finishedAt': os.environ['GATE_FINISHED'],
    'command': os.environ['GATE_COMMAND'],
    'target': os.environ['GATE_TARGET'],
    'repoIdentity': os.environ['GATE_REPO'],
    'dirty': os.environ['GATE_DIRTY'] == 'true',
    'log': os.environ['GATE_LOG'],
    'logHash': os.environ['GATE_LOG_HASH'],
    'why': os.environ['GATE_WHY'],
    'hostMode': os.environ['GATE_HOST_MODE'],
    'runnerIdentity': os.environ['GATE_RUNNER'],
}
req = os.environ.get('GATE_REQ_TASK') or ''
if req:
    record['requestingTaskId'] = req
owner_audit = os.environ.get('GATE_OWNER_AUDIT') or ''
owner_task = os.environ.get('GATE_OWNER_TASK') or ''
if owner_audit:
    record['ownerReplyAuditId'] = owner_audit
if owner_task:
    record['ownerReplyTaskId'] = owner_task
# Managed attestation: HMAC over the FULL canonical payload with a host-injected signing key.
# Never private/service.env. Dry-run omits hostAttestation.
if record['hostMode'] == 'managed':
    secret = os.environ['GATE_SIGNING_KEY'].encode('utf-8')
    payload = '\n'.join([
        f"protocolVersion={record['protocolVersion']}",
        f"gate={record['gate']}",
        f"sha={record['sha']}",
        f"suite={record['suite']}",
        f"result={record['result']}",
        f"exitCode={record['exitCode']}",
        f"startedAt={record['startedAt']}",
        f"finishedAt={record['finishedAt']}",
        f"command={record['command']}",
        f"target={record['target']}",
        f"repoIdentity={record['repoIdentity']}",
        f"dirty={'true' if record['dirty'] else 'false'}",
        f"logHash={record['logHash']}",
        f"runnerIdentity={record['runnerIdentity']}",
        f"requestingTaskId={record.get('requestingTaskId') or req}",
        f"ownerReplyAuditId={record.get('ownerReplyAuditId') or owner_audit}",
        f"ownerReplyTaskId={record.get('ownerReplyTaskId') or owner_task}",
    ]).encode('utf-8')
    if not record.get('requestingTaskId'):
        raise SystemExit('managed mode requires SCK_MANAGED_LOCAL_TEST_TASK_ID (requesting task bound into attestation)')
    record['hostAttestation'] = hmac.new(secret, payload, hashlib.sha256).hexdigest()
path = os.environ['GATE_RECORD']
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(record, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
os.chmod(path, 0o600)
PY

echo "managed-local-test $result for $sha suite=$suite hostMode=$host_mode (record: $record)"
exit "$rc"
