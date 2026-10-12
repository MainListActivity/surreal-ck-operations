#!/bin/sh
# Copies the ops repo's src/ into server/vendor so the plugin bundler accepts the modules
# (plugin modules must live under client/|server/|shared/). Vendored files carry
# @ts-nocheck: they are already typechecked by the repo's own tsconfig.
set -eu
cd "$(dirname "$0")/.."
rm -rf server/vendor
mkdir -p server/vendor
cp -R ../src server/vendor/src
cp -R ../schema server/vendor/schema
find server/vendor -name '*.ts' -exec sh -c 'printf "// @ts-nocheck\n" | cat - "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \;

# Bundled plugin runtimes have no import.meta.url, so the approval-diagnosis code
# version cannot read sibling sources there (see proof-bridge.ts). Stamp the
# canonical source digest over the same file list and order into the vendored copy.
if command -v sha256sum >/dev/null 2>&1; then hash_cmd='sha256sum'; else hash_cmd='shasum -a 256'; fi
diagnostic_version=$(cat ../src/ops/proof-bridge.ts ../src/ops/proof-store.ts ../src/ops/proof-files.ts ../src/ops/proof-contract.ts ../src/ops/approval-diagnosis.ts | $hash_cmd | cut -d' ' -f1)
bridge=server/vendor/src/ops/proof-bridge.ts
grep -q '__SCK_BUNDLED_DIAGNOSTIC_VERSION__' "$bridge"
sed "s/__SCK_BUNDLED_DIAGNOSTIC_VERSION__/$diagnostic_version/" "$bridge" > "$bridge.tmp" && mv "$bridge.tmp" "$bridge"
