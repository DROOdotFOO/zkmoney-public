/**
 * Whether a pasted address is an ether.fi Cash deposit address. ether.fi uses one factory address
 * on every chain: on Optimism, where Cash accounts live, it creates each account's safe; on
 * Ethereum mainnet it deploys the account's top-up contract at the same address. Either factory
 * knowing the address confirms it, so an account whose mainnet top-up contract is not deployed yet
 * still passes. A refusal from both blocks the sheet: funds sent elsewhere never reach the Cash
 * balance.
 */
import { useEffect, useState } from "react"
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem"
import { mainnet, optimism } from "viem/chains"
import { Network } from "@obsidion/core/constants"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

/** ether.fi's factory: TopUpSourceFactory on Ethereum mainnet, EtherFiSafeFactory on Optimism. */
export const ETHERFI_FACTORY: Address = "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF"

export const ETHERFI_FACTORY_ABI = parseAbi([
  "function isTopUpContract(address topUpContract) view returns (bool)",
  "function isEtherFiSafe(address account) view returns (bool)",
])

export type EtherfiAddressVerdict =
  | { kind: "idle" } // no parseable address
  | { kind: "checking" }
  | { kind: "confirmed" } // the mainnet factory deployed its top-up contract
  | { kind: "account" } // the Optimism factory created its safe; no mainnet deposit yet
  | { kind: "rejected" } // neither factory knows it
  | { kind: "unknown" } // a read did not answer, and none confirmed it

type Reader = Pick<PublicClient, "readContract">

export interface EtherfiCheckDeps {
  mainnet: Reader
  optimism: Reader
}

const DEBOUNCE_MS = 300

export async function checkEtherfiAddress(
  address: Address,
  deps: EtherfiCheckDeps,
): Promise<EtherfiAddressVerdict> {
  const ask = (client: Reader, functionName: "isTopUpContract" | "isEtherFiSafe") =>
    client.readContract({
      address: ETHERFI_FACTORY,
      abi: ETHERFI_FACTORY_ABI,
      functionName,
      args: [address],
    })
  const [topUp, safe] = await Promise.allSettled([
    ask(deps.mainnet, "isTopUpContract"),
    ask(deps.optimism, "isEtherFiSafe"),
  ])
  if (topUp.status === "fulfilled" && topUp.value) return { kind: "confirmed" }
  if (safe.status === "fulfilled" && safe.value) return { kind: "account" }
  if (topUp.status === "rejected" || safe.status === "rejected") return { kind: "unknown" }
  return { kind: "rejected" }
}

/** Open RPCs that serve browsers from any origin, for builds that name none of their own. */
export const PUBLIC_MAINNET_RPC_URL = "https://ethereum-rpc.publicnode.com"
export const PUBLIC_OPTIMISM_RPC_URL = "https://optimism-rpc.publicnode.com"

/**
 * The mainnet client to ask: the wallet's own L1 client on mainnet, else a mainnet RPC of its own,
 * since a testnet or sandbox build's L1 client points at another chain.
 * `VITE_ETHEREUM_MAINNET_RPC_URL` names that RPC; the public one stands in otherwise.
 */
export function etherfiFactoryClient(): Reader {
  const config = getConfig()
  if (config.network === Network.MAINNET) return l1PublicClient(config)
  const url = import.meta.env.VITE_ETHEREUM_MAINNET_RPC_URL || PUBLIC_MAINNET_RPC_URL
  return createPublicClient({ chain: mainnet, transport: http(url, { timeout: 15_000 }) })
}

/** `VITE_OPTIMISM_RPC_URL` names the Optimism RPC; the public one stands in otherwise. */
export function etherfiOptimismClient(): Reader {
  const url = import.meta.env.VITE_OPTIMISM_RPC_URL || PUBLIC_OPTIMISM_RPC_URL
  return createPublicClient({ chain: optimism, transport: http(url, { timeout: 15_000 }) })
}

const liveDeps = (): EtherfiCheckDeps => ({
  mainnet: etherfiFactoryClient(),
  optimism: etherfiOptimismClient(),
})

/**
 * The verdict for the address in the field: `idle` while there is none, `checking` through the
 * debounce and the read, and a result only for the address still there. With `waitMs`, a read
 * still running by then reads `unknown` until its answer lands.
 */
export function useEtherfiAddressVerdict(
  address: Address | null,
  waitMs?: number,
): EtherfiAddressVerdict {
  const [verdict, setVerdict] = useState<EtherfiAddressVerdict>({ kind: "idle" })

  useEffect(() => {
    if (!address) {
      setVerdict({ kind: "idle" })
      return
    }
    let active = true
    setVerdict({ kind: "checking" })
    const timer = setTimeout(() => {
      checkEtherfiAddress(address, liveDeps())
        .catch((): EtherfiAddressVerdict => ({ kind: "unknown" }))
        .then((result) => {
          if (active) setVerdict(result)
        })
    }, DEBOUNCE_MS)
    const cap =
      waitMs &&
      setTimeout(() => setVerdict((v) => (v.kind === "checking" ? { kind: "unknown" } : v)), waitMs)
    return () => {
      active = false
      clearTimeout(timer)
      clearTimeout(cap)
    }
  }, [address, waitMs])

  return verdict
}
