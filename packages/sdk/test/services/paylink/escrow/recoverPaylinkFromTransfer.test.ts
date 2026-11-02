/**
 * `PaylinkService.recoverPaylinkFromTransfer`: the lane in a funding Transfer's meta yields the link
 * only when its secret and tagging key derive the escrow the transfer paid AND the creator's master
 * secret re-derives that secret on the lane's day. Pure key derivation over the real escrow
 * artifact; no PXE, no node.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import {
  CompleteAddress,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { PaylinkService } from "../../../../src/services/paylink/PaylinkService.js"
import {
  deriveDeterministicPaylinkKeys,
  derivePaylinkKeys,
} from "../../../../src/services/paylink/escrow/paylinkKeys.js"
import {
  buildTransferMeta,
  buildTransferMetaForSend,
  decodeTransferMeta,
} from "../../../../src/services/token/transferMeta.js"
import type { ScannedTransferEvent } from "../../../../src/services/token/transferEventSource.js"

const target = (path: string) =>
  loadContractArtifact(
    JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../../contracts/src/artifacts/target", path),
        "utf-8",
      ),
    ) as NoirCompiledContract,
  )
const ARTIFACT = target("paylink_direct/paylink_direct-PaylinkDirect.json")
// Another escrow class with the same derivation, standing in for an earlier PaylinkDirect class.
const EARLIER = target("paylink_email/paylink_email-PaylinkEmail.json")
const classIdOf = async (artifact: typeof ARTIFACT) =>
  (await getContractClassFromArtifact(artifact)).id

describe("PaylinkService.recoverPaylinkFromTransfer", () => {
  it("rebuilds the link for the creator only, and refuses a stray or foreign lane", async () => {
    const creator = (await CompleteAddress.fromSecretKeyAndPartialAddress(Fr.random(), Fr.random()))
      .address
    const service = new PaylinkService(
      { getNodeIdentity: async () => ({ l1ChainId: 31337, rollupVersion: 1 }) } as never,
      { getAddress: () => creator } as never,
      null as never,
      {
        getArtifactForContract: async () => ARTIFACT,
        getKnownClassIds: async () => [(await classIdOf(ARTIFACT)).toString()],
      } as never,
    )
    const masterSecret = Fr.random()
    const day = 20_000
    const keys = await deriveDeterministicPaylinkKeys(
      masterSecret,
      day,
      3,
      DEFAULT_CONTRACTS.paylinkDirect,
    )
    const escrow = await getContractInstanceFromInstantiationParams(ARTIFACT, {
      salt: new Fr(0n),
      publicKeys: keys.publicKeys,
    })
    const meta = service.depositMeta(DEFAULT_CONTRACTS.paylinkDirect, { paylinkKeys: keys })
    const decoded = decodeTransferMeta(meta)
    // The lane never carries the fallback secret; only the key's hash and the nonce day.
    expect(decoded.paylinkCreated).toEqual({
      flavor: "direct",
      day,
      secret: keys.secretKey,
      fallbackKeyHash: keys.fallbackKeyHash,
    })
    const event: ScannedTransferEvent = {
      txHash: "0xabc",
      from: creator.toString(),
      to: escrow.address.toString(),
      amount: "1000000",
      blockNumber: 7,
      ...decoded,
    }

    const params = await service.recoverPaylinkFromTransfer(event, masterSecret)
    expect(params).toMatchObject({
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      txHash: "0xabc",
      amount: 1_000_000n,
      chainId: 31337,
      rollupVersion: 1,
      email: undefined,
    })
    expect(params!.secret.equals(keys.secretKey)).toBe(true)
    expect(params!.fallbackSecret.equals(keys.fallbackSecret!)).toBe(true)
    expect(params!.fallbackKeyHash.equals(keys.fallbackKeyHash)).toBe(true)
    expect(params!.classId.equals(escrow.currentContractClassId)).toBe(true)

    // A link holder rebuilds the funded escrow's address from the secret and the fallback hash.
    const claimer = await derivePaylinkKeys({
      secretKey: params!.secret,
      fallbackKeyHash: params!.fallbackKeyHash,
    })
    const rebuilt = await getContractInstanceFromInstantiationParams(ARTIFACT, {
      salt: new Fr(0n),
      publicKeys: claimer.publicKeys,
    })
    expect(rebuilt.address.equals(escrow.address)).toBe(true)
    expect(claimer.fallbackSecret).toBeUndefined()
    expect(params!.escrowTagSecret).toBeDefined()

    // A link holder holds the lane too, but not the master secret: nothing comes back.
    expect(await service.recoverPaylinkFromTransfer(event, Fr.random())).toBeNull()

    // The same lane on a transfer to any other address is not this creator's escrow.
    const stray = { ...event, to: AztecAddress.fromBigIntUnsafe(99n).toString() }
    expect(await service.recoverPaylinkFromTransfer(stray, masterSecret)).toBeNull()

    // A lane stamped with the wrong day names no slot that derives the secret.
    const wrongDay = { ...event, paylinkCreated: { ...decoded.paylinkCreated!, day: day + 1 } }
    expect(await service.recoverPaylinkFromTransfer(wrongDay, masterSecret)).toBeNull()

    // Keys without a nonce (bring-your-own) announce no link.
    const bare = { ...keys }
    delete bare.nonce
    expect(service.depositMeta(DEFAULT_CONTRACTS.paylinkDirect, { paylinkKeys: bare })).toEqual(
      buildTransferMetaForSend({}),
    )
    expect(
      await service.recoverPaylinkFromTransfer(
        { ...event, paylinkCreated: undefined },
        masterSecret,
      ),
    ).toBeNull()

    // An email lane carries the plaintext email through to the link's display hint.
    const emailMeta = buildTransferMeta({
      paylinkCreated: { ...decoded.paylinkCreated!, email: "a@b.c" },
    })
    const withEmail = await service.recoverPaylinkFromTransfer(
      { ...event, ...decodeTransferMeta(emailMeta) },
      masterSecret,
    )
    expect(withEmail?.email).toBe("a@b.c")
  })

  it("rebuilds the link of an escrow funded under an earlier class, carrying that class", async () => {
    const creator = (await CompleteAddress.fromSecretKeyAndPartialAddress(Fr.random(), Fr.random()))
      .address
    const service = new PaylinkService(
      { getNodeIdentity: async () => ({ l1ChainId: 31337, rollupVersion: 1 }) } as never,
      { getAddress: () => creator } as never,
      null as never,
      {
        getArtifactForContract: async () => ARTIFACT,
        getKnownClassIds: async () =>
          [await classIdOf(ARTIFACT), await classIdOf(EARLIER)].map(String),
      } as never,
    )
    const masterSecret = Fr.random()
    const keys = await deriveDeterministicPaylinkKeys(
      masterSecret,
      20_000,
      0,
      DEFAULT_CONTRACTS.paylinkDirect,
    )
    const earlier = await getContractInstanceFromInstantiationParams(EARLIER, {
      salt: new Fr(0n),
      publicKeys: keys.publicKeys,
    })
    const event: ScannedTransferEvent = {
      txHash: "0xabc",
      from: creator.toString(),
      to: earlier.address.toString(),
      amount: "1000000",
      blockNumber: 7,
      ...decodeTransferMeta(
        service.depositMeta(DEFAULT_CONTRACTS.paylinkDirect, { paylinkKeys: keys }),
      ),
    }

    const params = await service.recoverPaylinkFromTransfer(event, masterSecret)
    expect(params!.classId.equals(earlier.currentContractClassId)).toBe(true)
  })
})
