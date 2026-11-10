# shellcheck shell=sh
# The Bun runtime sck runs with. Sourced by sck.sh; the node updater installs both beside each other in bin/, so sck and
# the plugin it calls resolve the same runtime. Order: SCK_BUN (environment, else the SCK_BUN line of private/service.env),
# then the service-pinned runtime-bun under the service home, then ~/.bun/bin/bun. PATH is never searched: the Bun there is
# not the runtime the plugin runs on.
resolve_bun() {
  rb_home=$1
  rb_pinned=${SCK_BUN:-}
  if [ -z "$rb_pinned" ] && [ -f "$rb_home/private/service.env" ]; then
    rb_pinned=$(/usr/bin/sed -n 's/^SCK_BUN=//p' "$rb_home/private/service.env" | /usr/bin/tail -n 1 | /usr/bin/tr -d "\"'")
  fi
  BUN="${rb_pinned:-$rb_home/runtime-bun/bin/bun}"
  # An explicit pin is the runtime even when it is missing: it is never replaced by another Bun, so the gate cannot record one
  # runtime while the services would run another. Only the default location falls back to ~/.bun.
  [ -n "$rb_pinned" ] || [ -x "$BUN" ] || BUN="$HOME/.bun/bin/bun"
  export BUN
}
