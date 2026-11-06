#!/usr/bin/env bash
set -euo pipefail

repository=${1:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
tag=${2:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
release_id=${3:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
tag_object=${4:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
target_commit=${5:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
evidence_directory=${6:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
output=${7:?usage: verify-immutable-release-attestation.sh REPOSITORY TAG RELEASE_ID TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT}
max_attempts=${RELEASE_VERIFY_MAX_ATTEMPTS:-30}
interval_seconds=${RELEASE_VERIFY_INTERVAL_SECONDS:-10}
deadline_seconds=${RELEASE_VERIFY_DEADLINE_SECONDS:-300}
request_timeout_seconds=${RELEASE_VERIFY_REQUEST_TIMEOUT_SECONDS:-15}

fail() {
  printf 'immutable release verification failed: %s\n' "$1" >&2
  exit 1
}

[[ $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'repository must be an owner/name pair'
[[ $tag =~ ^[A-Za-z0-9._-]+$ ]] || fail 'tag is malformed'
[[ $release_id =~ ^[1-9][0-9]*$ ]] || fail 'release ID must be a positive integer'
[[ $tag_object =~ ^[0-9a-f]{40}$ ]] || fail 'tag object must be a lowercase SHA-1'
[[ $target_commit =~ ^[0-9a-f]{40}$ ]] || fail 'target commit must be a lowercase SHA-1'
[[ $max_attempts =~ ^[1-9][0-9]*$ ]] || fail 'maximum attempts must be a positive integer'
[[ $interval_seconds =~ ^[0-9]+$ ]] || fail 'interval must be a non-negative integer'
[[ $deadline_seconds =~ ^[1-9][0-9]*$ ]] || fail 'deadline must be a positive integer'
[[ $request_timeout_seconds =~ ^[1-9][0-9]*$ ]] || fail 'request timeout must be a positive integer'
[[ -d $evidence_directory ]] || fail 'release evidence directory does not exist'

working_directory=$(mktemp -d)
cleanup() {
  rm -rf "$working_directory"
}
trap cleanup EXIT

export GH_HOST=github.com
export GH_HTTP_TIMEOUT=$request_timeout_seconds
repository_with_host="github.com/$repository"
baseline_assets="$working_directory/baseline-assets.json"
current_assets="$working_directory/current-assets.json"
release_assets="$working_directory/release-assets.json"
attestation="$working_directory/release-attestation.json"
attestation_error="$working_directory/release-attestation.error"

build_local_asset_inventory() {
  local destination=$1
  local asset name size digest
  local -a assets=()
  while IFS= read -r -d '' asset; do
    assets+=("$asset")
  done < <(find "$evidence_directory" -mindepth 1 -maxdepth 1 -type f -print0)
  ((${#assets[@]} > 0)) || fail 'release evidence directory contains no assets'
  for asset in "${assets[@]}"; do
    name=${asset##*/}
    [[ $name != *$'\n'* ]] || fail 'release asset name contains a newline'
    size=$(wc -c < "$asset")
    size=${size//[[:space:]]/}
    digest="sha256:$(sha256sum "$asset" | cut -d ' ' -f 1)"
    jq -cn --arg name "$name" --argjson size "$size" --arg digest "$digest" \
      '{name: $name, size: $size, digest: $digest}'
  done | jq -s 'sort_by(.name)' > "$destination"
}

build_local_asset_inventory "$baseline_assets"

verify_identity() {
  local repository_json="$working_directory/repository.json"
  local release_json="$working_directory/release.json"
  local ref_json="$working_directory/tag-ref.json"
  local tag_json="$working_directory/tag-object.json"

  gh api --hostname github.com "repos/$repository" > "$repository_json"
  jq -e --arg repository "$repository" '.full_name == $repository' "$repository_json" > /dev/null \
    || fail 'repository identity drifted'

  gh api --hostname github.com "repos/$repository/releases/tags/$tag" > "$release_json"
  jq -e \
    --argjson releaseId "$release_id" \
    --arg tag "$tag" \
    '.id == $releaseId and .tag_name == $tag and .draft == false and .immutable == true' \
    "$release_json" > /dev/null \
    || fail 'release identity or immutable state drifted'

  gh api --hostname github.com "repos/$repository/git/ref/tags/$tag" > "$ref_json"
  jq -e --arg tagObject "$tag_object" \
    '.object.type == "tag" and .object.sha == $tagObject' "$ref_json" > /dev/null \
    || fail 'tag reference drifted'

  gh api --hostname github.com "repos/$repository/git/tags/$tag_object" > "$tag_json"
  jq -e \
    --arg tag "$tag" \
    --arg targetCommit "$target_commit" \
    '.tag == $tag
     and .object.type == "commit"
     and .object.sha == $targetCommit
     and .verification.verified == true' \
    "$tag_json" > /dev/null \
    || fail 'signed tag object or target drifted'

  build_local_asset_inventory "$current_assets"
  cmp -s "$baseline_assets" "$current_assets" || fail 'local release asset inventory drifted'
  jq '[.assets[] | {name, size, digest}] | sort_by(.name)' "$release_json" > "$release_assets"
  cmp -s "$baseline_assets" "$release_assets" || fail 'published release asset inventory drifted'
}

deadline=$((SECONDS + deadline_seconds))
verified=false
for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  ((SECONDS < deadline)) || fail 'attestation deadline expired'
  verify_identity
  ((SECONDS < deadline)) || fail 'attestation deadline expired during identity verification'

  if gh release verify "$tag" --repo "$repository_with_host" --format json \
    > "$attestation" 2> "$attestation_error"; then
    ((SECONDS < deadline)) || fail 'attestation deadline expired during verification'
    jq -e '. | type == "object"' "$attestation" > /dev/null \
      || fail 'release attestation response is malformed'
    verified=true
    printf 'immutable release attestation verified on attempt %d\n' "$attempt" >&2
    break
  fi
  ((SECONDS < deadline)) || fail 'attestation deadline expired during verification'

  error_message=$(<"$attestation_error")
  expected_error="no attestations for tag $tag (sha1:$tag_object)"
  [[ $error_message == "$expected_error" ]] || fail 'release attestation verification returned a non-retryable error'
  ((attempt < max_attempts)) || fail 'release attestation remained unavailable at the attempt limit'
  ((SECONDS + interval_seconds < deadline)) || fail 'release attestation remained unavailable at the deadline'
  printf 'immutable release attestation pending; retrying attempt %d of %d\n' "$((attempt + 1))" "$max_attempts" >&2
  sleep "$interval_seconds"
done

[[ $verified == true ]] || fail 'release attestation verification did not complete'
install -m 0600 "$attestation" "$output"

while IFS= read -r -d '' asset; do
  gh release verify-asset "$tag" "$asset" --repo "$repository_with_host"
done < <(find "$evidence_directory" -mindepth 1 -maxdepth 1 -type f -print0)
