/**
 * A frozen portal refunds an open payment link's notes to its creator under the escrow's fallback
 * key. Pure key derivation over the real escrow artifact; no PXE, no node.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import {
  CompleteAddress,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import { deriveRefundOwnerAddress } from "@oxide/oxide-lib/migration_signature.js"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { PaylinkService } from "../../../../src/services/paylink/PaylinkService.js"
import {
  discoverFrozenEscrows,
  paylinkRefundOwner,
} from "../../../../src/services/paylink/escrow/frozenEscrows.js"
import {
  deriveDeterministicPaylinkKeys,
  type derivePaylinkKeys,
} from "../../../../src/services/paylink/escrow/paylinkKeys.js"

const ARTIFACT = loadContractArtifact(
  JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "../../../../../contracts/src/artifacts/target/paylink_direct/paylink_direct-PaylinkDirect.json",
      ),
      "utf-8",
    ),
  ) as NoirCompiledContract,
)
const escrowOf = (keys: {
  publicKeys: Awaited<ReturnType<typeof derivePaylinkKeys>>["publicKeys"]
}) =>
  getContractInstanceFromInstantiationParams(ARTIFACT, {
    salt: new Fr(0n),
    publicKeys: keys.publicKeys,
  })

describe("paylinkRefundOwner", () => {
  it("authorizes with the creator's fallback key, under the escrow's own address", async () => {
    const keys = await deriveDeterministicPaylinkKeys(
      Fr.random(),
      20_000,
      0,
      DEFAULT_CONTRACTS.paylinkDirect,
    )
    const escrow = await escrowOf(keys)
    const owner = await paylinkRefundOwner(escrow, keys, keys.fallbackSecret!)
    expect(owner!.signer.kind).toBe("fallbackKey")
    expect((await deriveRefundOwnerAddress(owner!)).equals(escrow.address)).toBe(true)
    expect(await paylinkRefundOwner(escrow, keys, Fr.random())).toBeUndefined()
  })
})

describe("discoverFrozenEscrows", () => {
  async function fixture() {
    const creator = (await CompleteAddress.fromSecretKeyAndPartialAddress(Fr.random(), Fr.random()))
      .address
    const contractService = {
      getArtifactForContract: async () => ARTIFACT,
      getArtifactForClass: async () => ARTIFACT,
      getKnownClassIds: async () => [(await getContractClassFromArtifact(ARTIFACT)).id.toString()],
    }
    const service = new PaylinkService(
      { getNodeIdentity: async () => ({ l1ChainId: 31337, rollupVersion: 1 }) } as never,
      { getAddress: () => creator } as never,
      null as never,
      contractService as never,
    )
    const masterSecret = Fr.random()
    const discoverFrom = (events: Parameters<typeof discoverFrozenEscrows>[0]["events"]) =>
      discoverFrozenEscrows({
        paylinkService: {
          recoverPaylinkFromTransfer: service.recoverPaylinkFromTransfer.bind(service),
        },
        escrows: { wallet: {}, contractService } as never,
        events,
        account: creator,
        masterSecret,
        hints: [],
      })
    return { discoverFrom }
  }

  it("throws when the transfer scan fails, so a scan is never partial", async () => {
    const { discoverFrom } = await fixture()
    await expect(
      discoverFrom({
        headBlock: async () => 9,
        listIncoming: async () => {
          throw new Error("node down")
        },
      }),
    ).rejects.toThrow("node down")
  })
})
