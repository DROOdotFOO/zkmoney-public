# Build context = repo root. The repo's .dockerignore keeps the context small (no node_modules).
#
# Three stages:
#   1. nsm-attest-builder: compiles the Rust NSM attestation helper to a static
#      musl binary that the runtime stage COPYs into /usr/bin/nsm-attest.
#   2. builder: runs yarn install + oxide-lib-tee/tee-enclave build under Linux/glibc
#      (Debian-slim — Alpine/musl breaks @crate-crypto/node-eth-kzg, which is
#      pulled in transitively via @aztec-labs/stdlib → @aztec-labs/blob-lib and only ships
#      glibc binaries).
#   3. runtime: slim image hosting the compiled JS, the NSM helper, and a socat
#      bridge from VSOCK to TCP loopback. No KMS, no outbound network.

# ---------- Stage 1: nsm-attest builder (Rust → static musl binary) ----------
# The base image digest and the toolchain in rust-toolchain.toml are pinned.
# Every apt-using stage shares the dated Debian snapshot in enclave/debian.sources;
# rotate that file deliberately and remeasure PCR0 when updating packages.
FROM rust:1.83-slim-bookworm@sha256:0f0dc99eb74e410d9420149cbb2b9be84abe00e8dbed6a4201a591a2c81844df AS nsm-attest-builder
WORKDIR /build
COPY enclave/debian.sources /etc/apt/sources.list.d/debian.sources
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    CARGO_NET_OFFLINE=false \
    CARGO_TERM_COLOR=never

# musl-tools provides the musl-gcc linker the x86_64-unknown-linux-musl target uses.
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-musl

# Copy crate sources (Cargo.lock is committed for deterministic dependency resolution).
COPY enclave/nsm-attest /build/

# --locked refuses to update Cargo.lock; --frozen additionally refuses to access the
# network for resolution. We let cargo fetch crates from crates.io against the locked
# versions, but never resolve a different version than what's pinned.
RUN cargo build --release --target x86_64-unknown-linux-musl --locked

# ---------- Stage 2: workspace builder (Node) ----------
# Base image pinned by manifest-list digest so a Hub re-tag of the Node image can't
# silently re-flow the build. To rotate: pull `node:<version>-bookworm-slim`, take the
# top-level `Digest:` line, paste the tag and digest below, and run the release build
# twice to compare the Docker image ID and PCR measurements. Last rotated 2026-10-21.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder
WORKDIR /repo
COPY enclave/debian.sources /etc/apt/sources.list.d/debian.sources

# Reproducibility envelope. SOURCE_DATE_EPOCH is consumed by Debian's apt tooling
# and Node's bundler outputs to stamp deterministic mtimes; the locale + TZ pins
# keep `sort`, `find`, and any tool that prints dates/strings consistent across
# runners. Pass SOURCE_DATE_EPOCH from build.sh (default 0 = epoch, which is good
# enough for byte-identical builds of the same SHA).
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Activate the pinned Yarn version once, up front.
RUN corepack enable && corepack prepare yarn@4.5.2 --activate

# Copy every workspace manifest so the focused install matches the lockfile.
# Only the two workspaces in the enclave's build graph need their source copied.
# @aztec-labs/* dependencies come from npm, not a submodule.
# yarn itself comes from corepack (above); the repo commits no .yarn/ releases,
# plugins, or file patches, so there is nothing under .yarn/ to copy.
COPY yarn-project/package.json yarn-project/yarn.lock yarn-project/.yarnrc.yml yarn-project/tsconfig.base.json /repo/yarn-project/
COPY yarn-project/account-service/package.json /repo/yarn-project/account-service/package.json
COPY yarn-project/l1-contracts/package.json /repo/yarn-project/l1-contracts/package.json
COPY yarn-project/l1-observer/package.json /repo/yarn-project/l1-observer/package.json
COPY yarn-project/noir-contracts.js/package.json /repo/yarn-project/noir-contracts.js/package.json
COPY yarn-project/oxide-client/package.json /repo/yarn-project/oxide-client/package.json
COPY yarn-project/oxide-lib-tee/package.json /repo/yarn-project/oxide-lib-tee/package.json
COPY yarn-project/oxide-lib/package.json /repo/yarn-project/oxide-lib/package.json
COPY yarn-project/oxide-relayer/package.json /repo/yarn-project/oxide-relayer/package.json
COPY yarn-project/refund-proof/package.json /repo/yarn-project/refund-proof/package.json
COPY yarn-project/resolver-lib/package.json /repo/yarn-project/resolver-lib/package.json
COPY yarn-project/resolver-proof/package.json /repo/yarn-project/resolver-proof/package.json
COPY yarn-project/resolver-service/package.json /repo/yarn-project/resolver-service/package.json
COPY yarn-project/snapshot-service/package.json /repo/yarn-project/snapshot-service/package.json
COPY yarn-project/tee-enclave/package.json /repo/yarn-project/tee-enclave/package.json
COPY yarn-project/tee-proxy/package.json /repo/yarn-project/tee-proxy/package.json
COPY yarn-project/tee-registrar/package.json /repo/yarn-project/tee-registrar/package.json
COPY yarn-project/tee-router/package.json /repo/yarn-project/tee-router/package.json
COPY yarn-project/telemetry/package.json /repo/yarn-project/telemetry/package.json
COPY yarn-project/watcher-lib/package.json /repo/yarn-project/watcher-lib/package.json
COPY yarn-project/oxide-lib-tee /repo/yarn-project/oxide-lib-tee
COPY yarn-project/tee-enclave /repo/yarn-project/tee-enclave

# Focused install includes build-time devDependencies of oxide-lib-tee and tee-enclave,
# while leaving unrelated workspaces out. The second focus removes devDependencies
# before node_modules is copied to the runtime image. Both installs retain the
# committed lockfile unchanged.
#
# node-gyp postinstalls run python; its implicit .pyc caches embed source mtimes, so keep them out
# of node_modules entirely.
ENV PYTHONDONTWRITEBYTECODE=1 \
    YARN_ENABLE_IMMUTABLE_INSTALLS=true
RUN cd yarn-project && \
    yarn workspaces focus @oxide/oxide-lib-tee @oxide/tee-enclave && \
    yarn workspace @oxide/oxide-lib-tee build && \
    yarn workspace @oxide/tee-enclave build && \
    yarn workspaces focus @oxide/oxide-lib-tee @oxide/tee-enclave --production

# ---------- Stage 3: runtime ----------
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
COPY enclave/debian.sources /etc/apt/sources.list.d/debian.sources

ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# apt/dpkg logs embed wall-clock timestamps; disable them up front so every apt layer below is
# reproducible.
RUN echo 'log /dev/null' >> /etc/dpkg/dpkg.cfg && \
    printf 'Dir::Log::History "";\nDir::Log::Terminal "";\nDir::Log::Planner "";\n' > /etc/apt/apt.conf.d/no-log

RUN apt-get update && apt-get install -y --no-install-recommends \
      socat curl ca-certificates \
      iproute2 \
    && rm -rf /var/lib/apt/lists/* && rm -f /var/cache/ldconfig/aux-cache
# iproute2: provides `ip`, used by start.sh to bring loopback up. Without it the enclave's
# internal socat can't connect to 127.0.0.1:5001 (the Node app), so the operator's request
# vanishes silently — "Network is unreachable".

# nsm-attest + nsm-describe-pcrs are built in the Rust stage as statically linked
# musl binaries and COPYed in here. No toolchain ships in the runtime image.
# nsm-attest:          produces the boot attestation document on stdin/stdout.
# nsm-describe-pcrs:   defense-in-depth check that PCRs 0..2 are locked at boot.
COPY --from=nsm-attest-builder /build/target/x86_64-unknown-linux-musl/release/nsm-attest /usr/bin/nsm-attest
COPY --from=nsm-attest-builder /build/target/x86_64-unknown-linux-musl/release/nsm-describe-pcrs /usr/bin/nsm-describe-pcrs

# Pre-download Barretenberg CRS data so bb.js WASM has no runtime network dependency.
# 128 bytes of BN254 G1 (the minimum bb.js will accept once getDefaultSrsSize is overridden
# to 1 in start.ts), full BN254 G2, and the full Grumpkin G1 v2 flat file (16 MB; bb.js reads only
# grumpkin_g1_v2.flat.dat and loads it whole regardless of srsSize).
# The checksums pin the downloaded bytes, so one artifact input hash maps to one EIF.
RUN mkdir -p /app/.bb-crs && \
    curl -sf -o /app/.bb-crs/bn254_g2.dat "https://crs.aztec-cdn.foundation/g2.dat" && \
    curl -sf -H "Range: bytes=0-127" -o /app/.bb-crs/bn254_g1.dat "https://crs.aztec-cdn.foundation/g1.dat" && \
    curl -sf -o /app/.bb-crs/grumpkin_g1_v2.flat.dat "https://crs.aztec-cdn.foundation/grumpkin_g1_v2.dat" && \
    printf '%s\n' \
      '01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f  /app/.bb-crs/bn254_g2.dat' \
      'c31e48521dee7e67349c230e835a69dd4afd6d306a4a3a2d94b8ad4d8726e6c2  /app/.bb-crs/bn254_g1.dat' \
      '87fe782860dd58f09a81f797b56346398aabe6e0ed98e0a5ccf14604dd8baee2  /app/.bb-crs/grumpkin_g1_v2.flat.dat' \
      | sha256sum -c --strict - && \
    apt-get purge -y curl && apt-get autoremove -y && rm -f /var/cache/ldconfig/aux-cache
ENV CRS_PATH=/app/.bb-crs

# Bring in the pruned dep tree + compiled JS from the builder. `node_modules` here is the
# output of `yarn workspaces focus --production` in the builder, so it contains only the
# runtime closure of @oxide/oxide-lib-tee + @oxide/tee-enclave. The two workspace dirs are then
# copied alongside so the workspace symlinks inside `node_modules/@oxide/*` resolve at runtime.
# No yarn, no skeleton — just what Node needs.
COPY --from=builder /repo/yarn-project/node_modules /app/yarn-project/node_modules
COPY --from=builder /repo/yarn-project/oxide-lib-tee/package.json /app/yarn-project/oxide-lib-tee/package.json
COPY --from=builder /repo/yarn-project/oxide-lib-tee/dest /app/yarn-project/oxide-lib-tee/dest
COPY --from=builder /repo/yarn-project/tee-enclave/package.json /app/yarn-project/tee-enclave/package.json
COPY --from=builder /repo/yarn-project/tee-enclave/dest /app/yarn-project/tee-enclave/dest

# Force bb.js to use the WASM backend by deleting the native `bb` binary and the NAPI stub.
# bb.js's backend selector falls through to WASM when neither is found. The shipped native
# binary has dynamic library deps that aren't present in the slim base image, so spawning it
# would fail with "Native backend process exited with code 1" mid-request.
# The two `find -path` patterns cover both bb.js packaging layouts: barretenberg/ts/build/<arch>/bb
# and bb.js/build/<arch>/bb.
RUN find /app -path '*/barretenberg/ts/build/*' -name 'bb' -type f -delete 2>/dev/null || true && \
    find /app -path '*/bb.js/build/*' -name 'bb' -type f -delete 2>/dev/null || true && \
    find /app -name 'nodejs_module.node' -delete 2>/dev/null || true && \
    echo "── post-delete: any bb binaries left? ──" && \
    find /app -name 'bb' -type f -executable

# Smoke-test libsecp256k1's native binding against the exact filesystem the enclave will
# boot with. Catches three failure modes: (1) `secp256k1`'s install script ends with
# `|| exit 0`, so a failed prebuild fetch + failed local compile would silently pass
RUN cd /app/yarn-project && \
    node -e "require('secp256k1/bindings.js').publicKeyCreate(Buffer.alloc(32, 1), false); console.log('libsecp256k1 native binding OK')"

ENV HARDWARE_CONCURRENCY=1
ENV OXIDE_TEE_LISTEN_PORT=5001
ENV OXIDE_TEE_VSOCK_LISTEN_PORT=5000

COPY enclave/start.sh /app/start.sh
RUN chmod +x /app/start.sh
CMD ["/app/start.sh"]
