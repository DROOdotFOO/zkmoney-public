import {
  ObsidionWallet,
  readNetworkId,
  type CreateWalletOptions,
  type ObsidionWalletOptions,
} from "./ObsidionWallet.js"
import { DEFAULT_CONTRACTS, type ContractName } from "@obsidion/contracts"
import { getPXEConfig, type PXEConfig } from "@aztec-labs/pxe/config"
import {
  createPXE as createPXELazy,
  type PXE,
  type PXECreationOptions,
} from "@aztec-labs/pxe/client/lazy"
import type { AztecNode } from "@aztec-labs/aztec.js/node"

/**
 * Test wallet variant that uses the obsidionAccountAlphaTest contract
 * (ECDSA K256 signing instead of WebAuthn/passkeys).
 *
 * Use this for E2E testing where biometric prompts can't be automated.
 */
export class ObsidionAlphaTestWallet extends ObsidionWallet {
  protected getAccountContractName(): ContractName {
    return DEFAULT_CONTRACTS.obsidionAccountAlphaTest
  }

  static override async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
    walletOpts?: CreateWalletOptions,
  ): Promise<ObsidionAlphaTestWallet> {
    const networkId = await readNetworkId(node, walletOpts)
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      autoSync: overridePXEConfig?.autoSync ?? false,
      ...overridePXEConfig,
    })
    pxeConfig.dataDirectory = `pxe-${networkId}`

    const pxe = await createPXELazy(node, pxeConfig, options)
    return new ObsidionAlphaTestWallet(pxe, node, networkId, walletOpts)
  }

  static override async createWithPXE(
    pxe: PXE,
    node: AztecNode,
    networkId: string,
    walletOpts?: ObsidionWalletOptions,
  ): Promise<ObsidionAlphaTestWallet> {
    return new ObsidionAlphaTestWallet(pxe, node, networkId, walletOpts)
  }
}
