import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  GlassCircleButton: ({ ariaLabel, onClick }: { ariaLabel?: string; onClick?: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
  StatusPill: ({ label }: { label: string }) => <span data-pill>{label}</span>,
  SettingsRow: ({
    className,
    label,
    description,
    trailing,
  }: {
    className?: string
    label: string
    description?: React.ReactNode
    trailing?: React.ReactNode
  }) => (
    <div className={className}>
      <span data-label>{label}</span>
      {description && <span data-description>{description}</span>}
      {trailing}
    </div>
  ),
}))

const h = vi.hoisted(() => ({
  readAuthKeysCounted: vi.fn(),
  resolveOxideIdentity: vi.fn(),
  sessionKeys: vi.fn(),
  generationAddresses: vi.fn(),
  addressesFor: vi.fn(),
  identity: null as { address: string } | null,
  config: {},
  contractService: {},
  obsidionWallet: {},
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: h.contractService }),
  createOxideL1Reader: () => ({ readAuthKeysCounted: h.readAuthKeysCounted }),
  resolveOxideIdentity: h.resolveOxideIdentity,
  deriveBootstrapKey: () => ({ address: BOOTSTRAP }),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => h.config }))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => h.identity,
}))
vi.mock("../../../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => GENERATIONS,
}))
vi.mock("../../../src/features/onboarding/generationAddresses", () => ({
  generationAddresses: h.generationAddresses,
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ sessionKeys: h.sessionKeys }),
}))

import { credentialIdHash, credentialIdToMetadata } from "@obsidion/front-core"
const { PasskeysModal } = await import("../../../src/ui/PasskeysModal")
const { openTestSession } = await import("../../support/session")

const BOOTSTRAP = `0x${"b0".repeat(20)}`
const ACCOUNT = `0x${"ac".repeat(20)}`
const L2_ADDRESS = `0x${"12".repeat(32)}`
const GENERATIONS = { kind: "generations" }
const MSK = { kind: "msk" }
const RETIRED_ADDRESSES = { kind: "retired-addresses" }
/** The session's key with the signer of `k`, or a signer whose key is none the account holds. */
const sessionWith = (k?: Key) => ({ secretKey: MSK, authProvider: providerFor(k ?? key(0xee)) })

type Key = { qx: `0x${string}`; qy: `0x${string}` }
const key = (fill: number): Key => ({
  qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
  qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
})
const pubkeyOf = (k: Key) => `${k.qx.slice(2)}${k.qy.slice(2)}`
const providerFor = (k: Key) => ({
  getPubkeys: async () => [Buffer.from(k.qx.slice(2), "hex"), Buffer.from(k.qy.slice(2), "hex")],
})
const ROOT_METADATA = credentialIdToMetadata("root-credential-id-000001")
const envelope = (payloadHex: string) =>
  `0x01${credentialIdHash("backup-credential-id-01").slice(2)}${payloadHex}` as const
const BACKUP_METADATA = envelope(`01${"00".repeat(61)}`)
/** The wallet's layout: the raw credential id behind the envelope. */
const BACKUP_NAMED_METADATA = envelope(
  `01${"00".repeat(61)}${credentialIdToMetadata("backup-credential-id-01").slice(2)}`,
)
const SHORT_ENVELOPE_METADATA = envelope("01".repeat(10))
const UNKNOWN_METADATA = `0x${"ab".repeat(4)}` as const

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<PasskeysModal onClose={onClose} />)
  })
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

const rows = () => [...container.querySelectorAll(".ww-passkeys__row")]
const labels = () => rows().map((el) => el.querySelector("[data-label]")?.textContent)
const signsHere = () =>
  rows().map((el) => el.querySelector("[data-pill]")?.textContent === "Signed in with")

beforeEach(() => {
  openTestSession({ wallet: h.obsidionWallet })
  h.identity = { address: L2_ADDRESS }
  h.sessionKeys.mockResolvedValue(sessionWith())
  h.generationAddresses.mockReturnValue(h.addressesFor)
  h.addressesFor.mockReturnValue(RETIRED_ADDRESSES)
  h.resolveOxideIdentity.mockResolvedValue({
    kind: "verified",
    identity: { account: ACCOUNT, nameHash: "0x", generations: [] },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("PasskeysModal", () => {
  it("labels the sign-up and backup keys and marks the one signing this session", async () => {
    const rootKey = key(0x10)
    const backupKey = key(0x20)
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [
        { key: rootKey, metadata: ROOT_METADATA },
        { key: backupKey, metadata: BACKUP_METADATA },
        { key: key(0x30), metadata: BACKUP_NAMED_METADATA },
      ],
      authKeyCount: 3,
    })
    h.sessionKeys.mockResolvedValue(sessionWith(backupKey))
    await mount()
    expect(labels()).toEqual(["Sign-up", "Backup", "Backup"])
    expect(signsHere()).toEqual([false, true, false])
    expect(container.textContent).not.toContain(pubkeyOf(rootKey).slice(0, 8))
    expect(h.generationAddresses).toHaveBeenCalledWith(h.config, `0x${pubkeyOf(backupKey)}`)
    expect(h.addressesFor).toHaveBeenCalledWith(MSK, L2_ADDRESS)
    expect(h.resolveOxideIdentity).toHaveBeenCalledWith(
      GENERATIONS,
      BOOTSTRAP,
      L2_ADDRESS,
      RETIRED_ADDRESSES,
    )
    expect(h.readAuthKeysCounted).toHaveBeenCalledWith(ACCOUNT, 8)
    expect(container.textContent).not.toContain("this version shows")
  })

  it("calls a key with unreadable metadata or a malformed envelope Unknown key", async () => {
    h.readAuthKeysCounted.mockResolvedValue({
      entries: [
        { key: key(0x10), metadata: UNKNOWN_METADATA },
        { key: key(0x20), metadata: SHORT_ENVELOPE_METADATA },
      ],
      authKeyCount: 2,
    })
    await mount()
    expect(labels()).toEqual(["Unknown key", "Unknown key"])
    expect(signsHere()).toEqual([false, false])
  })

  it("says the keys could not be read when the L1 read fails", async () => {
    h.readAuthKeysCounted.mockRejectedValue(new Error("rpc down"))
    await mount()
    expect(container.textContent).toContain("Couldn't read the account's keys")
    expect(rows()).toHaveLength(0)
  })

  it("says the keys appear once the account is registered when it is not verified", async () => {
    h.resolveOxideIdentity.mockResolvedValue({ kind: "none" })
    await mount()
    expect(container.textContent).toContain("Keys appear once the account is registered")
    expect(container.textContent).not.toContain("Couldn't read the account's keys")
    expect(h.readAuthKeysCounted).not.toHaveBeenCalled()
  })

  it("says the keys could not be read when the wallet is locked", async () => {
    h.sessionKeys.mockResolvedValue(undefined)
    await mount()
    expect(container.textContent).toContain("Couldn't read the account's keys")
    expect(h.resolveOxideIdentity).not.toHaveBeenCalled()
  })

  it("keeps the newer read's rows when an older read lands after it", async () => {
    let landFirst!: (keys: unknown) => void
    let landSecond!: (keys: unknown) => void
    h.readAuthKeysCounted
      .mockReturnValueOnce(new Promise((resolve) => (landFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (landSecond = resolve)))
    const wallet = h.obsidionWallet
    h.sessionKeys.mockResolvedValue(sessionWith(key(0x20)))
    await mount()
    // The wallet changes under the open modal: a second read starts and the first is stale.
    h.obsidionWallet = {}
    openTestSession({ wallet: h.obsidionWallet })
    await act(async () => {
      root.render(<PasskeysModal onClose={onClose} />)
    })
    landSecond({ entries: [{ key: key(0x20), metadata: ROOT_METADATA }], authKeyCount: 1 })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    landFirst({ entries: [{ key: key(0x10), metadata: ROOT_METADATA }], authKeyCount: 1 })
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(signsHere()).toEqual([true])
    h.obsidionWallet = wallet
  })

  it("shows the eight keys it read and says the account holds nine", async () => {
    h.readAuthKeysCounted.mockResolvedValue({
      entries: Array.from({ length: 8 }, (_, i) => ({
        key: key(0x10 + i * 2),
        metadata: ROOT_METADATA,
      })),
      authKeyCount: 9,
    })
    await mount()
    expect(rows()).toHaveLength(8)
    expect(container.textContent).toContain("The account has 9 keys; this version shows 8.")
  })
})
