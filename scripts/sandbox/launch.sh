#!/bin/sh
# Provider launcher Paseo runs instead of the provider binary: launch.sh <binary> [args…].
# Company sessions (marked by the plugin at session open, or carrying their comm channel) run inside
# employee.sb; the owner's own sessions and Paseo's version/auth probes run the binary unchanged.
# A company session never starts unsandboxed: a missing profile is a launch failure.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "${SCK_SANDBOX:-}" = employee ] || [ -n "${SCK_COMM_DIR:-}" ]; then
  profile="$here/employee.sb"
  if [ ! -r "$profile" ]; then echo "sck sandbox: $profile missing; refusing to start a company session unsandboxed" >&2; exit 78; fi
  export SCK_SANDBOX=employee
  # /bin/ps is setuid and the sandbox refuses to exec it; Factory's Execute supervisor kills every foreground
  # command whose `ps -o ppid= -p $$` liveness check fails. shim/ps (built from ps.c) answers it through libproc.
  if [ -x "$here/shim/ps" ]; then PATH="$here/shim:${PATH:-/usr/bin:/bin}"; export PATH; fi
  # Goal workspaces start in the project root. Load the private employee settings explicitly,
  # after the user's settings, rather than writing company routing into a shared project.
  if [ -n "${SCK_CLAUDE_SETTINGS:-}" ] && [ "${1##*/}" = claude ]; then
    if [ ! -r "$SCK_CLAUDE_SETTINGS" ]; then
      echo "sck sandbox: employee Claude settings missing; refusing an untracked launch" >&2
      exit 78
    fi
    set -- "$@" --settings "$SCK_CLAUDE_SETTINGS"
  fi
  # Installed as <service home>/sandbox/launch.sh; the paths come from the install, not the session env.
  exec /usr/bin/sandbox-exec -f "$profile" -D HOME="$(cd ~ && pwd -P)" -D SERVICE="$(cd "$here/.." && pwd -P)" "$@"
fi
exec "$@"
