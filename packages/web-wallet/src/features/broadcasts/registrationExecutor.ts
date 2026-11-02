/**
 * Builds a registration's broadcast for the ledger, and for the ticket claim that sends it: the
 * session's own payload while its claim is live, else a rebuild once the wallet is unlocked.
 */
import {
  BroadcastAbandoned,
  BroadcastDeferred,
  isTerminalRegistrationPhase,
  rebuildRegistrationBroadcast,
  recordRegistrationBroadcastSent,
  type BroadcastExecutor,
  type BroadcastJob,
  type PendingRegistrationRecord,
  type RegistrationBroadcastPayload,
} from "@obsidion/front-core"
import { ContractService, type ObsidionAccount, type ObsidionWallet } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import { buildRetrySignDeps } from "../onboarding/oxideOnboarding"
import { registrationBroadcastSeen, unlockedSessionKeys } from "../onboarding/registrationResume"
import { rememberReissuedClaim } from "../onboarding/registrationTerms"
import { buildWebDetectionDeps, getPendingStore } from "../onboarding/webRegistration"
import { createWebRegistrationBroadcaster } from "../onboarding/webRegistrationBroadcast"
import { WAITING_FOR_UNLOCK, WAIT_MS, freshPayloads, payloadDeadlineMs } from "./broadcasts"

/** The broadcast for a record whose session payload is gone: re-derived and re-signed. */
async function rebuild(
  config: WebWalletConfig,
  networkId: string,
  record: PendingRegistrationRecord,
  keys: NonNullable<Awaited<ReturnType<typeof unlockedSessionKeys>>>,
): Promise<RegistrationBroadcastPayload> {
  const signDeps = await buildRetrySignDeps(record.tag, keys, config, networkId)
  const { accountService } = signDeps
  const result = await rebuildRegistrationBroadcast(await buildWebDetectionDeps(config), record, {
    ...signDeps,
    accountService: {
      // A re-issued claim carries a new hold, and the stored terms follow it.
      signDomain: async (...args: Parameters<typeof accountService.signDomain>) => {
        const claim = await accountService.signDomain(...args)
        rememberReissuedClaim(record, claim)
        return claim
      },
    },
  })
  if (result.kind === "payload") return result.payload
  if (result.kind === "wait") throw new BroadcastDeferred(Date.now() + result.ms, result.reason)
  throw new BroadcastAbandoned(
    result.kind === "spent"
      ? "This registration's broadcast was already spent"
      : "The registration ended",
  )
}

/**
 * What publishes a registration's address, and the unlocked account that sends it: the session's
 * own payload while its claim and terms hold, else one rebuilt and re-signed. Throws
 * `BroadcastDeferred` while the wallet is locked or the rebuild must wait, and `BroadcastAbandoned`
 * when nothing is left to publish.
 */
export async function registrationBroadcastPayload(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
  record: PendingRegistrationRecord,
): Promise<{ payload: RegistrationBroadcastPayload; account: ObsidionAccount }> {
  if (isTerminalRegistrationPhase(record.phase))
    throw new BroadcastAbandoned("The registration ended")
  if (record.replaced?.broadcastSpent)
    throw new BroadcastAbandoned("This registration's broadcast was already spent")
  const keys = await unlockedSessionKeys(wallet)
  const owned =
    keys?.account.getAddress().toString().toLowerCase() === record.l2Address.toLowerCase()
  if (!keys || !owned) throw new BroadcastDeferred(Date.now() + WAIT_MS, WAITING_FOR_UNLOCK)
  // A cached payload whose claim or signed terms have lapsed would be refused at the sweep.
  const cached = freshPayloads.get(record.sipaAddress.toLowerCase())
  const fresh = cached && payloadDeadlineMs(cached) > Date.now() + WAIT_MS ? cached : undefined
  return {
    payload: fresh ?? (await rebuild(config, wallet.networkId, record, keys)),
    account: keys.account,
  }
}

export function registrationExecutor(
  wallet: ObsidionWallet,
  config: WebWalletConfig,
): BroadcastExecutor {
  const recordOf = (job: BroadcastJob) =>
    job.source.type === "registration" ? getPendingStore().get(job.source.account) : null

  return {
    landed: async (job) => {
      const record = recordOf(job)
      if (!record) return false
      return registrationBroadcastSeen(
        { ...record, sipaAddress: job.address },
        config,
        wallet,
        job.republishSince,
      )
    },
    send: async (job, attempt) => {
      const record = recordOf(job)
      if (!record) throw new BroadcastAbandoned("The registration ended")
      // An address the registration moved off (a refund at the earned price) is recovered, not
      // swept, and a predecessor that spent the rail left nothing to publish.
      if (record.sipaAddress.toLowerCase() !== job.address)
        throw new BroadcastAbandoned("The registration moved to another address")
      const { payload, account } = await registrationBroadcastPayload(wallet, config, record)
      const broadcast = createWebRegistrationBroadcaster({
        wallet,
        account,
        contractService: ContractService.getInstance(),
        config,
        handle: record.tag,
      })
      const txHash = await broadcast(payload, attempt)
      freshPayloads.delete(job.address)
      await recordRegistrationBroadcastSent(getPendingStore(), record.account, job.address)
      return txHash
    },
    // A broadcast found on chain, e.g. one an earlier page sent before it could stamp the record.
    onLanded: async (job) => {
      freshPayloads.delete(job.address)
      if (job.source.type !== "registration") return
      const record = getPendingStore().get(job.source.account)
      if (record && !record.broadcast)
        await recordRegistrationBroadcastSent(getPendingStore(), record.account, job.address)
    },
  }
}
