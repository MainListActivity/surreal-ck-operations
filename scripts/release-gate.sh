#!/bin/sh
# Local release gate (SYS01 AC-B). The macOS slow-pipe regression runs here, on the Mac that will host the release, instead of on a
# hosted macOS runner. It runs the test on one release snapshot with the Bun runtime the services run with (scripts/bun-runtime.sh),
# and records the result under the service home, bound to the release commit and that runtime's version. `company-service.sh install`
# refuses a release without a passing record for its own SHA and runtime version, so a missing, failed, other-SHA or other-Bun record
# blocks the switch. Nothing here reads credentials.
set -eu

service_home=${SCK_SERVICE_HOME:-"$HOME/Library/Application Support/SurrealCKCompany"}
gate=${1:?usage: release-gate.sh <slow-pipe|sidecar-review> /absolute/release/path}
release=${2:?usage: release-gate.sh <slow-pipe|sidecar-review> /absolute/release/path}
. "$(dirname "$0")/bun-runtime.sh"

case "$gate" in
  slow-pipe)
    gate_name=comm-slow-pipe
    gate_test=tests/comm-slow-pipe.test.ts
    gate_why='the slow-pipe gate runs on macOS only; its pipes are the ones the regression is about'
    ;;
  sidecar-review)
    gate_name=sidecar-review
    # SYS02 N1-R: the deployment-source association (a borrowed deployment must not certify an environment) is
    # part of the same local-fork gate, so a regression of the source association blocks the release too.
    # SYS06: the effective-policy contract regression rides this gate as well — it needs the company fork
    # SurrealDB (official upstream is not compatible), so it can never run on hosted CI.
    # SYS-INT: the deploy-drill suite rides here for the same reason. It must prove the drill works from the
    # plugin face's Node host (AC01/AC02/AC03) and that the drill's authorization guards still refuse — none
    # of which hosted CI can exercise, since the Node probe needs a real Node binary and the drill needs the
    # company fork plus a real macOS process tree. The drill is the rollback-isolation tool, so a regression
    # here has to block the release exactly like the sidecar regression does. The access test is the same
    # gate's security half: it drives deployDrillRun against the fork with its own database, so it needs its
    # own opt-in (deploy-drill-access.fork.test.ts is otherwise skipped).
    # SYS-INT: the QA review wake subscriptions ride this gate too. Their rules (one event per review fence, delivery
    # only to the collaboration task's own feedback wait, old-fence invalidation, zero polling) are exactly the
    # regressions that would silently re-break the coordination tasks, and they need the company fork.
    gate_env="RUN_SCK_CHANNEL_FORK_TESTS=1 RUN_SCK_DRILL_ACCESS_TESTS=1 RUN_SCK_REVIEW_EVENT_FORK_TESTS=1 RUN_SCK_UPGRADE_FORK_TESTS=1"
    gate_test="tests/dispatcher-sidecar.fork.test.ts tests/deployment-source.test.ts tests/deployment-source.fork.test.ts tests/effective-policy.fork.test.ts tests/deploy-drill.test.ts tests/deploy-drill-runner.test.ts tests/deploy-drill-node-host.test.ts tests/deploy-drill-access.fork.test.ts tests/review-events.test.ts tests/review-events.fork.test.ts tests/company-upgrades.fork.test.ts"
    gate_why='the sidecar-review gate runs on macOS only; it uses the local company fork'
    ;;
  *) echo "unknown gate: $gate (known: slow-pipe, sidecar-review)" >&2; exit 2;;
esac
case "$release" in /*) ;; *) echo 'Release path must be absolute' >&2; exit 2;; esac
[ "$(uname -s)" = Darwin ] || { echo "refused: $gate_why" >&2; exit 2; }
sha=${release##*/}
case "$sha" in *[!0-9a-f]*) echo "refused: release dir '$sha' is not a commit sha" >&2; exit 2;; esac
[ ${#sha} -eq 40 ] || { echo "refused: release dir '$sha' is not a 40-character commit sha" >&2; exit 2; }
# The gate may name several test files; every one of them must be in the release.
for one in $gate_test; do
  [ -f "$release/$one" ] || { echo "refused: the release has no $one" >&2; exit 2; }
done
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

out_dir="$service_home/gates/$gate_name"
mkdir -p "$out_dir"
chmod 700 "$service_home/gates" "$out_dir"
log="$out_dir/$sha.log"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)

set +e
# gate_test is a space-separated list and is expanded unquoted on purpose: bun reads every argument as a filter, so quoting it
# would hand bun the whole list as one argument, which matches no file at all.
if [ "$gate" = slow-pipe ]; then
  # The red control runs too: the pre-SYS01 client must still lose bytes through the same pipe, or the harness is not trusted.
  (cd "$release" && SCK_COMM_CONTROL=1 "$BUN" test $gate_test) > "$log" 2>&1
else
  # Exercise the real client-cli -> sidecar -> company-fork path, including plugin reload recovery, and the
  # deploy-drill suite (its opt-ins are named in gate_env).
  # shellcheck disable=SC2086 # gate_env is a deliberate space-separated assignment list.
  (cd "$release" && env $gate_env "$BUN" test $gate_test) > "$log" 2>&1
fi
rc=$?
set -e
result=fail
[ "$rc" -eq 0 ] && result=pass

record="$out_dir/$sha.json"
GATE_NAME="$gate_name" GATE_SHA="$sha" GATE_BUN="$bun_version" GATE_BUN_PATH="$BUN" GATE_RESULT="$result" GATE_RC="$rc" GATE_STARTED="$started" GATE_LOG="$log" GATE_RECORD="$record" \
  GATE_FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" GATE_ARCH="$(uname -m)" /usr/bin/python3 - <<'PY'
import json, os
record = {
    'gate': os.environ['GATE_NAME'],
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

echo "$gate_name $result for $sha on bun $bun_version at $BUN (record: $record)"
exit "$rc"
