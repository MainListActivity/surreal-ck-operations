# shellcheck shell=sh
# The Bun runtime the services run with. Sourced by run-service.sh (installed as bin/run.sh beside this file), release-gate.sh and
# company-service.sh, so the release gate runs and records the runtime production executes. Order: SCK_BUN (environment, else the
# SCK_BUN line of private/service.env), then the service-pinned runtime-bun under the service home, then ~/.bun/bin/bun.
# PATH is never searched: the Bun there is not the runtime the services run.
resolve_bun() {
  rb_home=$1
  rb_pinned=${SCK_BUN:-}
  if [ -z "$rb_pinned" ] && [ -f "$rb_home/private/service.env" ]; then
    rb_pinned=$(/usr/bin/sed -n 's/^SCK_BUN=//p' "$rb_home/private/service.env" | /usr/bin/tail -n 1 | /usr/bin/tr -d "\"'")
  fi
  BUN="${rb_pinned:-$rb_home/runtime-bun/bin/bun}"
  [ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
  export BUN
}
