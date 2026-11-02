/**
 * The wallet-bound half of a detection tick, and what tells whether a registration's broadcast
 * mined. Detection itself stays credential-free; these arm only once the wallet is unlocked.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import type { Address } from "viem"
import { fetchSipaEvents, type ObsidionWallet } from "@obsidion/sdk"
import {
  SIPADepositStore,
  type OxideResumeDeps,
  type PendingRegistrationRecord,
} from "@obsidion/front-core"

import type { WebWalletConfig } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { buildRetrySignDeps, type OnboardingKeys } from "./oxideOnboarding"

/** The unlocked session's keys without a ceremony; undefined while locked. */
export async function unlockedSessionKeys(
  wallet: ObsidionWallet,
): Promise<OnboardingKeys | undefined> {
  const keys = await getAuthService().sessionKeys()
  if (!keys) return undefined
  const { secretKey, authProvider } = keys
  const [x, y] = await authProvider.getPubkeys()
  return {
    account: await wallet.createObsidionAccount(secretKey, authProvider),
    secretKey,
    authProvider,
    pubkeyHex: `0x${Buffer.concat([x, y]).toString("hex")}`,
  }
}

/**
 * Whether the record's broadcast mined, from `sinceBlock` on when given (a republish): the `SIPA`
 * event it sends this wallet is in the PXE, matched by the salt the deposit rail seeded. Throws when
 * it cannot tell (an unseeded record, a failed event read) so the tick spends nothing.
 */
export async function registrationBroadcastSeen(
  record: PendingRegistrationRecord,
  config: WebWalletConfig,
  wallet: ObsidionWallet,
  sinceBlock?: number,
): Promise<boolean> {
  const salt = SIPADepositStore.get(webStorage).get(record.sipaAddress as Address)?.messageSecret
  if (!salt) throw new Error(`registration deposit ${record.sipaAddress} is not seeded`)
  const tuple = await getOxideTuple(config)
  const events = await fetchSipaEvents(
    wallet,
    AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token")),
    AztecAddress.fromStringUnsafe(record.l2Address),
    sinceBlock === undefined ? undefined : { fromBlock: BlockNumber(sinceBlock) },
  )
  const wanted = salt.toLowerCase()
  return events.some((event) => event.sharedSecretSalt.toString().toLowerCase() === wanted)
}

/** Resume deps that renew a spent-rail record's claim, for a record this session's wallet owns. */
export function walletResumeExtras(
  config: WebWalletConfig,
  wallet: ObsidionWallet,
): Pick<OxideResumeDeps, "getSignDeps"> {
  return {
    getSignDeps: async (record) => {
      const keys = await unlockedSessionKeys(wallet)
      if (!keys) return null
      const owned =
        keys.account.getAddress().toString().toLowerCase() === record.l2Address.toLowerCase()
      return owned ? buildRetrySignDeps(record.tag, keys, config, wallet.networkId) : null
    },
  }
}
