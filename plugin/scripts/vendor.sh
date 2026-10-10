#!/bin/sh
# Copies the ops repo's src/ and schema/ into server/vendor so the plugin bundler accepts the modules
# (plugin modules must live under client/|server/|shared/). Vendored files carry
# @ts-nocheck: they are already typechecked by the repo's own tsconfig.
set -eu
cd "$(dirname "$0")/.."
rm -rf server/vendor
mkdir -p server/vendor
cp -R ../src server/vendor/src
cp -R ../schema server/vendor/schema
find server/vendor -name '*.ts' -exec sh -c 'printf "// @ts-nocheck\n" | cat - "$1" > "$1.tmp" && mv "$1.tmp" "$1"' _ {} \;
