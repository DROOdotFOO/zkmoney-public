import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PendingRegistrationStore } from "@obsidion/front-core"
import type { Hex } from "viem"
import { seedBootConfig } from "../../../support/seedBootConfig"

const h = vi.hoisted(() => ({
  claimTag: vi.fn(async () => ({ kind: "pending" })),
  keys: { secretKey: "sk" },
}))
vi.mock("../../../../src/features/onboarding/oxideOnboarding", () => ({
  claimTag: h.claimTag,
  collectOnboardingKeys: async () => h.keys,
}))

const { chooseOwnName } = await import("../../../../src/features/onboarding/chooseOwnName")
const { loadWalletIdentity, saveWalletIdentity } = await import(
  "../../../../src/features/identity/walletIdentity"
)
const { getPendingStore } = await import("../../../../src/features/onboarding/webRegistration")
const { getConfig } = await import("../../../../src/config/env")
const { setActiveCredentialId } = await import("../../../../src/platform/storage/activeStorage")
const { walletStorage } = await import("../../../../src/platform/storage/walletStorage")
const { usertagFor } = await import("../../../../src/platform/auth/WebPasskeyIdentityMap")

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex
const account = {} as never
const wallet = {} as never

async function seed(over: { fundedAt?: number; broadcast?: boolean } = {}) {
  ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
  localStorage.clear()
  await getPendingStore().upsert(
    ACCOUNT,
    {},
    {
      tag: "brave-otter-42",
      nameHash: `0x${"77".repeat(32)}` as Hex,
      l2Address: L2_ADDRESS,
      l1ChainId: 11155111,
      sipaAddress: `0x${"5a".repeat(20)}`,
      depositToken: `0x${"bb".repeat(20)}` as Hex,
      broadcast: false,
      phase: "awaiting_deposit",
      retries: 0,
      startTime: Date.now(),
      ...over,
    },
  )
  await saveWalletIdentity({
    handle: "brave-otter-42",
    address: L2_ADDRESS,
    claimedAt: 1,
    pending: true,
  })
}

const { activeNamespace, closeSession, switchSession, session } = await import(
  "../../../../src/platform/session"
)
beforeEach(() => void switchSession(activeNamespace()))
afterEach(closeSession)

describe("chooseOwnName", () => {
  beforeAll(seedBootConfig)
  beforeEach(() => h.claimTag.mockClear())

  it("claims the new name over the unfunded registration at the paid price, and presents it", async () => {
    await seed()
    const replaced = getPendingStore().current()
    await chooseOwnName("river", account, wallet)
    expect(h.claimTag).toHaveBeenCalledWith(
      "river",
      h.keys,
      getConfig(),
      wallet,
      undefined,
      false,
      undefined,
      replaced,
    )
    expect(loadWalletIdentity()).toMatchObject({ handle: "river", pending: true })
  })

  it("renames the passkey under the handle it was created with and remembers the new name", async () => {
    await seed()
    const { rpId } = getConfig()
    setActiveCredentialId("cred-1")
    walletStorage.setItem(
      "obsidion.obsidion_web_passkey_identity_map",
      JSON.stringify({
        version: 1,
        entries: { "cred-1": { credentialId: "cred-1", rpId, userHandle: "YQAB" } },
      }),
    )
    const signalCurrentUserDetails = vi.fn(async () => {})
    vi.stubGlobal("PublicKeyCredential", { signalCurrentUserDetails })
    await chooseOwnName("river", account, wallet)
    vi.unstubAllGlobals()
    expect(signalCurrentUserDetails).toHaveBeenCalledWith({
      rpId,
      userId: "YQAB",
      name: "river",
      displayName: "river",
    })
    expect(usertagFor(rpId, "cred-1")).toBe("river")
  })

  it("asks for the earned schedule when the name is free", async () => {
    await seed()
    const replaced = getPendingStore().current()
    await chooseOwnName("river", account, wallet, true)
    expect(h.claimTag).toHaveBeenCalledWith(
      "river",
      h.keys,
      getConfig(),
      wallet,
      undefined,
      true,
      undefined,
      replaced,
    )
  })

  it("refuses once the tag is confirmed and its address broadcast", async () => {
    await seed({ broadcast: true })
    await expect(chooseOwnName("river", account, wallet)).rejects.toThrow("cannot change")
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it("reads the burns before it decides: a ticket's burn to the address keeps the name", async () => {
    await seed()
    await session().withdrawals.create({
      networkId: "0xnet",
      localId: "w1",
      recipient: `0x${"5a".repeat(20)}`,
      recipientProvenance: "saved-recipient",
      amount: "5",
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      phase: "submitting",
      startTime: 1,
    })
    // A reload: the page's withdrawals have yet to load when the tap lands.
    closeSession()
    switchSession(activeNamespace())
    expect(session().withdrawals.list.get().hydrated).toBe(false)
    await expect(chooseOwnName("river", account, wallet)).rejects.toThrow("cannot change")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(loadWalletIdentity()?.handle).toBe("brave-otter-42")
  })

  it("refuses once the first deposit has reached the address", async () => {
    await seed({ fundedAt: Date.now() })
    await expect(chooseOwnName("river", account, wallet)).rejects.toThrow("cannot change")
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(loadWalletIdentity()?.handle).toBe("brave-otter-42")
  })
})
