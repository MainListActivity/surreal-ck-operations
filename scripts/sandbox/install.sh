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

# Paseo's claude provider takes only argv[0] of a replaced command, so each provider gets an executable.
wrap() { # wrap <name> <real binary>
  [ -x "$2" ] || { echo "skip $1: $2 not found" >&2; return 0; }
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$dest/launch.sh" "$2" > "$dest/bin/$1.tmp"
  chmod 0755 "$dest/bin/$1.tmp" && mv "$dest/bin/$1.tmp" "$dest/bin/$1"
}
wrap claude "$HOME/.local/bin/claude"
wrap droid "$HOME/.local/bin/droid"
wrap agy "$HOME/.local/bin/agy"

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
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp, path)
EOF
"$paseo" reload
echo "employee sandbox installed in $dest; new and resumed company sessions start sandboxed"
