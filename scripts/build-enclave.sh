#!/usr/bin/env bash
# Build the Oxide enclave image (EIF) from vendor/oxide and print its measurements.
# Usage: scripts/build-enclave.sh [OUTPUT_DIR]
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p "${1:-dist/enclave}"
output_dir=$(cd "${1:-dist/enclave}" && pwd)

builder=oxide-enclave
image_tag=oxide-enclave:reproduce

docker buildx inspect "$builder" > /dev/null 2>&1 ||
  docker buildx create --name "$builder" --driver docker-container --driver-opt image=moby/buildkit:v0.32.2 > /dev/null

# The release build used files with group write permission, and the image keeps file modes.
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
tar -C vendor/oxide --exclude=node_modules --exclude=dest -cf - .dockerignore enclave yarn-project | tar -C "$context" -xf -
chmod -R u=rwX,g=rwX,o=rX "$context"

docker buildx build --builder "$builder" --platform linux/amd64 --no-cache --pull --progress plain \
  --output type=docker,rewrite-timestamp=true --build-arg SOURCE_DATE_EPOCH=0 \
  --file "$context/enclave/Dockerfile" --iidfile "$output_dir/image.id" --tag "$image_tag" "$context"

nitro-cli build-enclave --docker-uri "$image_tag" --output-file "$output_dir/oxide.eif" > "$output_dir/build-output.txt"
nitro-cli describe-eif --eif-path "$output_dir/oxide.eif" | jq -S '.Measurements | {PCR0, PCR1, PCR2}' |
  tee "$output_dir/measurements.json"
