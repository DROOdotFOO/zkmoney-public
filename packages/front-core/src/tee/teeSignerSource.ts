import { createPublicClient, fallback, http, type Chain, type Hex } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { ContractService, loadTeeSigner, type RegisteredTeeSigner } from "@obsidion/sdk"
import { logger } from "../utils/logger"

/**
 * A resolvable source of a `RegisteredTeeSigner`, injected into the `teeSigner` resource so it
 * stays environment-agnostic. The resource calls `load()`, the token takes the result, and
 * `load()` runs again whenever `subscribe` fires. Which concrete source is wired (attested oxide enclave vs. sandbox
 * dev relayer) is decided by the environment-aware app layer.
 */
export interface TeeSignerSource {
  /** Short non-secret label for connect logging. */
  readonly label: string
  /** Resolve a signer. Returns `undefined` for a benign skip (nothing to
   *  connect yet); throws for a real failure (which triggers `refresh`). */
  load(): Promise<RegisteredTeeSigner | undefined>
  /** Subscribe to "reload now" signals (e.g. an oxide manifest roll).
   *  Returns an unsubscribe fn. Static sources may omit it. */
  subscribe?(onChange: () => void): () => void
  /** Asked once after a failed `load()`; a source backed by a refreshable
   *  manifest can re-fetch so the next `subscribe` tick reconnects. */
  refresh?(): void
}

/** Connects a signer for the domain of the L1 portal `portal` over the enclave fleet at `fleetUrl`. */
export type FleetSignerConnector = (fleetUrl: string, portal: Hex) => Promise<RegisteredTeeSigner>

/** Connects fresh `FleetSigner`s, reading each portal's `TeeRegistry` over `l1RpcUrl`. */
export function fleetSignerConnector(l1RpcUrl: string, l1Chain: Chain): FleetSignerConnector {
  // `ViemClient` requires `FallbackTransport<HttpTransport[]>`, and the `as unknown` bridges the readonly-vs-mutable
  // tuple mismatch between this viem copy and the one the sdk uses. The http `timeout` bounds the L1 reads (the portal
  // domain and the `TeeRegistry` registration) that `FleetSigner.connect()` makes outside its own AbortController.
  const client = () =>
    createPublicClient({
      chain: l1Chain,
      transport: fallback([http(l1RpcUrl, { timeout: 10_000 })]),
    }) as unknown as Parameters<typeof loadTeeSigner>[2]
  return (fleetUrl, portal) => loadTeeSigner(fleetUrl, portal, client())
}

/**
 * One signer per fleet and portal domain, shared by every flow that signs for that domain: one fleet serves every
 * token, and a request names its domain. A `FleetSigner` re-pins itself when its enclave goes, so only a failed connect
 * leaves the cache.
 */
export function sharedFleetSigners(connect: FleetSignerConnector): FleetSignerConnector {
  const signers = new Map<string, Promise<RegisteredTeeSigner>>()
  return (fleetUrl, portal) => {
    const key = `${fleetUrl}|${portal.toLowerCase()}`
    let signer = signers.get(key)
    if (!signer) {
      const pending = connect(fleetUrl, portal)
      signers.set(key, pending)
      pending.catch(() => {
        if (signers.get(key) === pending) signers.delete(key)
      })
      signer = pending
    }
    return signer
  }
}

export interface OxideTeeSignerSourceOptions {
  /** L1 JSON-RPC URL for the chain the TEE binding lives on. */
  l1RpcUrl: string
  /** Viem `Chain` for the L1 (must match `l1RpcUrl`). */
  l1Chain: Chain
  /**
   * Optional transform applied to the manifest's `enclaveUrl` before connecting — lets a caller
   * rewrite a sandbox-local host (e.g. `localhost` to a LAN IP for a physical device) without this
   * environment-agnostic module knowing about device-specific URL rewriting itself.
   */
  transformEnclaveUrl?(url: string): string
  /**
   * The deployment whose enclave to connect to, for a wallet that holds more than one. Without it
   * the source follows the contract service's manifest tuple and its rolls; with it the source is
   * static, and its owner builds a new one when that deployment changes.
   */
  getTuple?(): Pick<OxideEnvTuple, "portal" | "enclaveUrl"> | undefined
  /** How the source connects; a fresh signer per load when absent. */
  connect?: FleetSignerConnector
}

/**
 * Attested signer source for testnet/mainnet. The enclave URL + portal flow
 * from the oxide env-registry tuple (`ContractService.getOxideClient()`); the
 * source reads the current tuple per `load()` so a fresh enclave URL is never
 * mixed with a stale portal. `subscribe` refires on manifest rolls.
 *
 * An enclave that the portal's `TeeRegistry` does not register is refused at connect and never
 * reaches `TokenService`; the caller's retry re-pins.
 *
 * The client is resolved lazily inside each method — never at construction —
 * so the source can be built before `ContractService` has its singleton.
 */
export function createOxideTeeSignerSource(options: OxideTeeSignerSourceOptions): TeeSignerSource {
  const { l1Chain, transformEnclaveUrl, getTuple } = options
  const connect = options.connect ?? fleetSignerConnector(options.l1RpcUrl, l1Chain)

  const getClient = () => {
    try {
      return ContractService.getInstance().getOxideClient()
    } catch {
      // getInstance throws before the provider constructs the singleton.
      return undefined
    }
  }

  return {
    label: `remote:${l1Chain.id}`,
    async load() {
      const tuple = getTuple ? getTuple() : getClient()?.getCurrentTuple()
      if (!tuple) return undefined // degraded boot — no manifest tuple yet
      const { portal, enclaveUrl } = tuple
      // Defend against a malformed portal. The client validates the manifest,
      // but an empty value would otherwise pass straight into
      // OxidePortalContract and fail far from here with an opaque viem message.
      if (!/^0x[0-9a-fA-F]{40}$/.test(portal)) {
        logger.warn("[teeSignerSource] connect skipped: portal address missing or malformed", {
          portal,
        })
        return undefined
      }
      const resolvedEnclaveUrl = transformEnclaveUrl ? transformEnclaveUrl(enclaveUrl) : enclaveUrl
      return await connect(resolvedEnclaveUrl, portal as Hex)
    },
    subscribe(onChange) {
      const client = getTuple ? undefined : getClient()
      if (!client) return () => {}
      return client.subscribe(() => onChange())
    },
    refresh() {
      if (getTuple) return
      try {
        void getClient()?.refresh()
      } catch {
        // getInstance can throw in teardown races; degraded state stands.
      }
    },
  }
}
