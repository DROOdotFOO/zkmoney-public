// @vitest-environment node
import { describe, expect, it } from "vitest"
import { WebAlphaAuthService } from "../../../src/platform/auth/WebAlphaAuthService"
import { FakePasskeyCeremony, MemoryStorage } from "../../support/fakePasskeyCeremony"

function laptop() {
  const ceremony = new FakePasskeyCeremony({ route: "cross-device" })
  const service = new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
  })
  return { service, ceremony }
}

describe("recoverPasskey requests", () => {
  it("names the recorded root by default and leaves the list open for the chooser", async () => {
    const { service, ceremony } = laptop()
    const created = await service.createPasskey("@alice")
    await service.recordRecoveryMetadata({
      credentialId: created.credentialId,
      l2Address: "0xabc",
      pubkey: created.pubkey,
      prfSlot: created.prfSlot,
      isMskRoot: true,
    })
    await service.recoverPasskey({})
    expect(ceremony.asserts.at(-1)).toEqual([created.credentialId])
    await service.recoverPasskey({ discover: true })
    expect(ceremony.asserts.at(-1)).toBeUndefined()
    await service.recoverPasskey({ credentialId: created.credentialId })
    expect(ceremony.asserts.at(-1)).toEqual([created.credentialId])
  })
})
