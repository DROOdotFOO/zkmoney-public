/**
 * The page's wallet: one PXE per page, over the store the active tab opened. Lazy, so a pay page
 * that waits for demand boots nothing until a screen needs it. A failed boot waits for a reload.
 */
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { createLogger } from "@aztec-labs/foundation/log"
import { l1ChainIdForNetwork } from "@obsidion/core/constants"
import {
  memoryStore,
  resource,
  setActiveGenerationNode,
  type ReadonlyStore,
  type Resource,
} from "@obsidion/front-core"
import { ObsidionWallet } from "@obsidion/sdk"
import { getConfig } from "../config/env"
import { fireEvent } from "../lib/analytics"
import { provingDevice } from "../lib/provingDevice"
import type { PxeBootTarget } from "../ui/PxeBoot"
import { barretenbergWasm } from "./bbWasmPath"
import { isActiveTab } from "./storage/activeTab"
import { reloadPage } from "./storage/walletStorage"

export type PxeTarget = Extract<PxeBootTarget, { kind: "pxe" }>
/** `bb` is where the PXE's prover loads bb.js, when the page serves it. */
export type CreateWallet = (
  node: AztecNode,
  target: PxeTarget,
  bb: { wasmPath?: string },
) => Promise<ObsidionWallet>

/** The node did not answer a request; the transport error rides as `cause`. */
export class NodeUnreachableError extends Error {
  constructor(cause: unknown) {
    super("node did not answer", { cause })
    this.name = "NodeUnreachableError"
  }
}

function isNodeFetchFailure(e: unknown): boolean {
  const rpcError = e instanceof Error ? e.cause : undefined
  return (
    typeof rpcError === "object" &&
    rpcError !== null &&
    "data" in rpcError &&
    rpcError.data instanceof Error
  )
}

const DOWNLOAD_RELOADS_KEY = "pxeBoot.downloadReloads"
const MAX_DOWNLOAD_RELOADS = 2
const MODULE_DOWNLOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/

function isModuleDownloadFailure(e: unknown): boolean {
  if (e instanceof AggregateError) return e.errors.some(isModuleDownloadFailure)
  return e instanceof TypeError && MODULE_DOWNLOAD_FAILURE.test(e.message)
}

function takeDownloadReload(): boolean {
  try {
    const reloads = Number(sessionStorage.getItem(DOWNLOAD_RELOADS_KEY)) || 0
    if (reloads >= MAX_DOWNLOAD_RELOADS) return false
    sessionStorage.setItem(DOWNLOAD_RELOADS_KEY, String(reloads + 1))
    return true
  } catch {
    return false
  }
}

function clearDownloadReloads(): void {
  try {
    sessionStorage.removeItem(DOWNLOAD_RELOADS_KEY)
  } catch {
    return
  }
}

/** The wallet pinned to the identity the active tab checked against L1. */
const createWallet: CreateWallet = (node, { store, identity }, { wasmPath }) => {
  const config = getConfig()
  const pxeConfig = {
    proverEnabled: config.proverEnabled,
    proveTxPerfLogs: true,
    l1ChainId: l1ChainIdForNetwork(config.network),
  }
  return ObsidionWallet.create(
    node,
    pxeConfig,
    {
      loggers: {
        pxe: createLogger("pxe"),
        store: createLogger("pxe:store"),
        prover: createLogger("pxe:prover"),
      },
      // The boot's bb.js, so the first proof downloads it no second time.
      proverOrOptions: wasmPath ? { wasmPath } : undefined,
      store,
    },
    {
      chainInfo: { l1ChainId: identity.l1ChainId, rollupVersion: Number(identity.rollupVersion) },
      networkId: identity.rollupAddress,
    },
  )
}

/**
 * Boots the PXE. A tab another tab took over while it booted keeps it pending: it is reloading, and
 * closed the store under the PXE, so a failure is expected. A failed module download reloads the
 * page, twice at most.
 */
async function boot(node: AztecNode, target: PxeTarget, create: CreateWallet) {
  try {
    const wallet = await create(node, target, barretenbergWasm())
    setActiveGenerationNode(wallet.node)
    fireEvent("pxe_boot_completed", {
      duration_ms: Math.round(performance.now() - target.bootStartedAt),
      attempts: target.attempts,
      ...provingDevice(),
    })
    clearDownloadReloads()
    return isActiveTab() ? wallet : undefined
  } catch (e) {
    if (!isActiveTab()) return undefined
    const error = isNodeFetchFailure(e) ? new NodeUnreachableError(e) : e
    if (isModuleDownloadFailure(error) && takeDownloadReload()) return void reloadPage()
    throw error
  }
}

const demanded = memoryStore(false)
/** A screen asked for the wallet. */
export const walletDemanded: ReadonlyStore<boolean> = demanded.readonly

/** Stands in on a page whose tab opened no store: demo mode boots no wallet, so it stays pending. */
const NO_WALLET = resource(
  "wallet",
  { from: [], lazy: true, backoff: "manual" },
  () => new Promise<ObsidionWallet>(() => {}),
)
let page: Resource<ObsidionWallet> | undefined

/** Builds the page's wallet over the active tab's store; the first call wins. */
export function startPageWallet(
  node: AztecNode,
  target: PxeTarget,
  create: CreateWallet = createWallet,
): Resource<ObsidionWallet> {
  if (page) return page
  const built = resource("wallet", { from: [], lazy: true, backoff: "manual" }, () =>
    boot(node, target, create),
  )
  page = {
    ...built,
    demand() {
      demanded.set(true)
      built.demand()
    },
  }
  return page
}

export const pageWallet = (): Resource<ObsidionWallet> => page ?? NO_WALLET
