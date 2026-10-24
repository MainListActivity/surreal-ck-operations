#!/bin/sh
# Run by the owner on the origin host, after copying both files there:
#   sudo sh install-remote.sh "<tunnel-pubkey>" "<ops-pubkey>" < sck-origin-agent.py
# Creates two accounts with no shell, no sudo and one forced capability each:
#   scktunnel — may only open the status-face reverse forward on 127.0.0.1:18778
#   sckops    — may only run /usr/local/bin/sck-origin-agent (read-only status, health, journal)
set -eu
TUNNEL_KEY=$1
OPS_KEY=$2
case "$TUNNEL_KEY$OPS_KEY" in *'
'*) echo "keys must be one line each" >&2; exit 1 ;; esac

install -m 0755 -o root -g root /dev/stdin /usr/local/bin/sck-origin-agent

# sshd runs a forced command through the login shell, so sckops needs a real one; restrict and
# command= still leave it nothing but the agent. scktunnel never runs a command at all.
account() {
  id "$1" >/dev/null 2>&1 || useradd --system --create-home --shell "$4" "$1"
  usermod --shell "$4" "$1"
  install -d -m 0755 -o root -g root "/home/$1/.ssh"
  printf '%s %s\n' "$2" "$3" > "/home/$1/.ssh/authorized_keys"
  chown root:root "/home/$1/.ssh/authorized_keys"
  chmod 0644 "/home/$1/.ssh/authorized_keys"
}
account scktunnel 'restrict,port-forwarding,permitlisten="127.0.0.1:18778",command="/bin/false"' "$TUNNEL_KEY" /usr/sbin/nologin
account sckops 'restrict,command="/usr/local/bin/sck-origin-agent"' "$OPS_KEY" /bin/sh
usermod -aG systemd-journal sckops

# authorized_keys port-forwarding also opens local (-L) forwards; only the status-face -R may exist.
CONF=/etc/ssh/sshd_config
if ! grep -q '^# sck-origin begin' "$CONF"; then
  cp "$CONF" "$CONF.bak-sck-origin"
  cat >> "$CONF" <<'EOF'
# sck-origin begin
Match User scktunnel
    AllowTcpForwarding remote
    PermitOpen none
    PermitListen 127.0.0.1:18778
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    ForceCommand /bin/false
Match User sckops
    AllowTcpForwarding no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    ForceCommand /usr/local/bin/sck-origin-agent
# sck-origin end
EOF
  if ! sshd -t; then cp "$CONF.bak-sck-origin" "$CONF"; echo "sshd config rejected, restored" >&2; exit 1; fi
  systemctl reload ssh
fi
echo installed
