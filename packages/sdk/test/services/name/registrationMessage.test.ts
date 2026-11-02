/**
 * The name-ownership message the ClaimFPC's registration gate consumes, from the client side: the
 * content hash both languages have to agree on, and the Inbox scan that recovers the leaf index a
 * `subscribe` needs and reports where the message stands.
 *
 * The recovery is what makes the rail survive a lost device: the witness is public L1 log data plus
 * a public secret, so a fresh PXE can rebuild it with nothing kept locally. The negative cases pin
 * that the match binds the whole message — an Inbox leaf commits sender, recipient, version and
 * content, so a message from another sender, to another FPC, or about another L1 account is simply
 * not this one.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import {
  REGISTRATION_MESSAGE_SECRET,
  findRegistrationMessage,
  nameOwnershipMessageContent,
  resetRegistrationMessageScansForTests,
  type RegistrationInbox,
  type RegistrationMessageNode,
} from "../../../src/services/name/registrationMessage.js"

type InboxMessageSentLog = Awaited<ReturnType<RegistrationInbox["getMessageSentEvents"]>>[number]

const CHAIN_ID = 31337
const OTHER_CHAIN_ID = 11155111
const ROLLUP_VERSION = 4138062237

const FPC = AztecAddress.fromFieldUnsafe(new Fr(0xfbc0n))
const NAME_PORTAL = EthAddress.fromString("0x00000000000000000000000000000000000eeee1")
/** The registrant the portal attests about, and the name it holds. */
const OWNER = EthAddress.fromString("0x0ead00000000000000000000000000000000bee0")
const NAME_HASH = Buffer.from(
  "0da1000000000000000000000000000000000000000000000000000000001e55",
  "hex",
)
const OTHER_OWNER = EthAddress.fromString("0x1111111111111111111111111111111111111111")

/** Pinned in `claim_fpc/src/registration.nr::content_hash_matches_the_typescript_mirror`. */
const PINNED_CONTENT_HASH = "0x00430fd1ec5d12a2bc57833acc01e9d48e7127e07fc06e6eaebfd92b5885eb4b"

async function inboxLeaf(over: {
  sender?: EthAddress
  recipient?: AztecAddress
  content?: Fr
  version?: number
  chainId?: number
  index: bigint
}): Promise<InboxMessageSentLog & { l1BlockNumber: bigint }> {
  const message = new L1ToL2Message(
    new L1Actor(over.sender ?? NAME_PORTAL, over.chainId ?? CHAIN_ID),
    new L2Actor(over.recipient ?? FPC, over.version ?? ROLLUP_VERSION),
    over.content ?? nameOwnershipMessageContent(OWNER, NAME_HASH),
    await computeSecretHash(REGISTRATION_MESSAGE_SECRET),
    new Fr(over.index),
  )
  // One leaf per L1 block, at block 1000 + index, so chunk bounds are easy to reason about.
  return {
    l1BlockNumber: 1000n + over.index,
    args: { index: over.index, leaf: message.hash() },
  }
}

/**
 * An Inbox at `head` whose logs answer range queries by block, recording the ranges asked. With `maxRange`, it refuses
 * a wider query, as a capped RPC does.
 */
function fakeInbox(
  logs: (InboxMessageSentLog & { l1BlockNumber: bigint })[],
  head = 100_000n,
  maxRange?: bigint,
): RegistrationInbox & { ranges: [bigint, bigint][]; head: bigint } {
  const ranges: [bigint, bigint][] = []
  const inbox = {
    address: "0x00000000000000000000000000000000000001b0",
    ranges,
    head,
    client: { getBlockNumber: async () => inbox.head },
    getMessageSentEvents: async (from: bigint, to: bigint) => {
      ranges.push([from, to])
      if (maxRange !== undefined && to - from >= maxRange) throw new Error("range too wide")
      return logs.filter((l) => l.l1BlockNumber >= from && l.l1BlockNumber <= to)
    },
  }
  return inbox
}

/**
 * A node that has synced the message at leaf 42, whose latest block has inserted it when `imported`.
 * It answers no chain id: the target carries it.
 */
function fakeNode(imported: boolean): RegistrationMessageNode {
  return {
    getChainId: async () => {
      throw new Error("the node was asked for the chain id")
    },
    getL1ToL2MessageIndex: async () => 42n,
    getBlockData: async () => ({
      header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: imported ? 43 : 42 } } },
    }),
  } as never
}

const target = {
  fpc: FPC,
  namePortal: NAME_PORTAL,
  bootstrap: OWNER,
  nameHash: NAME_HASH,
  rollupVersion: ROLLUP_VERSION,
  l1ChainId: CHAIN_ID,
}

describe("name ownership message content", () => {
  it("hashes a fixed owner and name to the vector the circuit pins", () => {
    expect(nameOwnershipMessageContent(OWNER, NAME_HASH).toString()).toBe(PINNED_CONTENT_HASH)
  })

  it("refuses a name hash that is not 32 bytes", () => {
    expect(() => nameOwnershipMessageContent(OWNER, Buffer.alloc(31))).toThrow("32 bytes")
  })
})

describe("finding the registration message in the inbox", () => {
  beforeEach(() => resetRegistrationMessageScansForTests())

  it.each([
    [
      "sent by another L1 address",
      { sender: EthAddress.fromString("0x00000000000000000000000000000000000eeee2") },
    ],
    [
      "addressed to another recipient",
      { recipient: AztecAddress.fromFieldUnsafe(new Fr(0x0f9cn)) },
    ],
    ["about another L1 account", { content: nameOwnershipMessageContent(OTHER_OWNER, NAME_HASH) }],
    [
      "about another name of the same account",
      { content: nameOwnershipMessageContent(OWNER, Buffer.alloc(32, 0x22)) },
    ],
    ["bound to another rollup version", { version: ROLLUP_VERSION + 1 }],
  ])("ignores a message %s", async (_, over) => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n, ...over })])
    expect(await findRegistrationMessage(inbox, fakeNode(true), target)).toBeUndefined()
  })

  it("binds the L1 sender to the target's chain id, never the node's", async () => {
    const leaf = await inboxLeaf({ index: 42n, chainId: OTHER_CHAIN_ID })
    const inbox = fakeInbox([leaf])
    expect(await findRegistrationMessage(inbox, fakeNode(true), target)).toBeUndefined()
    const found = await findRegistrationMessage(inbox, fakeNode(true), {
      ...target,
      l1ChainId: OTHER_CHAIN_ID,
    })
    expect(found?.messageHash.toString()).toBe((leaf.args.leaf as Fr).toString())
  })

  it("finds this account's message among unrelated inbox traffic", async () => {
    const inbox = fakeInbox([
      await inboxLeaf({ index: 42n }),
      await inboxLeaf({ index: 43n, content: Fr.fromHexString("0x1234") }),
      await inboxLeaf({ index: 44n, sender: EthAddress.ZERO }),
    ])
    expect((await findRegistrationMessage(inbox, fakeNode(true), target))?.leafIndex).toBe(42n)
  })

  it("prefers the newest of several messages for the same account", async () => {
    // `notify` is repeatable, and a migration re-emits; the spent original must not shadow it.
    const inbox = fakeInbox([await inboxLeaf({ index: 42n }), await inboxLeaf({ index: 900n })])
    expect((await findRegistrationMessage(inbox, fakeNode(true), target))?.leafIndex).toBe(900n)
  })

  it("reads the window from the floor in one request", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })], 20_000n)
    expect(
      await findRegistrationMessage(inbox, fakeNode(true), target, { fromBlock: 5_000n }),
    ).toBeUndefined()
    expect(inbox.ranges).toEqual([[5_000n, 20_000n]])
  })

  it("reads a refused window in chunks covering it down to the floor", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })], 30_000n, 10_000n)
    const found = await findRegistrationMessage(inbox, fakeNode(true), target, { fromBlock: 0n })
    expect(found?.leafIndex).toBe(42n)
    expect(inbox.ranges[0]).toEqual([0n, 30_000n])
    expect(inbox.ranges.slice(1).sort((a, b) => Number(a[0] - b[0]))).toEqual([
      [0n, 3_000n],
      [3_001n, 12_000n],
      [12_001n, 21_000n],
      [21_001n, 30_000n],
    ])
  })

  it("reads only the blocks past an empty scan, and finds a message sent after it", async () => {
    const leaf = await inboxLeaf({ index: 42n })
    const logs: (typeof leaf)[] = []
    const inbox = fakeInbox(logs, 20_000n)
    const scan = () => findRegistrationMessage(inbox, fakeNode(true), target, { fromBlock: 0n })
    expect(await scan()).toBeUndefined()
    inbox.head = 20_500n
    logs.push({ ...leaf, l1BlockNumber: 20_400n })
    expect((await scan())?.leafIndex).toBe(42n)
    expect(inbox.ranges).toEqual([
      [0n, 20_000n],
      [20_001n - 128n, 20_500n],
    ])
  })

  it("gives up after the chunk budget", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })], 100_000n)
    expect(
      await findRegistrationMessage(inbox, fakeNode(true), target, { chunkBudget: 2 }),
    ).toBeUndefined()
    expect(inbox.ranges).toHaveLength(2)
  })
})

describe("where a found message stands", () => {
  it("is pending while the rollup has not imported it", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })])
    expect((await findRegistrationMessage(inbox, fakeNode(false), target))?.status).toBe("pending")
  })

  it("is ready once imported, and stays ready: the gate never consumes it", async () => {
    const inbox = fakeInbox([await inboxLeaf({ index: 42n })])
    expect((await findRegistrationMessage(inbox, fakeNode(true), target))?.status).toBe("ready")
  })
})
