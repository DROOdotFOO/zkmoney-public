/**
 * Operating on a retired deployment's l2Token, such as a paylink refund. Its co-signer seals to that token's
 * own portal domain, and its token service is pinned to its address.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { OxideEnvTuple, SourceGenerationSession } from "@obsidion/core/types"
import {
  detectHistoricDeployments,
  TokenService,
  type ObsidionAccount,
  type ObsidionWallet,
  type RegisteredTeeSigner,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { portalContract, teeSignerOfToken } from "../token/oxideToken"
import { openSourceRollupWallet, type SourceRollupWallet } from "../../platform/sourceRollupWallet"
import { isOtherGeneration, openSourceGenerationSession } from "../../platform/sourceGeneration"

/** The retired deployment whose l2Token is `tokenAddress`, or null when none in the manifest has it. */
export async function findHistoricTuple(tokenAddress: string): Promise<OxideEnvTuple | null> {
  const config = getConfig()
  const { historic } = await detectHistoricDeployments({
    ...config.oxideProfile,
    network: config.network,
    publicClient: l1PublicClient(config),
    sourcePortals: new Set(config.sourceRollupNodes?.keys()),
  })
  return historic.find((t) => t.l2Token.toLowerCase() === tokenAddress.toLowerCase()) ?? null
}

/**
 * Where a retired deployment is read: through a PXE of this release, or, on a rollup of another
 * Aztec generation, through that generation's session.
 */
export type SourceChain =
  | ({ kind: "pxe" } & SourceRollupWallet)
  | { kind: "generation"; session: SourceGenerationSession }

/** The account on a retired tuple's rollup; the active wallet when the tuple is on this rollup. */
export async function sourceChain(
  active: SourceRollupWallet,
  current: OxideEnvTuple,
  historic: OxideEnvTuple,
): Promise<SourceChain> {
  if (historic.rollupVersion === current.rollupVersion) return { kind: "pxe", ...active }
  const nodeUrl = getConfig().sourceRollupNodes?.get(historic.portal.toLowerCase())
  if (!nodeUrl)
    throw new Error(`No node is configured for the network of portal ${historic.portal}`)
  if (await isOtherGeneration(nodeUrl))
    return {
      kind: "generation",
      session: await openSourceGenerationSession(nodeUrl, active.account),
    }
  return { kind: "pxe", ...(await openSourceRollupWallet(nodeUrl, active.account)) }
}

/**
 * Whether the probe reads `historic`. Another generation's live portal is left to that generation's
 * app until it freezes: this build reads such a source only to refund it.
 */
export async function isReadableSource(
  current: OxideEnvTuple,
  historic: OxideEnvTuple,
): Promise<boolean> {
  if (historic.rollupVersion === current.rollupVersion) return true
  const nodeUrl = getConfig().sourceRollupNodes?.get(historic.portal.toLowerCase())
  if (!nodeUrl || !(await isOtherGeneration(nodeUrl))) return true
  return portalContract(l1PublicClient(getConfig()), historic.portal as Address).isFrozen()
}

/** Token service + TEE signer for a retired tuple. A dead historic enclave fails loudly here. */
export async function historicTokenContext(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  historic: OxideEnvTuple,
): Promise<{ tokenService: TokenService; teeSigner: RegisteredTeeSigner }> {
  const teeSigner = await historicTeeSigner(historic)
  const tokenService = await TokenService.create(
    wallet,
    account,
    AztecAddress.fromStringUnsafe(historic.l2Token),
    teeSigner,
  )
  return { tokenService, teeSigner }
}

export function historicTeeSigner(historic: OxideEnvTuple): Promise<RegisteredTeeSigner> {
  return teeSignerOfToken(historic.l2Token)
}
