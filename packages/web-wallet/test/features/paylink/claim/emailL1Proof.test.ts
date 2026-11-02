// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  generate: vi.fn(),
  assertEmail: vi.fn(),
  nonce: vi.fn(() => "nonce"),
  auth: vi.fn(() => {
    throw new Error("Account access is forbidden")
  }),
}))
vi.mock("../../../../src/features/paylink/googleAuth", () => ({ signInWithGoogleIdToken: mocks.login }))
vi.mock("../../../../src/features/paylink/zkJwtProver", () => ({ WebZkJwtProver: class {} }))
vi.mock("../../../../src/config/env", () => ({ getConfig: () => ({ googleClientId: "google-client" }) }))
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({ getAuthService: mocks.auth }))
vi.mock("../../../../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../../../../src/platform/storage/MskWebCryptoProvider", () => ({ MskWebCryptoProvider: class {} }))
vi.mock("@obsidion/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@obsidion/sdk")>()
  return {
    assertJwtEmailMatchesCommitment: mocks.assertEmail,
    PaylinkService: { computeNonce: mocks.nonce },
    EmailMismatchError: class extends Error {},
    paylinkL1Caller: actual.paylinkL1Caller,
    plainUserPayload: actual.plainUserPayload,
  }
})
vi.mock("@obsidion/front-core", () => ({
  generateZkJwtProof: mocks.generate,
  EncryptedStorageAdapter: class {},
  ZkJwtService: class {},
  ZkJwtStorage: class {},
}))
const { emailL1Caller, obtainEmailL1Proof } = await import("../../../../src/features/paylink/emailClaim")
const { paylinkL1Caller, plainUserPayload } = await vi.importActual<typeof import("@obsidion/sdk")>(
  "@obsidion/sdk",
)
const recipient = "0x2222222222222222222222222222222222222222"
const executor = "0x3333333333333333333333333333333333333333"
const caller = await emailL1Caller(executor, recipient)
const params = {
  paylinkType: "paylinkEmail",
  commitment: new Fr(3).toString(),
  email: "a@example.com",
}
const bundle = () => ({
  proof: ["proof"],
  vkey: ["key"],
  publicInputs: [caller.toString(), "0x02", "0x03", "0x04", "0x05", "0x06", "0x07"],
  metadata: { email: params.email },
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.login.mockResolvedValue("jwt")
  mocks.generate.mockResolvedValue(bundle())
  mocks.assertEmail.mockImplementation(() => {})
})

describe("email withdrawal caller", () => {
  it("binds the executor and the plain payload paying the payee", async () => {
    expect(caller.equals(EthAddress.fromString(recipient).toField())).toBe(false)
    expect(
      caller.equals(
        await paylinkL1Caller({
          executor: EthAddress.fromString(executor),
          userPayload: plainUserPayload(EthAddress.fromString(recipient)),
        }),
      ),
    ).toBe(true)
    // Another payee (a swap escrow) or another executor is another caller.
    const escrow = "0x4444444444444444444444444444444444444444"
    expect((await emailL1Caller(executor, escrow)).equals(caller)).toBe(false)
    expect((await emailL1Caller(escrow, recipient)).equals(caller)).toBe(false)
  })
})

describe("email withdrawal verification", () => {
  it("opens Google immediately and binds the nonce and prover to the caller without account access", async () => {
    const controller = new AbortController()
    const result = obtainEmailL1Proof(caller, params, vi.fn(), () => true, controller.signal)
    expect(mocks.login).toHaveBeenCalledWith(
      "nonce",
      "google-client",
      params.email,
      controller.signal,
    )
    await expect(result).resolves.toMatchObject({ public_inputs: bundle().publicInputs })
    expect(mocks.nonce).toHaveBeenCalledWith(expect.any(BigInt), caller.toBigInt())
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.anything(),
      "jwt",
      "google",
      expect.any(BigInt),
      caller.toString(),
      expect.any(Function),
    )
    expect(mocks.auth).not.toHaveBeenCalled()
  })

  it("discards a late proof and rejects a mismatched returned destination", async () => {
    mocks.generate.mockImplementationOnce(async () => {
      active = false
      return bundle()
    })
    let active = true
    await expect(obtainEmailL1Proof(caller, params, vi.fn(), () => active)).rejects.toThrow(
      "Cancelled",
    )
    mocks.generate.mockResolvedValueOnce({
      ...bundle(),
      publicInputs: ["0x01", ...bundle().publicInputs.slice(1)],
    })
    await expect(obtainEmailL1Proof(caller, params, vi.fn(), () => true)).rejects.toThrow(
      /destination/,
    )
  })
})
