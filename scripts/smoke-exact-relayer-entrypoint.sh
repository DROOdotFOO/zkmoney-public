#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: smoke-exact-relayer-entrypoint.sh IMAGE}
[[ $(docker info --format '{{.OSType}}') == linux ]] || { printf '%s\n' 'exact entrypoint smoke requires a Linux Docker daemon' >&2; exit 1; }

fixture=$(mktemp -d)
cleanup() {
  docker run --rm --entrypoint rm \
    --mount "type=bind,src=$fixture,dst=/fixture" \
    "$image" -rf /fixture/canonical /fixture/config >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
canonical="$fixture/canonical"
config="$fixture/config"
mkdir -p "$canonical" "$config"
chmod 0700 "$canonical" "$config"

printf 'smoke portal state\n' > "$canonical/oxide-relayer-smoke.sqlite3"
printf '{"schema":1,"kind":"generic","clean":true}\n' > "$canonical/oxide-relayer.runtime-lease.sqlite3.clean-handoff.json"
chmod 0600 "$canonical"/*

source_commit=$(docker run --rm --entrypoint cat "$image" /app/source-commit)
image_digest="sha256:$(printf '%064d' 0)"
export canonical config source_commit image_digest
python3 <<'PY'
import hashlib
import json
import os
import pathlib
import stat

canonical = pathlib.Path(os.environ['canonical'])
config = pathlib.Path(os.environ['config'])

def digest(data: bytes) -> str:
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def canonical_json(value: object) -> str:
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value, separators=(',', ':'))
    if isinstance(value, list):
        return '[' + ','.join(canonical_json(item) for item in value) + ']'
    return '{' + ','.join(
        json.dumps(key) + ':' + canonical_json(value[key]) for key in sorted(value)
    ) + '}'

artifacts = []
for path in sorted(candidate for candidate in canonical.rglob('*') if candidate.is_file()):
    metadata = path.stat()
    artifacts.append({
        'path': path.relative_to(canonical).as_posix(),
        'present': True,
        'size': metadata.st_size,
        'sha256': digest(path.read_bytes()),
        'uid': 1000,
        'gid': 1000,
        'mode': format(stat.S_IMODE(metadata.st_mode), '04o'),
    })
state_hash = hashlib.sha256(b'oxide-relayer-canonical-state-v2\0')
for artifact in artifacts:
    state_hash.update((
        f"{artifact['path']}\0{artifact['size']}\0{artifact['sha256']}\0"
        f"{artifact['uid']}\0{artifact['gid']}\0{artifact['mode']}\0"
    ).encode())
canonical_state_digest = 'sha256:' + state_hash.hexdigest()
inventory = {
    'schema': 'oxide-relayer.state-inventory.v3',
    'container': {
        'capAdd': ['DAC_READ_SEARCH', 'SETGID', 'SETUID'],
        'capDrop': ['ALL'],
        'command': ['run'],
        'entrypoint': ['node', 'dest/bin/oxide-relayer-init.js'],
        'environment': [],
        'image': os.environ['image_digest'],
        'ipcMode': 'private',
        'labels': {
            'com.docker.compose.project': 'oxide-relayer-smoke',
            'com.docker.compose.service': 'oxide-relayer',
        },
        'mounts': [{
            'destination': '/canonical',
            'mode': 'ro',
            'propagation': 'rprivate',
            'source': str(canonical),
            'type': 'bind',
            'readOnly': True,
        }],
        'name': 'oxide-relayer-smoke',
        'networkMode': 'none',
        'pidMode': '',
        'pidsLimit': 256,
        'privileged': False,
        'project': 'oxide-relayer-smoke',
        'readOnlyRootfs': True,
        'restartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
        'securityOptions': ['no-new-privileges:true'],
        'service': 'oxide-relayer',
        'user': '0:0',
        'workingDirectory': '/app',
    },
    'artifacts': artifacts,
    'canonicalStateDigest': canonical_state_digest,
}
inventory_bytes = (canonical_json(inventory) + '\n').encode()
(config / 'state-inventory.json').write_bytes(inventory_bytes)
runtime = {
    'host': 'exact-smoke',
    'sourceCommit': os.environ['source_commit'],
    'imageDigest': os.environ['image_digest'],
    'runtimeUid': 65532,
    'runtimeGid': 65532,
    'signerAddress': '0x' + '00' * 20,
    'schemaIdentity': 'oxide-relayer.sqlite.portal-v4+exact-v3+generic-v2+lease-v1+runtime-v2',
    'stateInventoryDigest': digest(b'oxide-relayer-state-inventory-v3\0' + inventory_bytes),
    'canonicalStateDigest': canonical_state_digest,
    'expectedNonce': 0,
}
(config / 'runtime-identity.json').write_text(canonical_json(runtime) + '\n')
PY
chmod 0400 "$config"/*.json
docker run --rm --entrypoint chown \
  --mount "type=bind,src=$fixture,dst=/fixture" \
  "$image" -R 1000:1000 /fixture/canonical
docker run --rm --entrypoint chown \
  --mount "type=bind,src=$fixture,dst=/fixture" \
  "$image" 0:0 /fixture/config /fixture/config/runtime-identity.json /fixture/config/state-inventory.json

before=$(docker run --rm --entrypoint tar \
  --mount "type=bind,src=$canonical,dst=/canonical,readonly" \
  "$image" --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -C /canonical -cf - . | sha256sum)
runtime_args=(
  --rm --pull never --interactive
  --read-only
  --user 0:0
  --network none
  --hostname exact-smoke
  --mount "type=bind,src=$canonical,dst=/canonical,readonly"
  --tmpfs /control:rw,noexec,nosuid,nodev,uid=65532,gid=65532,mode=0700
  --mount "type=bind,src=$config,dst=/run/config/oxide-relayer,readonly"
  --tmpfs /run/secrets/oxide-relayer:rw,noexec,nosuid,nodev,uid=0,gid=0,mode=0700
  --tmpfs /tmp:rw,noexec,nosuid,nodev,uid=65532,gid=65532,mode=0700
  --cap-drop ALL
  --cap-add SETUID
  --cap-add SETGID
  --cap-add DAC_READ_SEARCH
  --security-opt no-new-privileges:true
  --pids-limit 256
  --env OXIDE_EXACT_RUNTIME_UID=65532
  --env OXIDE_EXACT_RUNTIME_GID=65532
)
if ! printf '%s' '{"schema":"oxide-relayer.preflight-exact.v1"}' | docker run "${runtime_args[@]}" \
  "$image" preflight-exact --bundle-fd 0 --canonical-state /canonical --control-dir /control; then
  if [[ ${OXIDE_SMOKE_DIAGNOSTIC:-0} == 1 ]]; then
    printf '%s' '{"schema":"oxide-relayer.preflight-exact.v1"}' | docker run "${runtime_args[@]}" \
      --entrypoint node "$image" --input-type=module --eval '
        const argv = ["preflight-exact", "--bundle-fd", "0", "--canonical-state", "/canonical", "--control-dir", "/control"];
        try {
          const sandbox = await import("/app/dest/exact_operation/runtime_sandbox.js");
          await sandbox.initializeRuntimeSandbox(sandbox.runtimeProfileFromArguments(argv), argv);
          console.error("synthetic smoke: sandbox initialization passed");
          const { preflightExactOperation } = await import("/app/dest/exact_operation/preflight.js");
          await preflightExactOperation({ bundleFd: 0, canonicalState: "/canonical", controlDir: "/control" });
          console.error("synthetic smoke: preflight passed");
        } catch (error) {
          console.error(error instanceof Error ? error.stack : String(error));
          process.exitCode = 1;
        }'
  fi
  exit 1
fi
after=$(docker run --rm --entrypoint tar \
  --mount "type=bind,src=$canonical,dst=/canonical,readonly" \
  "$image" --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -C /canonical -cf - . | sha256sum)
[[ $after == "$before" ]]
