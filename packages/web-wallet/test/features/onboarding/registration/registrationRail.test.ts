// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  findRegistrationMessage,
  readPortalChainIdentity,
  registrationInbox,
  loadClaimFpcPolicy,
  registerSponsorFpc,
  hasClaimFpcSubscription,
} = vi.hoisted(() => ({
  findRegistrationMessage: vi.fn(),
  readPortalChainIdentity: vi.fn(),
  registrationInbox: vi.fn(),
  loadClaimFpcPolicy: vi.fn(),
  registerSponsorFpc: vi.fn(),
  hasClaimFpcSubscription: vi.fn(),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  findRegistrationMessage,
  readPortalChainIdentity,
  registrationInbox,
  loadClaimFpcPolicy,
  registerSponsorFpc,
  hasClaimFpcSubscription,
}))
vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  getOxideTuple: async () => CURRENT_TUPLE,
  l1PublicClient: () => L1_CLIENT,
  rollupScanFloor: async () => 7_000n,
}))
const { createOxideL1Reader, predictAccountAddress, readNameOf } = vi.hoisted(() => ({
  createOxideL1Reader: vi.fn(),
  predictAccountAddress: vi.fn(),
  readNameOf: vi.fn(),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideL1Reader,
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox" }),
}))

import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bootstrapKeyProof } from "@obsidion/sdk"
import { deriveBootstrapKey, deriveBootstrapScalar } from "@obsidion/front-core"
import { claimSponsorContext } from "../../../../src/features/onboarding/claimSponsorship"
import { registrationGateWitness } from "../../../../src/features/onboarding/registrationRail"
import { RAIL_REGISTERED } from "../../../../src/features/onboarding/rails"

const REGISTRY = "0x1111111111111111111111111111111111111111"
const INBOX = "0x2222222222222222222222222222222222222222"
const ACCOUNT_FACTORY = "0x3333333333333333333333333333333333333333"
const NAME_PORTAL = "0x4444444444444444444444444444444444444444"
const PORTAL = "0x9999999999999999999999999999999999999999"
const ROLLUP = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const L1_CHAIN_ID = 11155111
const ROLLUP_VERSION = 3
const CURRENT_TUPLE = {
  l2Token: `0x${"07".repeat(32)}`,
  registry: REGISTRY,
  accountFactory: ACCOUNT_FACTORY,
  namePortal: NAME_PORTAL,
}
const HISTORIC_TUPLE = {
  l2Token: `0x${"c0".repeat(32)}`,
  registry: "0x6666666666666666666666666666666666666666",
  accountFactory: "0x7777777777777777777777777777777777777777",
  namePortal: "0x8888888888888888888888888888888888888888",
}
/** What the portal attests about: the wallet's OxideAccount and the name the registry holds for it. */
const OXIDE_ACCOUNT = "0x5555555555555555555555555555555555555555"
const NAME_HASH = `0x${"ab".repeat(32)}`
const FPC = AztecAddress.fromNumberUnsafe(7)
const L1_CLIENT = { getBlockNumber: async () => 4242n }
const INBOX_SOURCE = { kind: "inbox-source" }
const MESSAGE_HASH = new Fr(0x5151n)

/** Answers other values than the pinned identity, so a read off the node would show. */
const node = {
  getNodeInfo: async () => ({
    l1ChainId: 31337,
    rollupVersion: 9,
    l1ContractAddresses: {
      inboxAddress: { toString: () => "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b" },
    },
  }),
}
const wallet = {
  node,
  getNodeIdentity: async () => ({ l1ChainId: L1_CHAIN_ID, rollupVersion: ROLLUP_VERSION }),
}

/** What the caller resolved before it chose a generation: the account and the name it holds. */
const IDENTITY = { account: OXIDE_ACCOUNT, nameHash: NAME_HASH, generations: [] }
const witnessDeps = (identity: unknown, tuple: { namePortal: string } = CURRENT_TUPLE) =>
  ({
    wallet,
    config: { network: "sandbox", l1ChainId: L1_CHAIN_ID, oxideProfile: { portal: PORTAL } },
    identity,
    generation: { fpcAddress: FPC.toString(), namePortal: tuple.namePortal },
  } as never)

/** The unlocked wallet's key material; `buildOxideAccountBinding` runs for real over it. */
const keys = (user: AztecAddress) =>
  ({ account: { getAddress: () => user }, secretKey: new Fr(0xb00751n) } as never)

const witnessFor = (user: AztecAddress) =>
  registrationGateWitness(witnessDeps(IDENTITY), keys(user))

describe("the registration message a sponsored subscribe rides on", () => {
  beforeEach(() => {
    findRegistrationMessage.mockReset()
    readPortalChainIdentity.mockReset()
    readPortalChainIdentity.mockResolvedValue({
      l1ChainId: L1_CHAIN_ID,
      rollupVersion: String(ROLLUP_VERSION),
      rollupAddress: ROLLUP,
      inboxAddress: INBOX,
    })
    registrationInbox.mockReset()
    registrationInbox.mockReturnValue(INBOX_SOURCE)
    predictAccountAddress.mockReset()
    readNameOf.mockReset()
    predictAccountAddress.mockResolvedValue(OXIDE_ACCOUNT)
    readNameOf.mockResolvedValue(NAME_HASH)
    createOxideL1Reader.mockReturnValue({ predictAccountAddress, readNameOf })
  })

  it("waits while no published generation holds a name for this wallet's key", async () => {
    // Nothing to attest yet, so there is no message to look for.
    const found = await registrationGateWitness(
      witnessDeps(undefined),
      keys(AztecAddress.fromNumberUnsafe(10)),
    )

    expect(found).toEqual({ pending: "message" })
    expect(findRegistrationMessage).not.toHaveBeenCalled()
  })

  it("waits for the message while the rollup has not imported it, naming what to wait on", async () => {
    findRegistrationMessage.mockResolvedValue({
      leafIndex: 9n,
      messageHash: MESSAGE_HASH,
      status: "pending",
    })

    expect(await witnessFor(AztecAddress.fromNumberUnsafe(11))).toEqual({
      pending: "import",
      messageHash: MESSAGE_HASH,
    })
  })

  it("waits when the portal has sent no message for this account", async () => {
    findRegistrationMessage.mockResolvedValue(undefined)

    expect(await witnessFor(AztecAddress.fromNumberUnsafe(12))).toEqual({ pending: "message" })
  })

  it("turns a ready message into the gate witness, bound to this FPC and bootstrap key", async () => {
    findRegistrationMessage.mockResolvedValue({
      leafIndex: 9n,
      messageHash: MESSAGE_HASH,
      status: "ready",
    })
    const user = AztecAddress.fromNumberUnsafe(13)

    const found = await witnessFor(user)
    if (!("gate" in found)) throw new Error(`expected a witness, got ${JSON.stringify(found)}`)

    // The key witness re-derives from the master secret; only the key's holder can produce it.
    const proof = bootstrapKeyProof(deriveBootstrapScalar(new Fr(0xb00751n)))
    expect(found.gate).toEqual({
      kind: "registration",
      leafIndex: new Fr(9n),
      nameHash: Uint8Array.from(Buffer.from(NAME_HASH.slice(2), "hex")),
      ...proof,
    })

    const target = findRegistrationMessage.mock.calls[0][2]
    expect(target.fpc.toString()).toBe(FPC.toString())
    expect(target.bootstrap.toString()).toBe(
      deriveBootstrapKey(new Fr(0xb00751n)).address.toLowerCase(),
    )
    expect(target.namePortal.toString()).toBe(NAME_PORTAL)
    expect(target.nameHash.toString("hex")).toBe(NAME_HASH.slice(2))
    // The wallet's pinned identity, not the node's answer.
    expect(target.rollupVersion).toBe(ROLLUP_VERSION)
    expect(target.l1ChainId).toBe(L1_CHAIN_ID)
  })

  it("scans the Inbox the portal names through the sdk's reader, not a hand-rolled ABI", async () => {
    findRegistrationMessage.mockResolvedValue({
      leafIndex: 1n,
      messageHash: MESSAGE_HASH,
      status: "ready",
    })

    await witnessFor(AztecAddress.fromNumberUnsafe(14))

    expect(readPortalChainIdentity).toHaveBeenCalledWith(L1_CLIENT, PORTAL, L1_CHAIN_ID)
    expect(registrationInbox.mock.calls[0][0]).toBe(L1_CLIENT)
    expect(registrationInbox.mock.calls[0][1].toString()).toBe(INBOX)
    expect(findRegistrationMessage.mock.calls[0][0]).toBe(INBOX_SOURCE)
    // From the rollup's first deployment, not a walk back from the head.
    expect(findRegistrationMessage.mock.calls[0][3]).toEqual({ fromBlock: 7_000n })
  })

  it("sponsors on a held subscription note without looking for a message at all", async () => {
    // The note is what keeps sponsoring a subscribed account, so nothing scans L1 for it.
    findRegistrationMessage.mockResolvedValue({
      leafIndex: 9n,
      messageHash: MESSAGE_HASH,
      status: "ready",
    })
    loadClaimFpcPolicy.mockResolvedValue({
      rail: {
        railId: 1,
        name: RAIL_REGISTERED,
        gate: "registration",
        policy: { root: "0xroot", witnesses: [{ entry: { kind: 4 } }] },
      },
      fpcAddress: FPC,
    })
    registerSponsorFpc.mockResolvedValue({ name: "ClaimFPC" })
    hasClaimFpcSubscription.mockResolvedValue(true)

    const sponsor = await claimSponsorContext(
      {
        wallet: { pxe: {}, node },
        account: { getAddress: () => AztecAddress.fromNumberUnsafe(15) },
        contractService: { getArtifactForContract: vi.fn().mockResolvedValue({}) },
      } as never,
      RAIL_REGISTERED,
    )

    expect(sponsor.subscribe).toBeUndefined()
    expect(findRegistrationMessage).not.toHaveBeenCalled()
  })

  it("reads the generation it was given, not the current one", async () => {
    findRegistrationMessage.mockResolvedValue({
      leafIndex: 3n,
      messageHash: MESSAGE_HASH,
      status: "ready",
    })

    const found = await registrationGateWitness(
      witnessDeps(IDENTITY, HISTORIC_TUPLE),
      keys(AztecAddress.fromNumberUnsafe(17)),
    )
    if (!("gate" in found)) throw new Error(`expected a witness, got ${JSON.stringify(found)}`)

    expect(findRegistrationMessage.mock.calls[0][2].namePortal.toString()).toBe(
      HISTORIC_TUPLE.namePortal,
    )
    expect(findRegistrationMessage.mock.calls[0][2].fpc.toString()).toBe(FPC.toString())
    expect(findRegistrationMessage.mock.calls[0][2].bootstrap.toString()).toBe(
      deriveBootstrapKey(new Fr(0xb00751n)).address.toLowerCase(),
    )
  })
})
