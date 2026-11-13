#!/bin/sh
# Owner-run, idempotent: sh scripts/sandbox/install.sh
# Installs the employee sandbox into <service home>/sandbox and points Paseo's employee providers
# (claude, factory-droid, antigravity) at per-provider wrappers that go through launch.sh. The owner's
# own sessions keep running the plain binary: only sessions the plugin marks are sandboxed.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
service=${SCK_SERVICE_HOME:-$HOME/Library/Application Support/SurrealCKCompany}
dest="$service/sandbox"
paseo_home=${PASEO_HOME:-$HOME/.paseo}
paseo=${SCK_PASEO_BIN:-/Applications/Paseo.app/Contents/Resources/bin/paseo}

mkdir -p "$dest/bin"
install -m 0644 "$src/employee.sb" "$dest/employee.sb"
install -m 0755 "$src/launch.sh" "$dest/launch.sh"
sh "$src/build-ps.sh" "$dest"

# Paseo's claude provider takes only argv[0] of a replaced command, so each provider gets an executable.
wrap() { # wrap <name> <real binary>
  [ -x "$2" ] || { echo "skip $1: $2 not found" >&2; return 0; }
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$dest/launch.sh" "$2" > "$dest/bin/$1.tmp"
  chmod 0755 "$dest/bin/$1.tmp" && mv "$dest/bin/$1.tmp" "$dest/bin/$1"
}
wrap claude "$HOME/.local/bin/claude"
wrap droid "$HOME/.local/bin/droid"
wrap agy "$HOME/.local/bin/agy"
wrap grok "$HOME/.local/bin/grok"
if [ -x "$HOME/.local/bin/muse" ]; then wrap muse "$HOME/.local/bin/muse";
elif [ -x "$HOME/.muse/bin/muse" ]; then wrap muse "$HOME/.muse/bin/muse";
else echo "skip muse: 未安装 Muse Code（安装并登录后重跑本脚本）" >&2; fi

cp "$paseo_home/config.json" "$paseo_home/config.json.bak-sandbox-$(date +%s)"
/usr/bin/python3 -I - "$paseo_home/config.json" "$dest/bin" <<'EOF'
import json, os, sys
path, bindir = sys.argv[1], sys.argv[2]
with open(path) as f:
    config = json.load(f)
providers = config.setdefault("agents", {}).setdefault("providers", {})
def point(provider, name, args=()):
    wrapper = os.path.join(bindir, name)
    if not os.access(wrapper, os.X_OK):
        return
    entry = providers.setdefault(provider, {})
    current = entry.get("command")
    rest = list(current[1:]) if isinstance(current, list) and current else list(args)
    entry["command"] = [wrapper, *rest]
    print(f"{provider}: {' '.join(entry['command'])}")
point("claude", "claude")
point("factory-droid", "droid", ["exec", "--output-format", "acp-daemon"])
point("antigravity", "agy")
point("grok", "grok", ["agent", "--always-approve", "stdio"])
# grok needs the unattended ACP argv verbatim; keep argv[0] but correct the tail if it drifted.
grok_entry = providers.get("grok", {})
grok_cmd = grok_entry.get("command")
if isinstance(grok_cmd, list) and grok_cmd and grok_cmd[1:] != ["agent", "--always-approve", "stdio"]:
    grok_entry["command"] = [grok_cmd[0], "agent", "--always-approve", "stdio"]
    print(f"grok: {' '.join(grok_entry['command'])}")

# factory-paseo is the Paseo-mode face of the Factory subscription: a separate provider id so a def can
# run alongside native factory-droid, sharing the same droid wrapper and ACP argv.
droid = os.path.join(bindir, "droid")
if os.access(droid, os.X_OK):
    entry = providers.setdefault("factory-paseo", {})
    entry.update({"extends": "acp", "label": "Factory Droid（公司 Paseo 模式）",
        "description": "Factory Droid via Agent Client Protocol（公司 Paseo 模式，与原生 factory-droid 并存）",
        "command": [droid, "exec", "--output-format", "acp-daemon"],
        "env": {"DROID_DISABLE_AUTO_UPDATE": "true", "FACTORY_DROID_AUTO_UPDATE_ENABLED": "false"},
        "params": {"supportsMcpServers": False}, "enabled": True})
    print(f"factory-paseo: {' '.join(entry['command'])}")

# Muse Code: built-in Paseo provider. If it already carries a command we only retarget argv[0] at the
# wrapper (same rule as point()); otherwise enable it once a wrapper exists.
muse_bin = os.path.join(bindir, "muse")
if os.access(muse_bin, os.X_OK):
    entry = providers.setdefault("muse", {})
    current = entry.get("command")
    entry["command"] = [muse_bin, *current[1:]] if isinstance(current, list) and current else [muse_bin]
    entry["enabled"] = True
    print(f"muse: {' '.join(entry['command'])}")
else:
    print("muse: 未安装，跳过（老板安装并登录 Muse Code 后重跑）")
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
EOF
"$paseo" reload
echo "employee sandbox installed in $dest; new and resumed company sessions start sandboxed"
