/** Recovers NamePortal attestations for a bootstrap address and its registered name. */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { isL1ToL2MessageReady, waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import { InboxContract } from "@aztec-labs/ethereum/contracts"
import type { ViemClient } from "@aztec-labs/ethereum/types"
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging"
import type { Hex, PublicClient } from "viem"

/**
 * The secret NamePortal sends every message with. PUBLIC BY DESIGN: the gate proves the message
 * exists and never consumes it, so the secret gates nothing.
 */
export const REGISTRATION_MESSAGE_SECRET = Fr.ZERO

/** Content of the message attesting that `bootstrap` holds `nameHash`. Mirrored by `registration.nr`. */
export function nameOwnershipMessageContent(bootstrap: EthAddress, nameHash: Buffer): Fr {
  if (nameHash.length !== 32) throw new Error("a name hash is 32 bytes")
  return sha256ToField([Buffer.concat([bootstrap.toBuffer(), nameHash])])
}

/** The deployment and L1 identity a message has to name to be this account's. */
export interface RegistrationMessageTarget {
  /** The ClaimFPC the message is addressed to — the gate proves it as that contract. */
  fpc: AztecAddress
  /** The L1 NamePortal the gate's config pins as the only accepted sender. */
  namePortal: EthAddress
  /** The bootstrap address the portal reads from the registered OxideAccount. */
  bootstrap: EthAddress
  /** The name that account holds, as the registry stores it. */
  nameHash: Buffer
  /** Rollup version the message is bound to; a migration re-emits against the new one. */
  rollupVersion: number
  /** L1 chain the portal sent from; the caller's pinned identity, never the node's answer. */
  l1ChainId: number
}

/**
 * Where a found message stands: not yet imported into the L1-to-L2 tree (a subscribe cannot prove
 * against it), or imported. A message is never used up.
 */
export type RegistrationMessageStatus = "pending" | "ready"

/** A registration message found in the Inbox. */
export interface RegistrationMessage {
  /** The gate's `message_leaf_index` witness. */
  leafIndex: bigint
  /** The Inbox leaf — what the readiness check keys on. */
  messageHash: Fr
  status: RegistrationMessageStatus
}

export type RegistrationMessageNode = Pick<AztecNode, "getBlockData" | "getL1ToL2MessageIndex">

/** The Inbox slice the scan reads; `InboxContract` satisfies it, tests pass fakes. */
export interface RegistrationInbox {
  address: string
  client: { getBlockNumber(): Promise<bigint | number> }
  getMessageSentEvents(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<{ args: { index: bigint; leaf: Fr } }[]>
}

/** The canonical Inbox reader over an L1 client. */
export function registrationInbox(
  client: PublicClient,
  inbox: EthAddress | Hex,
): RegistrationInbox {
  return new InboxContract(client as unknown as ViemClient, inbox)
}

// Public RPCs cap eth_getLogs ranges (commonly 10k blocks or less). A scan with no floor walks back from the head in
// chunks under that cap, within a budget.
const SCAN_CHUNK_BLOCKS = 9_000n
const SCAN_CHUNK_BUDGET = 30
/** Chunks in flight when a window with a floor is read in chunks. */
const SCAN_CHUNK_CONCURRENCY = 6
/** Blocks a scan re-reads below where the last one stopped, so a reorged log is found again. */
const SCAN_REORG_OVERLAP_BLOCKS = 128n

export interface FindRegistrationMessageOptions {
  /**
   * The first L1 block a message to the target can be in, such as the start of the rollup's first deployment. With it,
   * the scan reads the whole window and later scans read only the blocks past it. Without it, the scan walks back from
   * the head within `chunkBudget`.
   */
  fromBlock?: bigint
  /** How many chunks back from the head a scan with no floor looks before giving up. */
  chunkBudget?: number
}

/** The head each complete scan that found nothing read to, by Inbox, target and floor. */
const scannedThrough = new Map<string, bigint>()

export function resetRegistrationMessageScansForTests(): void {
  scannedThrough.clear()
}

/**
 * The account's newest name-ownership message, or undefined when none is within the scan window.
 *
 * An Inbox leaf is the hash of the whole message, index included, so there is no hash to filter
 * logs by: each candidate leaf is recomputed from the target instead, which binds sender, recipient,
 * rollup version and content at once — a message from another L1 address, to another ClaimFPC, or
 * about another account never produces this leaf. Newest first, so a re-emitted message wins.
 */
export async function findRegistrationMessage(
  inbox: RegistrationInbox,
  node: RegistrationMessageNode,
  target: RegistrationMessageTarget,
  opts: FindRegistrationMessageOptions = {},
): Promise<RegistrationMessage | undefined> {
  const sender = new L1Actor(target.namePortal, target.l1ChainId)
  const recipient = new L2Actor(target.fpc, target.rollupVersion)
  const content = nameOwnershipMessageContent(target.bootstrap, target.nameHash)
  const secretHash = await computeSecretHash(REGISTRATION_MESSAGE_SECRET)
  const leafFor = (index: bigint) =>
    new L1ToL2Message(sender, recipient, content, secretHash, new Fr(index)).hash()
  const newest = (logs: Awaited<ReturnType<RegistrationInbox["getMessageSentEvents"]>>) =>
    logs
      .sort((a, b) => Number(b.args.index - a.args.index))
      .find((log) => log.args.leaf.equals(leafFor(log.args.index)))
  const walk = async (floor: bigint, head: bigint, budget: number) => {
    let to = head
    for (let i = 0; i < budget && to >= floor; i++) {
      const from = to - SCAN_CHUNK_BLOCKS + 1n > floor ? to - SCAN_CHUNK_BLOCKS + 1n : floor
      const log = newest(await inbox.getMessageSentEvents(from, to))
      if (log) return log
      to = from - 1n
    }
    return undefined
  }
  // Every chunk of the window, a few at a time: the window is read whole, so there is no early exit to keep.
  const readChunks = async (floor: bigint, head: bigint) => {
    const ranges: [bigint, bigint][] = []
    for (let to = head; to >= floor; to -= SCAN_CHUNK_BLOCKS) {
      const from = to - SCAN_CHUNK_BLOCKS + 1n > floor ? to - SCAN_CHUNK_BLOCKS + 1n : floor
      ranges.push([from, to])
    }
    const logs: Awaited<ReturnType<RegistrationInbox["getMessageSentEvents"]>> = []
    let next = 0
    const worker = async () => {
      while (next < ranges.length) {
        const [from, to] = ranges[next++]!
        logs.push(...(await inbox.getMessageSentEvents(from, to)))
      }
    }
    await Promise.all(Array.from({ length: Math.min(SCAN_CHUNK_CONCURRENCY, ranges.length) }, worker))
    return newest(logs)
  }

  const head = BigInt(await inbox.client.getBlockNumber())
  let log
  if (opts.fromBlock === undefined) {
    log = await walk(0n, head, opts.chunkBudget ?? SCAN_CHUNK_BUDGET)
  } else {
    const key = [
      inbox.address.toLowerCase(),
      target.l1ChainId,
      target.namePortal.toString(),
      target.rollupVersion,
      target.fpc.toString(),
      content.toString(),
      opts.fromBlock,
    ].join(":")
    const through = scannedThrough.get(key)
    const resume = through === undefined ? opts.fromBlock : through + 1n - SCAN_REORG_OVERLAP_BLOCKS
    const from = resume > opts.fromBlock ? resume : opts.fromBlock
    if (head - from >= SCAN_CHUNK_BLOCKS) {
      try {
        log = newest(await inbox.getMessageSentEvents(from, head))
      } catch {
        // Over the RPC's range or result cap: read it in chunks.
        log = await readChunks(from, head)
      }
    } else {
      log = await readChunks(from, head)
    }
    if (!log) scannedThrough.set(key, head)
  }
  if (!log) return undefined
  const messageHash = leafFor(log.args.index)
  return {
    leafIndex: log.args.index,
    messageHash,
    status: await registrationMessageStatus(node, messageHash),
  }
}

/** Whether the rollup has imported the message, so a subscribe can prove it exists. */
export async function registrationMessageStatus(
  node: RegistrationMessageNode,
  messageHash: Fr,
): Promise<RegistrationMessageStatus> {
  return (await isL1ToL2MessageReady(node as unknown as AztecNode, messageHash)) ? "ready" : "pending"
}

/** Block until the rollup imports the message (a few L1 blocks after the registry sends it). */
export function waitForRegistrationMessage(
  node: RegistrationMessageNode,
  messageHash: Fr,
  opts: { timeoutSeconds: number },
): Promise<boolean> {
  return waitForL1ToL2MessageReady(node, messageHash, opts)
}
