// @vitest-environment node
import { passkeyWritten } from "@obsidion/passkey-web"
import { describe, expect, it } from "vitest"
import { WebAlphaAuthService } from "../../../../src/platform/auth/WebAlphaAuthService"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  MemoryStorage,
} from "../../../support/fakePasskeyCeremony"

const BITWARDEN = "d548826e-79b4-db40-a3d8-11116f7e8349"

function laptop(fake: FakeCeremonyOptions) {
  const ceremony = new FakePasskeyCeremony({ route: "cross-device", ...fake })
  const service = new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => "laptop",
  })
  return { service, ceremony }
}

describe("creation admits only the measured providers", () => {
  it("names the manager, records nothing, and issues no follow-up assertion", async () => {
    const { service, ceremony } = laptop({ aaguid: BITWARDEN })
    await expect(service.createPasskey("@alice")).rejects.toMatchObject({
      name: "UnsupportedProviderError",
      providerName: "Bitwarden",
    })
    expect(ceremony.assertRequests).toHaveLength(0)
    expect(await service.rootCredentialId()).toBeUndefined()
    // The refusal leaves the service as the driver threw it: marked as written.
    const refused = await service.createPasskey("@alice").catch((e: unknown) => e)
    expect(passkeyWritten(refused)).toBe(true)
  })
})
