import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type ContractService, DEFAULT_CONTRACTS } from "@obsidion/contracts"

import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import { readPublicImmutable } from "../../utils/publicImmutable.js"

export class ClaimFpcCatalogUnavailableError extends Error {
  constructor(reason: string) {
    super(`the ClaimFPC identity catalog cannot be read: ${reason}`)
    this.name = "ClaimFpcCatalogUnavailableError"
  }
}

export interface ClaimFpcIdentityBinding {
  fpcAddress: string
  accountFactory: string
  implementation: string
  namePortal: string
}

export interface ClaimFpcConfigFields {
  factory_address: bigint
  implementation_address: bigint
  /** Absent on a class deployed before the name portal joined the config. */
  name_portal_address?: bigint
}

/** One FPC's `get_config()` answer, as the chain returned it. */
export interface ClaimFpcReadConfig {
  fpcAddress: string
  config: ClaimFpcConfigFields
}

const L1_ADDRESS_HEX_DIGITS = 40

export function fieldToL1Address(value: bigint): string {
  const hex = value.toString(16)
  if (hex.length > L1_ADDRESS_HEX_DIGITS) {
    throw new Error(`ClaimFPC config holds 0x${hex}, which is wider than an L1 address`)
  }
  return `0x${hex.padStart(L1_ADDRESS_HEX_DIGITS, "0")}`
}

function requiredL1Address(
  fpcAddress: string,
  config: ClaimFpcConfigFields,
  key: "factory_address" | "implementation_address",
): string {
  const value = config[key]
  if (typeof value !== "bigint") {
    throw new ClaimFpcCatalogUnavailableError(`${fpcAddress} config has no ${key}`)
  }
  return fieldToL1Address(value)
}

/**
 * A config without `name_portal_address` predates the field; `fallbackNamePortal` is the current
 * FPC's portal, which stands in for it. With neither, the generation cannot be bound.
 */
export function identityBindingFromConfig(
  fpcAddress: string,
  config: ClaimFpcConfigFields,
  fallbackNamePortal?: string,
): ClaimFpcIdentityBinding {
  const namePortal =
    config.name_portal_address === undefined
      ? fallbackNamePortal
      : fieldToL1Address(config.name_portal_address)
  if (namePortal === undefined) {
    throw new ClaimFpcCatalogUnavailableError(
      `${fpcAddress} config has no name_portal_address and no current ClaimFPC lends one`,
    )
  }
  return {
    fpcAddress,
    accountFactory: requiredL1Address(fpcAddress, config, "factory_address"),
    implementation: requiredL1Address(fpcAddress, config, "implementation_address"),
    namePortal,
  }
}

const L2_ADDRESS = /^0[xX][0-9a-fA-F]{64}$/

export function claimFpcCatalogAddresses(
  currentAddress: AztecAddress | undefined,
  meta: Record<string, unknown> | undefined,
): string[] {
  const published = meta?.retired
  if (published !== undefined && !Array.isArray(published)) {
    throw new ClaimFpcCatalogUnavailableError(
      `the profile's retired ClaimFPC list is ${typeof published}, not a list`,
    )
  }
  const retired = (published ?? []) as unknown[]
  const retiredAddresses = retired.map((entry, index) => {
    const address = (entry as { address?: unknown } | null)?.address
    if (typeof address !== "string" || !L2_ADDRESS.test(address)) {
      throw new ClaimFpcCatalogUnavailableError(
        `retired ClaimFPC entry ${index} names no well-formed address (${JSON.stringify(address)})`,
      )
    }
    return address
  })
  const addresses = [...(currentAddress ? [currentAddress.toString()] : []), ...retiredAddresses]
  const seen = new Set<string>()
  const distinct = addresses.filter((address) => {
    const key = address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (distinct.length === 0) {
    throw new ClaimFpcCatalogUnavailableError(
      "this profile publishes no ClaimFPC, so no generation can say which account this key owns",
    )
  }
  return distinct
}

/** Every failure inside `step` is reported against `fpcAddress`, so no generation fails anonymously. */
async function answering<T>(fpcAddress: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof ClaimFpcCatalogUnavailableError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ClaimFpcCatalogUnavailableError(`${fpcAddress} does not answer: ${reason}`)
  }
}

export async function readClaimFpcIdentityBinding(
  wallet: ObsidionWallet,
  contractService: ContractService,
  fpcAddress: string,
  fallbackNamePortal?: string,
): Promise<ClaimFpcIdentityBinding> {
  return answering(fpcAddress, async () =>
    identityBindingFromConfig(
      fpcAddress,
      await readConfig(wallet, contractService, fpcAddress),
      fallbackNamePortal,
    ),
  )
}

/** Read through the node: a generation the PXE has never registered costs no class hash. */
async function readConfig(
  wallet: ObsidionWallet,
  contractService: ContractService,
  fpcAddress: string,
): Promise<ClaimFpcConfigFields> {
  const address = AztecAddress.fromStringUnsafe(fpcAddress)
  const artifact = await contractService.getArtifactForContract(DEFAULT_CONTRACTS.claimFpc, address)
  return (await readPublicImmutable(
    wallet.node,
    address,
    artifact,
    "config",
    "get_config",
  )) as unknown as ClaimFpcConfigFields
}

/**
 * Bind every read config. The current FPC (`currentAddress`, matched case-insensitively) binds on
 * its own config alone and lends its name portal to any other entry whose config has none.
 */
export async function bindClaimFpcCatalog(
  currentAddress: string | undefined,
  configs: readonly ClaimFpcReadConfig[],
): Promise<ClaimFpcIdentityBinding[]> {
  const isCurrent = (fpcAddress: string) =>
    currentAddress !== undefined && fpcAddress.toLowerCase() === currentAddress.toLowerCase()
  const current = configs.find((entry) => isCurrent(entry.fpcAddress))
  const fallback =
    current === undefined
      ? undefined
      : await answering(current.fpcAddress, async () => {
          const lent = current.config.name_portal_address
          return lent === undefined ? undefined : fieldToL1Address(lent)
        })
  return Promise.all(
    configs.map(({ fpcAddress, config }) =>
      answering(fpcAddress, async () =>
        identityBindingFromConfig(fpcAddress, config, isCurrent(fpcAddress) ? undefined : fallback),
      ),
    ),
  )
}

export async function readClaimFpcIdentityCatalog(
  wallet: ObsidionWallet,
  contractService: ContractService,
): Promise<ClaimFpcIdentityBinding[]> {
  const { address, meta } = await contractService
    .getContractRecord(DEFAULT_CONTRACTS.claimFpc)
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ClaimFpcCatalogUnavailableError(`the profile's ClaimFPC record: ${reason}`)
    })
  const addresses = claimFpcCatalogAddresses(address, meta)
  const configs = await Promise.all(
    addresses.map(async (fpcAddress) => ({
      fpcAddress,
      config: await answering(fpcAddress, () => readConfig(wallet, contractService, fpcAddress)),
    })),
  )
  return bindClaimFpcCatalog(address?.toString(), configs)
}
