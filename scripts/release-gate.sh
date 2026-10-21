#!/bin/sh
# Local release gate (SYS01 AC-B). The macOS slow-pipe regression runs here, on the Mac that will host the release, instead of on a
# hosted macOS runner. It runs the test on one release snapshot with the Bun runtime the services run with (scripts/bun-runtime.sh),
# and records the result under the service home, bound to the release commit and that runtime's version. `company-service.sh install`
# refuses a release without a passing record for its own SHA and runtime version, so a missing, failed, other-SHA or other-Bun record
# blocks the switch. Nothing here reads credentials.
set -eu

service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
gate=${1:?usage: release-gate.sh slow-pipe /absolute/release/path}
release=${2:?usage: release-gate.sh slow-pipe /absolute/release/path}
. "$(dirname "$0")/bun-runtime.sh"

[ "$gate" = slow-pipe ] || { echo "unknown gate: $gate (known: slow-pipe)" >&2; exit 2; }
case "$release" in /*) ;; *) echo 'Release path must be absolute' >&2; exit 2;; esac
[ "$(uname -s)" = Darwin ] || { echo 'refused: the slow-pipe gate runs on macOS only; its pipes are the ones the regression is about' >&2; exit 2; }
sha=${release##*/}
case "$sha" in *[!0-9a-f]*) echo "refused: release dir '$sha' is not a commit sha" >&2; exit 2;; esac
[ ${#sha} -eq 40 ] || { echo "refused: release dir '$sha' is not a 40-character commit sha" >&2; exit 2; }
[ -f "$release/tests/comm-slow-pipe.test.ts" ] || { echo 'refused: the release has no tests/comm-slow-pipe.test.ts' >&2; exit 2; }
# The recorded pass is for a commit, so the content has to be that commit's (SYS01 AC-B, review B2). The ops checkout is used when
# one can be resolved; install re-checks the content against the commit in any case, so this is the earlier, clearer refusal.
. "$(dirname "$0")/release-content.sh"
gate_ops_repo=${SCK_OPS_REPO:-$(/usr/bin/sed -n 's/^SCK_AGENT_CWD=//p' "$service_home/private/service.env" 2>/dev/null | /usr/bin/tr -d "\"'")}
if [ -n "$gate_ops_repo" ] && [ -d "$gate_ops_repo/.git" ] \
  && ! release_matches_commit "$release" "$sha" "$gate_ops_repo"; then
  echo "refused: $release does not match commit $sha — the gate records a pass for a commit only for that commit's content" >&2; exit 2
fi
resolve_bun "$service_home"
[ -x "$BUN" ] || { echo "refused: the service Bun runtime is not executable: $BUN" >&2; exit 2; }
bun_version=$("$BUN" --version) || { echo "refused: $BUN did not report a version" >&2; exit 2; }

out_dir="$service_home/gates/comm-slow-pipe"
mkdir -p "$out_dir"
chmod 700 "$service_home/gates" "$out_dir"
log="$out_dir/$sha.log"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# The red control runs too: the pre-SYS01 client must still lose bytes through the same pipe, or the harness is not trusted.
set +e
(cd "$release" && SCK_COMM_CONTROL=1 "$BUN" test tests/comm-slow-pipe.test.ts) > "$log" 2>&1
rc=$?
set -e
result=fail
[ "$rc" -eq 0 ] && result=pass

record="$out_dir/$sha.json"
GATE_SHA="$sha" GATE_BUN="$bun_version" GATE_BUN_PATH="$BUN" GATE_RESULT="$result" GATE_RC="$rc" GATE_STARTED="$started" GATE_LOG="$log" GATE_RECORD="$record" \
  GATE_FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" GATE_ARCH="$(uname -m)" /usr/bin/python3 - <<'PY'
import json, os
record = {
    'gate': 'comm-slow-pipe',
    'sha': os.environ['GATE_SHA'],
    'bun': os.environ['GATE_BUN'],
    'bunPath': os.environ['GATE_BUN_PATH'],
    'platform': 'darwin',
    'arch': os.environ['GATE_ARCH'],
    'result': os.environ['GATE_RESULT'],
    'exitCode': int(os.environ['GATE_RC']),
    'startedAt': os.environ['GATE_STARTED'],
    'finishedAt': os.environ['GATE_FINISHED'],
    'log': os.environ['GATE_LOG'],
}
path = os.environ['GATE_RECORD']
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(record, handle, ensure_ascii=False, indent=2)
os.chmod(path, 0o600)
PY

echo "comm-slow-pipe $result for $sha on bun $bun_version at $BUN (record: $record)"
exit "$rc"
