#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verifier="$repository_root/scripts/verify-immutable-release-attestation.sh"
fixture=$(mktemp -d)
cleanup() {
  rm -rf "$fixture"
}
trap cleanup EXIT

fake_bin="$fixture/bin"
evidence="$fixture/evidence"
mkdir -p "$fake_bin" "$evidence"
printf '%s\n' alpha > "$evidence/alpha.txt"
printf '%s\n' beta > "$evidence/beta.txt"

cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >> "$GH_CALL_LOG"
printf '\n' >> "$GH_CALL_LOG"
attempt=0
[[ ! -f $GH_ATTEMPT_FILE ]] || attempt=$(<"$GH_ATTEMPT_FILE")

asset_inventory() {
  local asset name size digest
  local -a assets=()
  while IFS= read -r -d '' asset; do
    assets+=("$asset")
  done < <(find "$GH_EVIDENCE_DIRECTORY" -mindepth 1 -maxdepth 1 -type f -print0)
  for asset in "${assets[@]}"; do
    name=${asset##*/}
    size=$(wc -c < "$asset")
    size=${size//[[:space:]]/}
    digest="sha256:$(sha256sum "$asset" | cut -d ' ' -f 1)"
    jq -cn --arg name "$name" --argjson size "$size" --arg digest "$digest" \
      '{name: $name, size: $size, digest: $digest}'
  done | jq -s 'sort_by(.name)'
}

if [[ $1 == api && $2 == --hostname && $3 == github.com ]]; then
  endpoint=$4
  case "$endpoint" in
    "repos/$GH_EXPECTED_REPOSITORY")
      repository=$GH_EXPECTED_REPOSITORY
      [[ $GH_SCENARIO != wrong_repository ]] || repository=unexpected/repository
      jq -cn --arg repository "$repository" '{full_name: $repository}'
      ;;
    "repos/$GH_EXPECTED_REPOSITORY/releases/tags/$GH_EXPECTED_TAG")
      release_id=$GH_EXPECTED_RELEASE_ID
      release_tag=$GH_EXPECTED_TAG
      immutable=true
      [[ $GH_SCENARIO != wrong_release ]] || release_id=999
      [[ $GH_SCENARIO != wrong_tag ]] || release_tag=oxide-relayer-exact-v0.0.0
      [[ $GH_SCENARIO != mutable_release ]] || immutable=false
      assets=$(asset_inventory)
      if [[ $GH_SCENARIO == asset_drift && $attempt -ge 1 ]]; then
        assets=$(jq '. + [{name:"unexpected.txt",size:1,digest:"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}] | sort_by(.name)' <<<"$assets")
      fi
      jq -cn \
        --argjson releaseId "$release_id" \
        --arg tag "$release_tag" \
        --argjson immutable "$immutable" \
        --argjson assets "$assets" \
        '{id: $releaseId, tag_name: $tag, draft: false, immutable: $immutable, assets: $assets}'
      ;;
    "repos/$GH_EXPECTED_REPOSITORY/git/ref/tags/$GH_EXPECTED_TAG")
      jq -cn --arg tagObject "$GH_EXPECTED_TAG_OBJECT" '{object: {type: "tag", sha: $tagObject}}'
      ;;
    "repos/$GH_EXPECTED_REPOSITORY/git/tags/$GH_EXPECTED_TAG_OBJECT")
      target=$GH_EXPECTED_TARGET_COMMIT
      [[ $GH_SCENARIO != tag_target_drift || $attempt -lt 1 ]] \
        || target=ffffffffffffffffffffffffffffffffffffffff
      jq -cn \
        --arg tag "$GH_EXPECTED_TAG" \
        --arg target "$target" \
        '{tag: $tag, object: {type: "commit", sha: $target}, verification: {verified: true}}'
      ;;
    *)
      printf 'unexpected fake gh API endpoint: %s\n' "$endpoint" >&2
      exit 1
      ;;
  esac
  exit 0
fi

if [[ $1 == release && $2 == verify ]]; then
  [[ $3 == "$GH_EXPECTED_TAG" && $4 == --repo && $5 == "github.com/$GH_EXPECTED_REPOSITORY" ]] \
    || { printf '%s\n' 'release verification identity drifted' >&2; exit 1; }
  attempt=$((attempt + 1))
  printf '%d\n' "$attempt" > "$GH_ATTEMPT_FILE"
  case "$GH_SCENARIO" in
    transient_success|timeout|tag_target_drift|asset_drift)
      if [[ $GH_SCENARIO == timeout || $attempt -eq 1 ]]; then
        printf 'no attestations for tag %s (sha1:%s)\n' "$GH_EXPECTED_TAG" "$GH_EXPECTED_TAG_OBJECT" >&2
        exit 1
      fi
      ;;
    authentication_failure)
      printf '%s\n' 'HTTP 403: Resource not accessible by integration' >&2
      exit 1
      ;;
    network_failure)
      printf '%s\n' 'failed to connect to api.github.com' >&2
      exit 1
      ;;
  esac
  printf '{"tagName":"%s","verificationResult":"verified"}\n' "$GH_EXPECTED_TAG"
  exit 0
fi

if [[ $1 == release && $2 == verify-asset ]]; then
  [[ $3 == "$GH_EXPECTED_TAG" && $5 == --repo && $6 == "github.com/$GH_EXPECTED_REPOSITORY" ]] \
    || { printf '%s\n' 'asset verification identity drifted' >&2; exit 1; }
  printf '%s\n' "$4" >> "$GH_ASSET_LOG"
  if [[ $GH_SCENARIO == asset_verification_failure ]]; then
    printf '%s\n' 'asset digest verification failed' >&2
    exit 1
  fi
  exit 0
fi

printf 'unexpected or mutating fake gh invocation: %q\n' "$*" >&2
exit 1
FAKE_GH
chmod 0700 "$fake_bin/gh"

export PATH="$fake_bin:$PATH"
export GH_EXPECTED_REPOSITORY=DROOdotFOO/zkmoney-public
export GH_EXPECTED_TAG=oxide-relayer-exact-v1.0.9
export GH_EXPECTED_RELEASE_ID=123456
export GH_EXPECTED_TAG_OBJECT=1111111111111111111111111111111111111111
export GH_EXPECTED_TARGET_COMMIT=2222222222222222222222222222222222222222
export GH_EVIDENCE_DIRECTORY="$evidence"
export GH_ATTEMPT_FILE="$fixture/attempts"
export GH_CALL_LOG="$fixture/calls"
export GH_ASSET_LOG="$fixture/assets"
export RELEASE_VERIFY_MAX_ATTEMPTS=3
export RELEASE_VERIFY_INTERVAL_SECONDS=0
export RELEASE_VERIFY_DEADLINE_SECONDS=30
export RELEASE_VERIFY_REQUEST_TIMEOUT_SECONDS=5

run_verifier() {
  scripts_output=$1
  "$verifier" \
    "$GH_EXPECTED_REPOSITORY" \
    "$GH_EXPECTED_TAG" \
    "$GH_EXPECTED_RELEASE_ID" \
    "$GH_EXPECTED_TAG_OBJECT" \
    "$GH_EXPECTED_TARGET_COMMIT" \
    "$evidence" \
    "$scripts_output"
}

reset_case() {
  rm -f "$GH_ATTEMPT_FILE" "$GH_CALL_LOG" "$GH_ASSET_LOG" "$fixture/verified.json"
}

assert_no_mutation_call() {
  ! grep -Eq '^release (create|delete|edit|upload) ' "$GH_CALL_LOG"
}

expect_success() {
  local scenario=$1
  local expected_attempts=$2
  reset_case
  export GH_SCENARIO=$scenario
  run_verifier "$fixture/verified.json"
  jq -e \
    --arg tag "$GH_EXPECTED_TAG" \
    '.tagName == $tag and .verificationResult == "verified"' \
    "$fixture/verified.json" > /dev/null
  [[ $(<"$GH_ATTEMPT_FILE") == "$expected_attempts" ]]
  (($(wc -l < "$GH_ASSET_LOG") == 2))
  assert_no_mutation_call
}

expect_failure() {
  local scenario=$1
  local expected_attempts=$2
  local expected_error=$3
  reset_case
  export GH_SCENARIO=$scenario
  if run_verifier "$fixture/verified.json" 2> "$fixture/error"; then
    printf 'scenario unexpectedly passed: %s\n' "$scenario" >&2
    exit 1
  fi
  attempts=0
  [[ ! -f $GH_ATTEMPT_FILE ]] || attempts=$(<"$GH_ATTEMPT_FILE")
  [[ $attempts == "$expected_attempts" ]]
  grep -Fq "$expected_error" "$fixture/error"
  assert_no_mutation_call
}

expect_success immediate_success 1
expect_success transient_success 2
expect_failure timeout 3 'remained unavailable at the attempt limit'
expect_failure authentication_failure 1 'non-retryable error'
expect_failure network_failure 1 'non-retryable error'
expect_failure wrong_repository 0 'repository identity drifted'
expect_failure wrong_tag 0 'release identity or immutable state drifted'
expect_failure wrong_release 0 'release identity or immutable state drifted'
expect_failure mutable_release 0 'release identity or immutable state drifted'
expect_failure tag_target_drift 1 'signed tag object or target drifted'
expect_failure asset_drift 1 'published release asset inventory drifted'
expect_failure asset_verification_failure 1 'asset digest verification failed'

printf '%s\n' 'immutable release attestation verifier regression: PASS'
