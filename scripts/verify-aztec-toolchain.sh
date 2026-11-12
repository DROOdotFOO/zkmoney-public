#!/usr/bin/env bash
# Verifies the installed Aztec toolchain against the reviewed hashes, after the Aztec installer has run.
# The installer chain fetches aztec-up, noirup and foundryup unpinned; this pins what the build then executes:
# the version manifest, the npm lock that `npm ci` enforces, and every bundled native binary.
set -euo pipefail

version=${1:?usage: verify-aztec-toolchain.sh VERSION}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
manifest="$script_dir/aztec-toolchain-$version-$platform.sha256"
toolchain="${AZTEC_HOME:-$HOME/.aztec}/versions/$version"

if [[ ! -f "$manifest" ]]; then
  printf 'no reviewed Aztec toolchain hashes for %s on %s\n' "$version" "$platform" >&2
  exit 1
fi
if [[ "$(readlink -f "${AZTEC_HOME:-$HOME/.aztec}/current")" != "$(readlink -f "$toolchain")" ]]; then
  printf 'the active Aztec toolchain is not version %s\n' "$version" >&2
  exit 1
fi
(cd "$toolchain" && sha256sum --strict --check "$manifest")
