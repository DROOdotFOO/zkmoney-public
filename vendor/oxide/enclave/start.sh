#!/bin/sh
# Enclave entry. Sets up loopback, bridges VSOCK→TCP loopback for inbound RPC,
# then execs the Node enclave app. No outbound network — the signer is pure.
set -eu

# Loopback (Nitro Enclaves don't have it by default). Without lo up, the inbound socat
# can't reach the Node app on 127.0.0.1:$TCP_PORT and bytes silently disappear, so guard
# against the toolchain being missing with a loud abort rather than silent breakage.
if ! command -v ip >/dev/null 2>&1; then
    echo "[start.sh] FATAL: 'ip' missing from image; install iproute2 in the Dockerfile." >&2
    exit 1
fi
ip addr add 127.0.0.1/8 dev lo
ip link set lo up

# Verify the kernel's current hardware RNG is the Nitro Security Module's hwrng before any key
# material is generated. Catches EIF build regressions where the nsm-hwrng module fails to load.
RNG="$(cat /sys/devices/virtual/misc/hw_random/rng_current 2>/dev/null || echo MISSING)"
if [ "$RNG" != "nsm-hwrng" ]; then
    echo "[start.sh] FATAL: hwrng is '$RNG', expected 'nsm-hwrng'" >&2
    exit 1
fi

# Verify the kernel's clocksource is kvm-clock. The enclave makes no time-dependent trust
# decisions internally, but TSC under virtualization can start at an arbitrary host-chosen
# value, so a wrong clocksource is a signal the EIF kernel was built unexpectedly. Cheap
# defense-in-depth + catches kernel-config regressions.
CLOCK="$(cat /sys/devices/system/clocksource/clocksource0/current_clocksource 2>/dev/null || echo MISSING)"
if [ "$CLOCK" != "kvm-clock" ]; then
    echo "[start.sh] FATAL: clocksource is '$CLOCK', expected 'kvm-clock'" >&2
    exit 1
fi

# Defense-in-depth: assert PCRs 0..2 are locked before boot.
/usr/bin/nsm-describe-pcrs

VSOCK_PORT="${OXIDE_TEE_VSOCK_LISTEN_PORT:-5000}"
TCP_PORT="${OXIDE_TEE_LISTEN_PORT:-5001}"

# Bridge: anyone connecting to VSOCK port $VSOCK_PORT is forwarded to 127.0.0.1:$TCP_PORT,
# where the Node app listens. `fork` allows multiple connections.
socat "VSOCK-LISTEN:${VSOCK_PORT},fork,reuseaddr" "TCP:127.0.0.1:${TCP_PORT}" &

exec node /app/yarn-project/tee-enclave/dest/main.js
