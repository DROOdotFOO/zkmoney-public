/**
 * What the alpha account entrypoint signs: the payload hash bound to the account address, chain id
 * and rollup version, with the tx context built from the same chain info. The pinned vector is the
 * one the Noir side pins, so the two wraps cannot drift apart.
 *
 * Run:
 *   pnpm test test/obsidion-wallet/entrypoint-message-hash.test.ts
 */
import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { AuthWitness, computeOuterAuthWitHash } from "@aztec-labs/stdlib/auth-witness"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { EncodedAppEntrypointCalls } from "@aztec-labs/entrypoints/encoding"
import { AccountFeePaymentMethodOptions } from "@aztec-labs/entrypoints/account"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import { DomainSeparator } from "@aztec-labs/constants"
import { CAPSULE_SLOT } from "../../../../src/utils/constants.js"
import { ObsidionAccountEntrypoint } from "../../../../src/obsidion/alpha/account/ObsidionAccountEntrypoint.js"
import { stubGasSettingsFallback } from "../../../utils/wallet/obsidionWalletStubs.js"

/** `SIGNED_MESSAGE_VECTOR` in `contracts/alpha/lib/src/utils.nr`: address 0x1234, chain 31337, version 1, inner 0xabc. */
const VECTOR = "0x2ca23d1f9e552b59f588bd5d060d0208869f813ca982298eadbc462930218933"

const ADDRESS = AztecAddress.fromBigIntUnsafe(0x1234n)
const CHAIN = { chainId: new Fr(31337), version: new Fr(1) }
const gasSettings = stubGasSettingsFallback()

function makeEntrypoint(address = ADDRESS) {
  const signed: Fr[] = []
  const createAuthWit = vi.fn(async (hash: Fr) => {
    signed.push(hash)
    return new AuthWitness(hash, [])
  })
  return { entrypoint: new ObsidionAccountEntrypoint(address, { createAuthWit } as never), signed }
}

const emptyExec = () => new ExecutionPayload([], [], [], [])

const options = (txNonce: Fr) => ({
  txNonce,
  feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
})

async function expectedHashes(
  address: AztecAddress,
  chain: { chainId: Fr; version: Fr },
  txNonce: Fr,
  intents: Fr[] = [],
) {
  const appHash = await (await EncodedAppEntrypointCalls.create([], txNonce)).hash()
  const inner =
    intents.length === 0
      ? appHash
      : await poseidon2HashWithSeparator(
          [appHash, ...intents, ...Array(4 - intents.length).fill(Fr.ZERO)],
          DomainSeparator.SIGNATURE_PAYLOAD,
        )
  const outer = await computeOuterAuthWitHash(address, chain.chainId, chain.version, inner)
  return { appHash, outer }
}

describe("ObsidionAccountEntrypoint signed message", () => {
  it("signs the payload hash bound to the account, chain and version, and builds the tx context from the same chain info", async () => {
    const { entrypoint, signed } = makeEntrypoint()
    const txNonce = Fr.random()
    const request = await entrypoint.createTxExecutionRequest(
      emptyExec(),
      gasSettings,
      CHAIN,
      options(txNonce),
    )
    const { outer } = await expectedHashes(ADDRESS, CHAIN, txNonce)
    expect(signed).toHaveLength(1)
    expect(signed[0]!.equals(outer)).toBe(true)
    expect(request.authWitnesses.at(-1)!.requestHash.equals(outer)).toBe(true)
    expect(request.txContext.chainId.equals(CHAIN.chainId)).toBe(true)
    expect(request.txContext.version.equals(CHAIN.version)).toBe(true)
  })

  it("changes the signed message when the chain id, the version or the account changes", async () => {
    const txNonce = Fr.random()
    const base = makeEntrypoint()
    await base.entrypoint.createTxExecutionRequest(
      emptyExec(),
      gasSettings,
      CHAIN,
      options(txNonce),
    )

    const otherChain = makeEntrypoint()
    await otherChain.entrypoint.createTxExecutionRequest(
      emptyExec(),
      gasSettings,
      { ...CHAIN, chainId: new Fr(31338) },
      options(txNonce),
    )
    const otherVersion = makeEntrypoint()
    await otherVersion.entrypoint.createTxExecutionRequest(
      emptyExec(),
      gasSettings,
      { ...CHAIN, version: new Fr(2) },
      options(txNonce),
    )
    const otherAccount = makeEntrypoint(AztecAddress.fromBigIntUnsafe(0x1235n))
    await otherAccount.entrypoint.createTxExecutionRequest(
      emptyExec(),
      gasSettings,
      CHAIN,
      options(txNonce),
    )

    for (const other of [otherChain, otherVersion, otherAccount]) {
      expect(other.signed[0]!.equals(base.signed[0]!)).toBe(false)
    }
  })

  it("wraps the combined payload-and-intents hash and keeps the capsule's app hash unwrapped", async () => {
    const { entrypoint, signed } = makeEntrypoint()
    const txNonce = Fr.random()
    const intent = new AuthWitness(Fr.random(), [])
    const request = await entrypoint.createTxExecutionRequest(
      new ExecutionPayload([], [intent], [], []),
      gasSettings,
      CHAIN,
      options(txNonce),
    )
    const { appHash, outer } = await expectedHashes(ADDRESS, CHAIN, txNonce, [intent.requestHash])
    expect(signed[0]!.equals(outer)).toBe(true)
    const capsule = request.capsules.find((c) => c.storageSlot.equals(new Fr(CAPSULE_SLOT)))
    expect(capsule?.data[0]!.equals(appHash)).toBe(true)
  })

  it("wrapExecutionPayload signs the same message as createTxExecutionRequest", async () => {
    const txNonce = Fr.random()
    const direct = makeEntrypoint()
    await direct.entrypoint.createTxExecutionRequest(
      emptyExec(),
      gasSettings,
      CHAIN,
      options(txNonce),
    )
    const wrapped = makeEntrypoint()
    const payload = await wrapped.entrypoint.wrapExecutionPayload(
      emptyExec(),
      CHAIN,
      options(txNonce),
    )
    expect(wrapped.signed[0]!.equals(direct.signed[0]!)).toBe(true)
    expect(payload.authWitnesses[0]!.requestHash.equals(direct.signed[0]!)).toBe(true)
  })

  it("matches the contract's pinned vector", async () => {
    const hash = await computeOuterAuthWitHash(ADDRESS, new Fr(31337), new Fr(1), new Fr(0xabc))
    expect(hash.toString()).toBe(VECTOR)
  })
})
