#!/bin/sh
# Employee-safe prepare for the managed host-release seam.
# Delegates to src/host-release/cli.ts. Does NOT switch active / read private / call paseo.
set -eu
here=$(CDPATH= cd "$(dirname "$0")" && pwd)
ops_root=$(CDPATH= cd "$here/../.." && pwd)
cd "$ops_root"
exec bun src/host-release/cli.ts prepare "$@"
