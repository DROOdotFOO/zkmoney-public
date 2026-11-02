/**
 * The line that tells a laptop user this computer's copy of the passkey may answer: who sees it,
 * how its three showings are counted, and where the working beat puts it.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APPLE_ICLOUD_AAGUID, GPM_AAGUID } from "@obsidion/core/constants"
import { provingProgress } from "@obsidion/proving-progress"
import { WebAuthnAlphaAuthProvider } from "@obsidion/sdk"
import { PayWorking } from "../../src/features/contacts/PayWorking"
import { OperationHandOff } from "../../src/features/operations/OperationHandOff"
import { getOperationStore } from "../../src/features/operations/operations"
import { WebAlphaAuthService } from "../../src/platform/auth/WebAlphaAuthService"
import { WebPasskeyIdentityMap } from "../../src/platform/auth/WebPasskeyIdentityMap"
import { setActiveCredentialId } from "../../src/platform/storage/activeStorage"
import { deviceStorage } from "../../src/platform/storage/rollupStorage"
import { WebStorageAdapter } from "../../src/platform/storage/WebStorageAdapter"
import { walletStorage } from "../../src/platform/storage/walletStorage"
import {
  LocalPasskeyHint,
  localPasskeyHintApplies,
  localPasskeyHintCopy,
} from "../../src/ui/LocalPasskeyHint"

const RP = "localhost"
const SHOWN_KEY = "webwallet.local-passkey-hint-shown"
const LINE = "If your passkey has synced to this computer"
const hash = `0x${"ab".repeat(32)}`

/** A session whose passkey this browser saw answer from `answered`; `null` for no answer yet. */
async function session(answered: "remote" | "local" | null = "remote") {
  const map = new WebPasskeyIdentityMap(new WebStorageAdapter(), RP)
  await map.upsert({ credentialId: "cred", l2Address: "0xacct", pubkey: "ab", isMskRoot: true })
  if (answered) await map.setAnswered("cred", answered)
  await walletStorage.batch(() => setActiveCredentialId("cred"))
}
const shown = () => localStorage.getItem(SHOWN_KEY)
const attempt = () => act(async () => provingProgress.emitSigningStart())

type Readers = NonNullable<Parameters<typeof localPasskeyHintApplies>[0]>
const readers = (over: Partial<Readers> = {}): Readers => ({
  posture: () => "laptop",
  shown: () => 0,
  record: () => ({ answered: "remote" }),
  osFamily: () => "macos",
  ...over,
})

describe("localPasskeyHintApplies", () => {
  it("a laptop whose passkey answered from another device is told, until the third showing", () => {
    expect(localPasskeyHintApplies(readers())).toBe(true)
    expect(localPasskeyHintApplies(readers({ shown: () => 2 }))).toBe(true)
    expect(localPasskeyHintApplies(readers({ shown: () => 3 }))).toBe(false)
  })

  it("a phone, a local answer, no answer and no record are not", () => {
    expect(localPasskeyHintApplies(readers({ posture: () => "phone" }))).toBe(false)
    expect(localPasskeyHintApplies(readers({ record: () => ({ answered: "local" }) }))).toBe(false)
    expect(localPasskeyHintApplies(readers({ record: () => ({}) }))).toBe(false)
    expect(localPasskeyHintApplies(readers({ record: () => undefined }))).toBe(false)
  })

  it("a record known to be a hardware key is not, whatever it answered", () => {
    const key = (over: object) => () => ({ answered: "remote" as const, ...over })
    expect(localPasskeyHintApplies(readers({ record: key({ transports: ["usb"] }) }))).toBe(false)
    expect(
      localPasskeyHintApplies(readers({ record: key({ inferredTransports: ["usb", "nfc"] }) })),
    ).toBe(false)
    expect(
      localPasskeyHintApplies(readers({ record: key({ transports: ["hybrid", "internal"] }) })),
    ).toBe(true)
  })

  it("an iCloud Keychain passkey is told on a Mac only; other providers anywhere", () => {
    const icloud = () => ({ answered: "remote" as const, prfAaguid: APPLE_ICLOUD_AAGUID })
    expect(localPasskeyHintApplies(readers({ record: icloud }))).toBe(true)
    for (const os of ["windows", "linux", "chromeos"] as const) {
      expect(localPasskeyHintApplies(readers({ record: icloud, osFamily: () => os }))).toBe(false)
    }
    const gpm = () => ({ answered: "remote" as const, prfAaguid: GPM_AAGUID })
    expect(localPasskeyHintApplies(readers({ record: gpm, osFamily: () => "windows" }))).toBe(true)
  })

  it("reads no record for a phone or once the showings are spent", () => {
    const record = vi.fn(() => ({ answered: "remote" as const }))
    localPasskeyHintApplies(readers({ posture: () => "phone", record }))
    localPasskeyHintApplies(readers({ shown: () => 3, record }))
    expect(record).not.toHaveBeenCalled()
  })
})

describe("from a real signature to the line", () => {
  const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_CHROME)
  })
  afterEach(() => vi.restoreAllMocks())

  it("a fresh account's first payment over QR puts the line on the next one", async () => {
    const { FakePasskeyCeremony } = await import("../support/fakePasskeyCeremony")
    const ceremony = new FakePasskeyCeremony({
      route: "cross-device",
      aaguid: APPLE_ICLOUD_AAGUID,
      transports: ["hybrid", "internal"],
    })
    const service = new WebAlphaAuthService({
      storage: new WebStorageAdapter(),
      rpId: RP,
      ceremony,
      posture: () => "laptop",
    })
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xacct",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      prfAaguid: created.prfAaguid,
      isMskRoot: true,
      authenticatorType: "platform",
      transports: created.transports,
    })
    await service.commitSecret({ secretKey: created.secretKey, authProvider: created.authProvider })
    expect(localPasskeyHintApplies()).toBe(false)

    if (!(created.authProvider instanceof WebAuthnAlphaAuthProvider)) {
      throw new Error("Expected a WebAuthn auth provider")
    }
    await created.authProvider.signChallenge(Fr.random().toBuffer())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(localPasskeyHintApplies()).toBe(true)
  })
})

describe("localPasskeyHintCopy", () => {
  it("names Touch ID on a Mac and nothing it cannot know elsewhere", () => {
    expect(localPasskeyHintCopy("macos")).toContain("choose Touch ID or your password manager")
    for (const os of ["windows", "linux", "unknown"] as const) {
      expect(localPasskeyHintCopy(os)).toContain(
        "choose the passkey saved on this computer or your password manager",
      )
    }
  })
})

describe("LocalPasskeyHint", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const mount = () => act(async () => root.render(<LocalPasskeyHint />))
  const remount = async () => {
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount()
  }
  const dismiss = () => container.querySelector("button")!

  it("shows before any attempt and counts each attempt once", async () => {
    await session()
    await mount()
    expect(container.textContent).toContain(LINE)
    expect(shown()).toBeNull()

    await attempt()
    expect(shown()).toBe("1")
    await attempt()
    expect(shown()).toBe("2")
    expect(container.textContent).toContain(LINE)
  })

  it("stays through its third attempt, then stops", async () => {
    await session()
    localStorage.setItem(SHOWN_KEY, "2")
    await mount()
    await attempt()
    expect(shown()).toBe("3")
    expect(container.textContent).toContain(LINE)

    await attempt()
    expect(container.textContent).toBe("")
    expect(shown()).toBe("3")
    await remount()
    expect(container.textContent).toBe("")
  })

  it("Don't show again is a focusable button that ends it for good", async () => {
    await session()
    await mount()
    expect(dismiss().type).toBe("button")
    dismiss().focus()
    expect(document.activeElement).toBe(dismiss())

    await act(async () => dismiss().click())
    expect(container.textContent).toBe("")
    expect(shown()).toBe("3")
    await remount()
    expect(container.textContent).toBe("")
  })

  it("a passkey that answered from this computer gets no line", async () => {
    await session("local")
    await mount()
    expect(container.textContent).toBe("")
  })

  it("a passkey this browser has not seen answer gets no line", async () => {
    await session(null)
    await mount()
    expect(container.textContent).toBe("")
  })

  it("with no session it renders nothing and counts nothing", async () => {
    await mount()
    await attempt()
    expect(container.textContent).toBe("")
    expect(shown()).toBeNull()
  })

  it("a store that cannot be read renders nothing", async () => {
    await session()
    const read = vi.spyOn(walletStorage, "getCommitted").mockImplementation(() => {
      throw new Error("wallet store closed")
    })
    await mount()
    expect(container.textContent).toBe("")

    read.mockRestore()
    vi.spyOn(deviceStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError")
    })
    await remount()
    expect(container.textContent).toBe("")
  })

  it("a store that refuses writes never breaks the beat, and dismissal still hides the line", async () => {
    await session()
    await mount()
    vi.spyOn(deviceStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    await attempt()
    expect(container.textContent).toContain(LINE)

    await act(async () => dismiss().click())
    expect(container.textContent).toBe("")
  })
})

describe("the working beat", () => {
  let container: HTMLDivElement
  let root: Root
  let ids: string[]

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement("div")
    root = createRoot(container)
    ids = []
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    for (const id of ids) await getOperationStore().remove(id)
  })

  async function begin(operationId: string) {
    ids.push(operationId)
    await act(async () => {
      await getOperationStore().begin({ operationId, flow: "send", summary: "$25", scope: null })
    })
  }

  it("carries the line from preparing through the prompt, and counts the attempt", async () => {
    await session()
    await begin("op-a")
    await act(async () => root.render(<OperationHandOff onLeave={() => {}} until="sent" />))
    expect(container.textContent).toContain("Preparing transaction")
    expect(container.textContent).toContain(LINE)
    expect(shown()).toBeNull()

    await attempt()
    expect(container.textContent).toContain("Confirm with passkey")
    expect(container.textContent).toContain(LINE)
    expect(shown()).toBe("1")

    await act(async () => provingProgress.emitSigningEnd())
    expect(container.textContent).toContain("Proving privately")
    expect(container.textContent).not.toContain(LINE)
    await act(async () => getOperationStore().markSent("op-a", hash))
  })

  it("an attempt that fails and is retried on the same beat counts twice", async () => {
    await session()
    await begin("op-retry")
    await act(async () => root.render(<OperationHandOff onLeave={() => {}} />))
    await attempt()
    await act(async () => provingProgress.emitSigningEnd(undefined, true))
    expect(container.textContent).toContain(LINE)
    await attempt()
    expect(shown()).toBe("2")
  })

  it("a flow that never prompts shows the line and spends no showing", async () => {
    await session()
    await begin("op-quiet")
    const onLeave = vi.fn()
    await act(async () => root.render(<OperationHandOff onLeave={onLeave} />))
    expect(container.textContent).toContain(LINE)
    await act(async () => provingProgress.emitStageStart("proving", "op-quiet"))
    expect(onLeave).toHaveBeenCalledOnce()
    expect(shown()).toBeNull()
  })

  it("a flow's own working render is handed the line", async () => {
    await session()
    await begin("op-own")
    await act(async () =>
      root.render(
        <OperationHandOff
          onLeave={() => {}}
          renderWorking={(beat, _label, hint) => (
            <div>
              own {beat} {hint}
            </div>
          )}
        />,
      ),
    )
    expect(container.textContent).toContain("own preparing")
    expect(container.textContent).toContain(LINE)
  })

  it("a beat rendered with no hint shows none", async () => {
    await session()
    await act(async () =>
      root.render(<PayWorking beat="preparing" label="Sending request…" warn={false} />),
    )
    expect(container.textContent).toBe("Sending request…")
  })
})
