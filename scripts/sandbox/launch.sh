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
  # Installed as <service home>/sandbox/launch.sh; the paths come from the install, not the session env.
  exec /usr/bin/sandbox-exec -f "$profile" -D HOME="$(cd ~ && pwd -P)" -D SERVICE="$(cd "$here/.." && pwd -P)" "$@"
fi
exec "$@"
