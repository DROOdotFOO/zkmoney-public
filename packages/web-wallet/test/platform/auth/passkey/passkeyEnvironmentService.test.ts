// @vitest-environment node
import { lastPasskeyEnvironment } from "@obsidion/passkey-web"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PASSKEY_ENVIRONMENT_KEY } from "../../../../src/platform/auth/passkeyEnvironmentKey"
import { WebAlphaAuthService } from "../../../../src/platform/auth/WebAlphaAuthService"
import { FakePasskeyCeremony, MemoryStorage } from "../../../support/fakePasskeyCeremony"

const ICLOUD = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

function stubBrowser(navigatorExtras: Record<string, unknown> = {}) {
  const map = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  })
  vi.stubGlobal("navigator", { userAgent: MAC_SAFARI, ...navigatorExtras })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const last = () => lastPasskeyEnvironment(PASSKEY_ENVIRONMENT_KEY)

function laptop(ceremony: FakePasskeyCeremony, storage = new MemoryStorage()) {
  return new WebAlphaAuthService({ storage, rpId: "localhost", ceremony, posture: () => "laptop" })
}

describe("passkey environment collection in the auth service", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("keeps the label the browser reported even when the driver corrects it", async () => {
    stubBrowser()
    const ceremony = new FakePasskeyCeremony({
      route: "cross-device",
      aaguid: ICLOUD,
      transports: ["hybrid", "internal"],
      attachment: "platform",
    })
    const service = new WebAlphaAuthService({
      storage: new MemoryStorage(),
      rpId: "localhost",
      ceremony,
      posture: () => "laptop",
      misreportsCrossDevice: () => true,
    })
    const created = await service.createPasskey("@alice")
    await flush()
    expect(created.prfSlot).toBe("first")
    expect(last()?.attachment).toBe("platform")
    expect(last()?.transports).toEqual(["hybrid", "internal"])
    // A sign-in that follows keeps what the creation reported.
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect(last()?.attachment).toBe("platform")
  })

  it("a creation that needs the chained assertion still records the creation's manager id", async () => {
    stubBrowser()
    const ceremony = new FakePasskeyCeremony({
      route: "cross-device",
      aaguid: ICLOUD,
      prfAtCreate: false,
    })
    const created = await laptop(ceremony).createPasskey("@alice")
    await flush()
    expect(ceremony.assertRequests).toHaveLength(1)
    expect(created.prfAaguid).toBe(ICLOUD)
    expect(last()?.aaguid).toBe(ICLOUD)
  })

  it("an unlock takes the manager id from the credential's record, or reports unknown", async () => {
    stubBrowser()
    const ceremony = new FakePasskeyCeremony({ route: "cross-device", aaguid: ICLOUD })
    const service = laptop(ceremony)
    const created = await service.createPasskey("@alice")
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect(last()?.aaguid).toBe("unknown")

    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      prfAaguid: created.prfAaguid,
      isMskRoot: true,
    })
    await service.recoverPasskey({ credentialId: created.credentialId })
    await flush()
    expect(last()?.aaguid).toBe(ICLOUD)
  })

  it("a Client Hints answer that never settles does not hold the ceremony", async () => {
    stubBrowser({
      userAgentData: { mobile: false, getHighEntropyValues: () => new Promise(() => {}) },
    })
    const ceremony = new FakePasskeyCeremony({ route: "cross-device", aaguid: ICLOUD })
    const service = laptop(ceremony)
    const created = await service.createPasskey("@alice")
    expect(created.prfSlot).toBe("first")
    await expect(
      service.recoverPasskey({ credentialId: created.credentialId }),
    ).resolves.toMatchObject({
      credentialId: created.credentialId,
    })
    expect(last()).toBeNull()
  })
})
