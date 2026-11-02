import {
  ContractService,
  DEFAULT_CONTRACTS,
  type ContractServiceOptions,
  type IContractServiceStorage,
  type Network,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"
import { WalletError } from "./errors"
import { resource, type Backoff, type Resource } from "./resource"

const RETRY: Backoff = { baseMs: 4_000, maxMs: 60_000 }

export interface ContractServiceDeps {
  wallet: Resource<ObsidionWallet>
  network: Network
  storage: IContractServiceStorage
  options: ContractServiceOptions
  /** Registers the sponsor FPC with the PXE. A host that pays no fee through it skips the work, which
   *  otherwise queues on the PXE ahead of the host's first reads. */
  registerSponsorFpc?: boolean
}

export type ContractServiceSingleton = Pick<typeof ContractService, "getInstance">

/**
 * The page's contract service over `wallet`: the instance `ContractService.getInstance()` returns.
 * An instance already installed is adopted as is.
 */
export function contractServiceResource(
  deps: ContractServiceDeps,
  singleton: ContractServiceSingleton = ContractService,
): Resource<ContractService> {
  return resource("contractService", { from: [deps.wallet], backoff: RETRY }, async ([wallet]) => {
    const installed = installedService(singleton)
    if (installed) {
      if (deps.registerSponsorFpc ?? true) void initFPC(installed)
      return installed
    }
    const { network, options } = deps
    logger.log("initializing contract service: ", network)
    if (options.source === "profile") {
      if (!options.config)
        throw new WalletError("invariant", 'contract service: source "profile" without a snapshot')
      if (options.config.network !== network)
        throw new WalletError(
          "invariant",
          `Config snapshot is for network "${options.config.network}" but the wallet is on ` +
            `"${network}"`,
        )
    }
    const service = singleton.getInstance(deps.storage, wallet.node, wallet.pxe, network, options)
    logger.log("contract service created: ", service.getNetwork())
    void prepare(service, deps)
    return service
  })
}

function installedService(singleton: ContractServiceSingleton): ContractService | null {
  try {
    return singleton.getInstance()
  } catch {
    return null
  }
}

async function prepare(service: ContractService, deps: ContractServiceDeps) {
  if (deps.registerSponsorFpc ?? true) await initFPC(service)
  try {
    const l1Addresses = await service.getL1Addresses()
    deps.options.onL1AddressesLoaded?.(l1Addresses)
  } catch (err) {
    logger.warn("Failed to load L1 addresses:", err)
  }
}

/** The sponsor FPC is optional fee infra: a missing or failed registration never fails the service. */
async function initFPC(service: ContractService) {
  try {
    const sponsoredFPCAddress = await service.getContractAddress(DEFAULT_CONTRACTS.sponsorFPC)
    if (!sponsoredFPCAddress) {
      logger.warn("Sponsored FPC address not found in registry — skipping sponsor FPC")
    } else {
      // Guarded: no-op when the PXE already has the instance + artifact.
      await service.registerContractWithName(DEFAULT_CONTRACTS.sponsorFPC)
      logger.log("Sponsor FPC registered at:", sponsoredFPCAddress.toString())
    }
  } catch (e) {
    console.warn("Failed to register sponsor FPC:", e)
  }
}
