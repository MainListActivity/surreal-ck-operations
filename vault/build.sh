#!/bin/sh
# Builds sck-vault and sck-sync-attest. Production: installed to <service home>/bin/, ad-hoc
# signed with the hardened runtime and no entitlements (the vault Keychain ACL is bound to that
# exact binary), plus a launchd plist next to it. --test: separate binaries for the test suite,
# fed by environment variables; they are never installed and cannot read the production item.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
home="${SCK_SERVICE_HOME:-$HOME/Library/Application Support/SurrealCKCompany}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "${1:-}" = "--test" ]; then
  out="$here/build/sck-vault-test"; attest_out="$here/build/sck-sync-attest-test"; flags="-DSCK_VAULT_TEST"
  install_path="/nonexistent/bin/sck-vault"; attest_path="/nonexistent/bin/sck-sync-attest"; build_home="/nonexistent"
else
  out="$home/bin/sck-vault"; attest_out="$home/bin/sck-sync-attest"; flags=""
  install_path="$home/bin/sck-vault"; attest_path="$home/bin/sck-sync-attest"; build_home="$home"
fi
cat > "$work/Generated.swift" <<EOF
enum Build {
    static let installPath = "$install_path"
    static let attestInstallPath = "$attest_path"
    static let home = "$build_home"
}
EOF
mkdir -p "$(dirname "$out")"
swiftc -O $flags "$here/main.swift" "$work/Generated.swift" -o "$work/sck-vault"
swiftc -O $flags "$here/attest/main.swift" "$work/Generated.swift" -o "$work/sck-sync-attest"
codesign -s - -f --options runtime "$work/sck-vault"
codesign -s - -f --options runtime "$work/sck-sync-attest"
mv "$work/sck-vault" "$out"
mv "$work/sck-sync-attest" "$attest_out"
if [ -z "$flags" ]; then
  mkdir -p "$home/vault"
  cat > "$home/vault/org.surrealck.vault.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.surrealck.vault</string>
  <key>ProgramArguments</key>
  <array><string>$install_path</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$home/vault/vault.log</string>
  <key>StandardOutPath</key><string>$home/vault/vault.log</string>
</dict>
</plist>
PLIST
  echo "launchd plist: $home/vault/org.surrealck.vault.plist"
fi
echo "built $out"
echo "built $attest_out"
