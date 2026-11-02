/**
 * Recover a device's ClaimFPC eligibility witness from L1.
 *
 * `NameRegistry._consumeDomainAuth` emits `NameClaimed(owner, nameHash, nonce, deadline,
 * signature)` on every name-hash claim, which is the whole durable half of the
 * NameClaim gate witness — the other half (bootstrap pubkey + L2 binding signature) is
 * derived from the device's master key on every call. So any client holding the MSK can rebuild the
 * witness from the chain, and the artifacts never need to survive in local storage: a browser wipe
 * or a ClaimFPC redeploy costs one log query, not the account's sponsored fees.
 *
 * Reading the chain rather than account-service's claim ledger is deliberate. The ledger holds the
 * same values and replays them idempotently, but that path is credential-gated and would make fee
 * eligibility a trusted-server property.
 */

import { getAbiItem, type Address, type Hex, type PublicClient } from "viem"
import { NameRegistryAbi, readNameOf } from "@oxide/l1-contracts"

const NAME_CLAIMED_EVENT = getAbiItem({ abi: NameRegistryAbi, name: "NameClaimed" })

/** The L1-sourced half of the eligibility witness. */
export interface NameClaimLogRecord {
  /** The NameRegistry node the domain owner authorized — feeds the witness directly, no tag needed. */
  nameHash: Hex
  nonce: string
  deadline: string
  /** Domain-owner secp256k1 signature over the EIP-712 NameClaim. */
  signature: Hex
}

// Public RPCs cap eth_getLogs ranges (commonly 10k blocks or less), so an unbounded scan of a
// long-lived chain fails outright. The backward scan sizes chunks under that cap and bounds the
// total to CHUNK_BUDGET chunks — a recent claim (the overwhelmingly common case) is found in the
// first chunk.
const SCAN_CHUNK_BLOCKS = 9_000n
const SCAN_CHUNK_BUDGET = 200

/** A claim exists on-chain but the scan budget ran out before its log was located. */
export class NameClaimScanExhaustedError extends Error {
  constructor(oxideAccount: Address, scannedFrom: bigint) {
    super(
      `NameClaimed log for ${oxideAccount} not located within the scan budget ` +
        `(scanned back to block ${scannedFrom}); the live NameRegistry binding proves it exists — ` +
        `pass fromBlock (the NameRegistry deployment block) or raise the budget`,
    )
    this.name = "NameClaimScanExhaustedError"
  }
}

/**
 * The live `NameClaimed` record for `oxideAccount`, or `null` when the account never claimed a name
 * on this NameRegistry.
 *
 * `_consumeDomainAuth` also fires on name CHANGES, so an account can have several logs and only the
 * newest is the live binding. The result is cross-checked against the account's current `nameHash`
 * so a superseded claim can never be handed to the NameClaim gate — its signature covers a
 * name the account no longer owns.
 *
 * `null` means exactly one thing: the live NameRegistry binding is zero, i.e. the account never
 * claimed.
 * Once the live binding is non-zero a matching log MUST exist, so every other shortfall THROWS —
 * a scan-budget or RPC failure must never masquerade as "never claimed", because callers treat null
 * as "no subscription possible, pay your own fees".
 *
 * `fromBlock` bounds the scan: pass the NameRegistry's deployment block where it is known. Without it,
 * the scan walks backward from the head in capped chunks and throws `NameClaimScanExhaustedError`
 * if the budget runs out first.
 */
export async function readNameClaimLog(
  publicClient: PublicClient,
  nameRegistry: Address,
  oxideAccount: Address,
  fromBlock?: bigint,
): Promise<NameClaimLogRecord | null> {
  const nameHash = await readNameOf(publicClient, nameRegistry, oxideAccount)
  if (!nameHash || /^0x0*$/.test(nameHash)) return null

  const args = { owner: oxideAccount, nameHash }

  if (fromBlock !== undefined) {
    const logs = await publicClient.getLogs({
      address: nameRegistry,
      event: NAME_CLAIMED_EVENT,
      args,
      fromBlock,
      toBlock: "latest",
    })
    return toRecord(logs.at(-1), oxideAccount, fromBlock)
  }

  // Backward chunk scan. The newest matching log is the live one, and we scan newest-first, so the
  // first non-empty chunk's last entry is the answer.
  const head = await publicClient.getBlockNumber()
  let to = head
  let reachedGenesis = false
  for (let i = 0; i < SCAN_CHUNK_BUDGET; i++) {
    const from = to >= SCAN_CHUNK_BLOCKS ? to - SCAN_CHUNK_BLOCKS + 1n : 0n
    const logs = await publicClient.getLogs({
      address: nameRegistry,
      event: NAME_CLAIMED_EVENT,
      args,
      fromBlock: from,
      toBlock: to,
    })
    const latest = logs.at(-1)
    if (latest) return toRecord(latest, oxideAccount, from)
    if (from === 0n) {
      reachedGenesis = true
      break
    }
    to = from - 1n
  }
  if (!reachedGenesis) throw new NameClaimScanExhaustedError(oxideAccount, to)
  // Scanned to genesis with a non-zero live binding and no log: the RPC's history is incomplete
  // or the NameRegistry invariant broke. Either way, not "never claimed".
  throw new Error(
    `NameRegistry ${nameRegistry} maps ${oxideAccount} to a name but no NameClaimed log exists in ` +
      `the scanned history — incomplete RPC log history?`,
  )
}

function toRecord(
  log: { args?: unknown } | undefined,
  oxideAccount: Address,
  scannedFrom: bigint,
): NameClaimLogRecord {
  const { nameHash, nonce, deadline, signature } = (log?.args ?? {}) as {
    nameHash?: Hex
    nonce?: bigint
    deadline?: bigint
    signature?: Hex
  }
  // A bounded fromBlock that misses the claim is indistinguishable from a budget shortfall — and
  // with a non-zero live binding the log provably exists, so absence always throws.
  if (!nameHash || nonce === undefined || deadline === undefined || !signature) {
    throw new NameClaimScanExhaustedError(oxideAccount, scannedFrom)
  }
  return {
    nameHash,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature,
  }
}
