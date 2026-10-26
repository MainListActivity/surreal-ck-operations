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
  *) echo "unknown suite: $suite (known: sys04-runtime-diagnostics)" >&2; exit 2;;
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
  ops_repo=${SCK_OPS_REPO:-}
  if [ -z "$ops_repo" ] && [ -f "$service_home/private/service.env" ]; then
    ops_repo=$(/usr/bin/sed -n 's/^SCK_AGENT_CWD=//p' "$service_home/private/service.env" 2>/dev/null | /usr/bin/tr -d "\"'" || true)
  fi
  if [ -n "$ops_repo" ] && [ -d "$ops_repo/.git" ]; then
    release_matches_commit "$target" "$sha" "$ops_repo" || {
      echo "refused: $target does not match commit $sha" >&2; exit 2
    }
    repo_identity=$(git -C "$ops_repo" rev-parse --git-common-dir)
    case "$repo_identity" in /*) ;; *) repo_identity=$(CDPATH= cd -- "$ops_repo/$repo_identity" && pwd);; esac
  else
    repo_identity="release:$sha"
  fi
fi

# Every named test file must exist in the target.
for one in $unit_test $fork_test; do
  [ -f "$target/$one" ] || { echo "refused: the target has no $one" >&2; exit 2; }
done

resolve_bun "$service_home"
[ -x "$BUN" ] || { echo "refused: the service Bun runtime is not executable: $BUN" >&2; exit 2; }
bun_version=$("$BUN" --version) || { echo "refused: $BUN did not report a version" >&2; exit 2; }

out_dir="$service_home/gates/managed-local-test"
mkdir -p "$out_dir"
chmod 700 "$service_home/gates" "$out_dir" 2>/dev/null || true
log="$out_dir/$sha.log"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The command string recorded is the allowlisted suite expansion, never a free-form caller command.
command_line="bun test $unit_test && bun scripts/test-worktrees.ts $fork_test"

set +e
{
  echo "=== managed-local-test suite=$suite sha=$sha started=$started ==="
  echo "target=$target"
  echo "bun=$BUN ($bun_version)"
  echo "command=$command_line"
  echo "--- unit ---"
  (cd "$target" && "$BUN" test $unit_test)
  unit_rc=$?
  echo "unit_exit=$unit_rc"
  if [ "$unit_rc" -eq 0 ]; then
    echo "--- fork ---"
    (cd "$target" && "$BUN" scripts/test-worktrees.ts $fork_test)
    fork_rc=$?
    echo "fork_exit=$fork_rc"
  else
    fork_rc=1
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

record="$out_dir/$sha.json"
GATE_SHA="$sha" GATE_SUITE="$suite" GATE_BUN="$bun_version" GATE_BUN_PATH="$BUN" \
  GATE_RESULT="$result" GATE_RC="$rc" GATE_STARTED="$started" GATE_FINISHED="$finished" \
  GATE_LOG="$log" GATE_LOG_HASH="$log_hash" GATE_RECORD="$record" GATE_COMMAND="$command_line" \
  GATE_TARGET="$target" GATE_REPO="$repo_identity" GATE_DIRTY="$dirty" GATE_ARCH="$(uname -m)" \
  GATE_WHY="$gate_why" /usr/bin/python3 - <<'PY'
import json, os
record = {
    'gate': 'managed-local-test',
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
}
path = os.environ['GATE_RECORD']
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(record, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
os.chmod(path, 0o600)
PY

echo "managed-local-test $result for $sha suite=$suite (record: $record)"
exit "$rc"
