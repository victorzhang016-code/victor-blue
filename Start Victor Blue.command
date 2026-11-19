#!/bin/bash
set -eu
directory="$(cd "$(dirname "$0")" && pwd)"
runtime="$directory/runtime/node"
if [[ ! -x "$runtime" ]]; then
  runtime="$(command -v node || true)"
fi
if [[ -z "$runtime" ]] || ! "$runtime" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf '%s\n' 'Victor Blue needs Node.js 22+ when running from source. The macOS downloads bundle it.'
  exit 1
fi
"$runtime" "$directory/scripts/launcher.mjs"
