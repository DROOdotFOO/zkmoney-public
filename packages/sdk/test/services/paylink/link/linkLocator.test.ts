import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import {
  bundledLinkLocator,
  bytesToBase64Url,
  decodeLinkFragment,
  encodeLinkFragment,
  LINK_SEED_BYTES,
  LinkKind,
  linkKeyFromSecret,
  linkLocatorAddresses,
  linkSecret,
  MAX_LINK_PAYLOAD_BYTES,
  openLinkPayload,
  randomLinkKey,
  sealLinkPayload,
  shortLinksEnabled,
} from "../../../../src/services/paylink/link/linkLocator.js"

const seed = Uint8Array.from({ length: LINK_SEED_BYTES }, (_, i) => i + 1)
const key = linkKeyFromSecret(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
const data = new TextEncoder().encode("a synthetic payload")

describe("link payloads", () => {
  it("round-trips under the link's key, with a fresh nonce each seal", () => {
    const sealed = sealLinkPayload(LinkKind.Paylink, key, data)
    expect(sealed).toHaveLength(15)
    expect(openLinkPayload(LinkKind.Paylink, key.seed, sealed)).toEqual(data)
    const again = sealLinkPayload(LinkKind.Paylink, key, data)
    expect(again.some((field, i) => !field.equals(sealed[i]!))).toBe(true)
  })

  it("round-trips an empty and a full payload", () => {
    for (const length of [0, MAX_LINK_PAYLOAD_BYTES]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 7) % 256)
      expect(
        openLinkPayload(LinkKind.Request, key.seed, sealLinkPayload(LinkKind.Request, key, bytes)),
      ).toEqual(bytes)
    }
  })

  it("refuses a payload over the log's capacity", () => {
    expect(() =>
      sealLinkPayload(LinkKind.Request, key, new Uint8Array(MAX_LINK_PAYLOAD_BYTES + 1)),
    ).toThrow()
  })

  it("opens nothing under another kind or seed", () => {
    const sealed = sealLinkPayload(LinkKind.Paylink, key, data)
    expect(openLinkPayload(LinkKind.Request, key.seed, sealed)).toBeUndefined()
    expect(openLinkPayload(LinkKind.Paylink, seed, sealed)).toBeUndefined()
  })

  it("drops a payload signed by any key but the one its seed hashes", () => {
    const forged = sealLinkPayload(
      LinkKind.Request,
      { secretKey: randomLinkKey().secretKey, seed: key.seed },
      data,
    )
    expect(openLinkPayload(LinkKind.Request, key.seed, forged)).toBeUndefined()
  })

  it("drops a payload changed after it was sealed", () => {
    const sealed = sealLinkPayload(LinkKind.Request, key, data)
    for (const i of [0, 3, 14]) {
      const tampered = [...sealed]
      tampered[i] = tampered[i]!.add(new Fr(1))
      expect(openLinkPayload(LinkKind.Request, key.seed, tampered)).toBeUndefined()
    }
  })

  it("gives each kind its own secret", async () => {
    const paylink = await linkSecret(LinkKind.Paylink, seed)
    const request = await linkSecret(LinkKind.Request, seed)
    expect(paylink.equals(request)).toBe(false)
  })
})

describe("link fragments", () => {
  it("round-trips kind and seed in 23 characters", () => {
    const fragment = encodeLinkFragment(LinkKind.Request, seed)
    expect(fragment).toHaveLength(23)
    expect(decodeLinkFragment(fragment)).toEqual({ kind: LinkKind.Request, seed })
  })

  it("rejects other fragments", () => {
    expect(decodeLinkFragment("")).toBeUndefined()
    expect(decodeLinkFragment("not a fragment!")).toBeUndefined()
    expect(decodeLinkFragment(bytesToBase64Url(Uint8Array.from([9, ...seed])))).toBeUndefined()
    expect(decodeLinkFragment(bytesToBase64Url(Uint8Array.from([1, ...seed, 0])))).toBeUndefined()
  })
})

/** A contract service whose locator has the bundled class and a retired one; `served` is the profile's row. */
async function locatorService(served: () => string | undefined = () => undefined) {
  const artifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.linkLocator)
  const { id } = await getContractClassFromArtifact(artifact)
  return {
    artifact,
    getArtifactForClass: async () => artifact,
    getKnownClassIds: async () => [id.toString(), Fr.random().toString()],
    getConfiguredClassId: served,
  }
}

describe("LinkLocator classes", () => {
  it("looks under every class the locator has had, the bundled instance first", async () => {
    const service = await locatorService()
    const bundled = await getContractInstanceFromInstantiationParams(service.artifact, {
      salt: new Fr(0n),
    })
    const addresses = await linkLocatorAddresses(service)
    expect(addresses).toHaveLength(2)
    expect(addresses[0]!.equals(bundled.address)).toBe(true)
    expect(addresses[1]!.equals(bundled.address)).toBe(false)
  })

  it("reads the bundled instance alone with no contract service", async () => {
    const [bundled] = await linkLocatorAddresses(await locatorService())
    const addresses = await linkLocatorAddresses(bundledLinkLocator)
    expect(addresses).toHaveLength(1)
    expect(addresses[0]!.equals(bundled!)).toBe(true)
  })

  it("announces only on a deployment that states a locator", async () => {
    expect(await shortLinksEnabled(await locatorService())).toBe(true)
    const missing = await locatorService(() => {
      throw new Error("states no class id")
    })
    expect(await shortLinksEnabled(missing)).toBe(false)
  })
})
