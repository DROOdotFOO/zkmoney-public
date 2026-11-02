import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "false"))

vi.mock("@obsidion/web-ds", () => ({
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({
    title,
    onClick,
    testId,
  }: {
    title: string
    onClick?: () => void
    testId?: string
  }) => (
    <button onClick={onClick} data-testid={testId}>
      {title}
    </button>
  ),
  GlassCircleButton: ({ ariaLabel, onClick }: { ariaLabel?: string; onClick?: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick} />
  ),
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
  SettingsRow: ({ label, trailing }: { label: string; trailing?: React.ReactNode }) => (
    <div>
      <span data-label>{label}</span>
      {trailing}
    </div>
  ),
}))

const h = vi.hoisted(() => ({
  readAuthKeysCounted: vi.fn(),
  resolveOxideIdentity: vi.fn(),
  sessionKeys: vi.fn(),
  buildBackupAddDeps: vi.fn(),
  flowDeps: undefined as unknown,
  depsBuilt: 0,
  contractService: {},
  obsidionWallet: {},
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: h.contractService }),
  createOxideL1Reader: () => ({ readAuthKeysCounted: h.readAuthKeysCounted }),
  resolveOxideIdentity: h.resolveOxideIdentity,
  deriveBootstrapKey: () => ({ address: `0x${"b0".repeat(20)}` }),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ address: `0x${"12".repeat(32)}`, handle: "brave-otter-42" }),
}))
vi.mock("../../../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({ kind: "generations" }),
}))
vi.mock("../../../src/features/onboarding/generationAddresses", () => ({
  generationAddresses: () => () => ({}),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ sessionKeys: h.sessionKeys }),
}))
vi.mock("../../../src/features/backupPasskey/backupPasskeyRuntime", () => ({
  buildBackupAddDeps: h.buildBackupAddDeps,
  buildBackupFlowDeps: async () => {
    h.depsBuilt++
    return h.flowDeps
  },
}))

import {
  getBackupRotationStore,
  resetBackupRotationStoreForTests,
} from "../../../src/features/backupPasskey/backupRotationStore"
import { getRotationDriver } from "../../../src/features/backupPasskey/rotationDrive"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { OWNER, makeFlowDeps, receipt, sent, signedRecord, word } from "../../support/backupAdd"
import { openTestSession } from "../../support/session"
const { PasskeysModal } = await import("../../../src/ui/PasskeysModal")

const ROOT_KEY = { qx: `0x${"10".repeat(32)}`, qy: `0x${"11".repeat(32)}` }
const FUNDED = () => signedRecord({ phase: "funded", ...sent(1) })

let root: Root
let container: HTMLDivElement
let flow: ReturnType<typeof makeFlowDeps>

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(node: React.ReactNode) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(node))
  await flush(3)
}

const text = () => container.textContent ?? ""
const byTestId = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
const panel = () => byTestId("backup-panel")
const entry = () => byTestId("backup-add")
const press = (id: string) => act(async () => byTestId(id)!.click())

beforeEach(() => {
  openTestSession({ wallet: h.obsidionWallet })
  localStorage.clear()
  resetBackupRotationStoreForTests()
  h.depsBuilt = 0
  h.resolveOxideIdentity.mockResolvedValue({
    kind: "verified",
    identity: { account: OWNER, nameHash: "0x", generations: [] },
  })
  h.readAuthKeysCounted.mockResolvedValue({
    entries: [{ key: ROOT_KEY, metadata: "0x" }],
    authKeyCount: 1,
  })
  h.sessionKeys.mockResolvedValue({
    secretKey: {},
    authProvider: {
      getPubkeys: async () => [
        Buffer.from(ROOT_KEY.qx.slice(2), "hex"),
        Buffer.from(ROOT_KEY.qy.slice(2), "hex"),
      ],
    },
  })
  flow = makeFlowDeps({ store: getBackupRotationStore() })
  // The funding stays on its way, so the record stays funded while the panel watches it.
  flow.world.receipts.set(word(0x101), receipt(TxStatus.PENDING))
  h.flowDeps = flow.deps
})

afterEach(async () => {
  getRotationDriver().stop()
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("the Passkeys modal with the backup flag off", () => {
  it("offers no add on a one-key account with no saved rotation", async () => {
    await render(<PasskeysModal onClose={() => {}} />)
    expect(text()).toContain("Keys on the account")
    expect(entry()).toBeNull()
    expect(panel()).toBeNull()
    expect(h.buildBackupAddDeps).not.toHaveBeenCalled()
    expect(h.depsBuilt).toBe(0)
  })

  it("shows a funded rotation and keeps driving it, with no new entry", async () => {
    await getBackupRotationStore().put(FUNDED())
    // The wallet's mount starts the session's driver whatever the flag; it does the driving.
    getRotationDriver().start({
      store: getBackupRotationStore(),
      deps: async () => flow.deps,
      owns: () => true,
    })
    await render(<PasskeysModal onClose={() => {}} />)
    expect(panel()).not.toBeNull()
    expect(entry()).toBeNull()
    expect(h.depsBuilt).toBe(1)
    expect(flow.deps.node.getTxReceipt).toHaveBeenCalledWith(word(0x101))
    expect((await getBackupRotationStore().get(OWNER))?.phase).toBe("funded")
  })

  it("shows a finished rotation until Done drops it, and offers no add after", async () => {
    await getBackupRotationStore().put(
      signedRecord({ phase: "done", ...sent(5, { outcome: "swept" }) }),
    )
    await render(<PasskeysModal onClose={() => {}} />)
    expect(text()).toContain("Your backup passkey is ready.")
    await press("backup-done")
    await flush(3)
    expect(await getBackupRotationStore().get(OWNER)).toBeNull()
    expect(panel()).toBeNull()
    expect(entry()).toBeNull()
  })

  it("offers a reread while the saved records cannot be read, then shows the rotation", async () => {
    await getBackupRotationStore().put(FUNDED())
    resetBackupRotationStoreForTests()
    const read = vi.spyOn(webStorage, "getItem").mockRejectedValueOnce(new Error("locked"))
    flow = makeFlowDeps({ store: getBackupRotationStore() })
    flow.world.receipts.set(word(0x101), receipt(TxStatus.PENDING))
    h.flowDeps = flow.deps
    await render(<PasskeysModal onClose={() => {}} />)
    expect(panel()).toBeNull()
    expect(byTestId("backup-store-retry")).not.toBeNull()

    await press("backup-store-retry")
    await flush(3)
    expect(panel()).not.toBeNull()
    expect(entry()).toBeNull()
    read.mockRestore()
  })
})
