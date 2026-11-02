import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { DEFAULT_CONTRACTS, getHardcodedArtifact } from "@obsidion/contracts"
import {
  type LinkKey,
  LinkKind,
  linkSecret,
  linkTag,
  randomLinkKey,
  sealLinkPayload,
} from "../../../../src/services/paylink/link/linkLocator.js"
import { linkEscrow } from "../../../../src/services/paylink/escrow/paylinkEscrow.js"
import {
  encodePaylinkInline,
  encodePaylinkLocatorPayload,
} from "../../../../src/services/paylink/link/paylinkInlineCodec.js"
import { deriveDeterministicPaylinkKeys } from "../../../../src/services/paylink/escrow/paylinkKeys.js"
import { resolveShortPaylink } from "../../../../src/services/paylink/link/shortPaylink.js"
import type { PaylinkParams } from "../../../../src/services/paylink/PaylinkService.js"

const DIRECT = DEFAULT_CONTRACTS.paylinkDirect

async function contractService() {
  const artifact = await getHardcodedArtifact(DIRECT)
  const locator = await getHardcodedArtifact(DEFAULT_CONTRACTS.linkLocator)
  const { id } = await getContractClassFromArtifact(artifact)
  const { id: locatorId } = await getContractClassFromArtifact(locator)
  const isLocator = (name: string) => name === DEFAULT_CONTRACTS.linkLocator
  return {
    getArtifactForClass: async (_: string, name: string) => (isLocator(name) ? locator : artifact),
    getKnownClassIds: async (name: string) => [(isLocator(name) ? locatorId : id).toString()],
    classId: id,
  }
}

async function shortLink(): Promise<{ params: PaylinkParams; key: LinkKey }> {
  const service = await contractService()
  const keys = await deriveDeterministicPaylinkKeys(Fr.random(), 20_700, 0, DIRECT)
  const params: PaylinkParams = {
    secret: keys.secretKey,
    paylinkType: DIRECT,
    fallbackKeyHash: keys.fallbackKeyHash,
    classId: service.classId,
    chainId: 31337,
    rollupVersion: 1,
    seed: keys.link!.seed,
    terms: Fr.random(),
  }
  return { params, key: keys.link! }
}

/**
 * A node holding `logs` under the link's tag, each in a tx with `nullifiers` and signed by `signer`,
 * the link's own key unless given.
 */
async function nodeWith(
  key: LinkKey,
  logs: { payload: Uint8Array; nullifiers: Fr[]; signer?: LinkKey }[],
): Promise<Pick<AztecNode, "getPrivateLogsByTags">> {
  const tag = await linkTag(await linkSecret(LinkKind.Paylink, key.seed))
  const sealed = logs.map(({ payload, nullifiers, signer }, i) => ({
    logData: [tag, ...sealLinkPayload(LinkKind.Paylink, signer ?? key, payload)],
    txHash: { toString: () => `0x${i}` },
    blockNumber: i + 1,
    nullifiers,
  }))
  return { getPrivateLogsByTags: async () => [sealed] } as never
}

describe("resolveShortPaylink", () => {
  it("returns the link whose escrow the announcing tx initialized", async () => {
    const service = await contractService()
    const { params, key } = await shortLink()
    const { instance } = await linkEscrow(service, params)
    const init = await computeSiloedPrivateInitializationNullifier(
      instance.address,
      instance.initializationHash,
    )
    const node = await nodeWith(key, [
      {
        payload: encodePaylinkLocatorPayload({ ...params, fallbackKeyHash: Fr.random() }),
        nullifiers: [init],
      },
      { payload: encodePaylinkLocatorPayload(params), nullifiers: [Fr.random(), init] },
    ])
    const resolved = await resolveShortPaylink({ node, contractService: service }, key.seed)
    expect(resolved && encodePaylinkInline(resolved)).toBe(encodePaylinkInline(params))
  })

  it("drops a payload any other key signed, even in the tx that initialized the escrow", async () => {
    const service = await contractService()
    const { params, key } = await shortLink()
    const { instance } = await linkEscrow(service, params)
    const init = await computeSiloedPrivateInitializationNullifier(
      instance.address,
      instance.initializationHash,
    )
    const forger = { secretKey: randomLinkKey().secretKey, seed: key.seed }
    const forged = {
      payload: encodePaylinkLocatorPayload({ ...params, terms: Fr.random() }),
      nullifiers: [init],
      signer: forger,
    }
    const alone = await nodeWith(key, [forged])
    expect(
      await resolveShortPaylink({ node: alone, contractService: service }, key.seed),
    ).toBeUndefined()
    const both = await nodeWith(key, [
      forged,
      { payload: encodePaylinkLocatorPayload(params), nullifiers: [init] },
    ])
    const resolved = await resolveShortPaylink({ node: both, contractService: service }, key.seed)
    expect(resolved?.terms).toEqual(params.terms)
  })

  it("is undefined before the create tx lands", async () => {
    const service = await contractService()
    const { key } = await shortLink()
    const node = await nodeWith(key, [])
    expect(await resolveShortPaylink({ node, contractService: service }, key.seed)).toBeUndefined()
  })
})
