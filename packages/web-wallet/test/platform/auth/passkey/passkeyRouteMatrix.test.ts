/**
 * The route × manager matrix behind the slot rule. For every manager, an account created over one
 * route must be recovered over the other by an address anchor. Expected PRF values come from the
 * fake's own model, which hashes with its own SHA-256 rather than the sdk's `contextualize`.
 */
// @vitest-environment node
import { Fr } from "@aztec-labs/aztec.js/fields"
import { GPM_AAGUID } from "@obsidion/core/constants"
import { selectRecoveredMsk } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { WebAlphaAuthService } from "../../../../src/platform/auth/WebAlphaAuthService"
import type { DevicePosture } from "@obsidion/passkey-web"
import {
  FakePasskeyCeremony,
  type FakeManager,
  type FakeRoute,
  MemoryStorage,
} from "../../../support/fakePasskeyCeremony"

const MANAGERS: FakeManager[] = ["icloud", "1password", "gpm"]
const ROUTES: FakeRoute[] = ["local", "cross-device"]
const postureFor = (route: FakeRoute): DevicePosture => (route === "local" ? "phone" : "laptop")

/** A wallet address derivation the tests can predict: the master key itself. */
const deriveAddress = async (msk: Fr) => msk.toString()

function service(ceremony: FakePasskeyCeremony, posture: DevicePosture) {
  return new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: "localhost",
    ceremony,
    posture: () => posture,
  })
}

describe("route × manager: an account created on one route opens on the other", () => {
  for (const manager of MANAGERS) {
    for (const createRoute of ROUTES) {
      for (const readRoute of ROUTES.filter((route) => route !== createRoute)) {
        it(`${manager}: created over ${createRoute}, recovered over ${readRoute}`, async () => {
          const ceremony = new FakePasskeyCeremony({ manager, route: createRoute })
          const creator = service(ceremony, postureFor(createRoute))
          const created = await creator.createPasskey("@alice")
          const address = await deriveAddress(created.secretKey)

          // A browser holding the record: the stored address is the anchor.
          ceremony.opts.route = readRoute
          const reader = service(ceremony, postureFor(readRoute))
          await reader.recordRecoveryMetadata({
            credentialId: created.credentialId,
            l2Address: address,
            pubkey: created.pubkey,
            prfSlot: created.prfSlot,
            isMskRoot: true,
          })
          const recovered = await reader.recoverPasskey({ credentialId: created.credentialId })
          const candidates = [recovered.candidates.first, recovered.candidates.second]
            .filter((c): c is Fr => c !== undefined)
            .map((c) => c.toString())
          expect(candidates).toContain(address)
          // The stored address picks that candidate out of the pair, whatever slot it sits in.
          const picked = await selectRecoveredMsk(recovered, deriveAddress)
          expect(picked.toString()).toBe(created.secretKey.toString())
        })
      }
    }
  }
})

describe("route × manager: refusals", () => {
  it("laptop posture answered locally by a named manager binds slot second only on this computer's route", async () => {
    const ceremony = new FakePasskeyCeremony({ manager: "gpm", route: "local", aaguid: GPM_AAGUID })
    const offered = service(ceremony, "laptop")
    offered.useLaptopCreation({
      local: true,
      os: "windows",
      row: "windowsChrome",
      managers: ["gpm"],
      withdrawn: [],
    })
    const created = await offered.createPasskey("@a", undefined, { route: "this-device" })
    expect(created.prfSlot).toBe("second")
    expect(created.secretKey.toString()).toBe(
      Fr.fromBufferReduce(
        Buffer.from(ceremony.prfFor(created.credentialId, "second", "local")),
      ).toString(),
    )
    // The same answer with no route picked is still the phone's rule.
    await expect(service(ceremony, "laptop").createPasskey("@a")).rejects.toMatchObject({
      name: "PhoneRequiredError",
    })
  })
})
