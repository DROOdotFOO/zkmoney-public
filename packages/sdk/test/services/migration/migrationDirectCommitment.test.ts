import { expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { concat, keccak256, toHex, type Address, type PublicClient } from "viem"
import { SipaSelfResolver } from "../../../src/services/sipa/sipaSelfResolve.js"
import { deriveSelfSipaSecret } from "../../../src/services/sipa/sipaStealth.js"
import {
  directAnnouncementIntentHash,
  migrationDirectAnnouncementCalls,
  migrationDirectCommitment,
  resolveMigrationDeposit,
  type MigrationDestinationContext,
} from "../../../src/services/migration/migrationDeposit.js"

const selfSipaKey = new Fr(789n)

function context() {
  const readContract = vi.fn(async (request: { functionName: string }) =>
    request.functionName === "predictSIPA" ? `0x${"22".repeat(20)}` : `0x${"11".repeat(20)}`,
  )
  const c = {
    client: { readContract } as unknown as PublicClient,
    selfResolver: new SipaSelfResolver({ stealthScalar: 123n, selfSipaKey }),
    recipient: AztecAddress.fromBigIntUnsafe(10n),
    recoveryAccount: `0x${"33".repeat(20)}` as Address,
    destination: {
      factory: `0x${"44".repeat(20)}`,
      forwardingTable: `0x${"55".repeat(20)}`,
      rollupVersion: 7n,
    },
  } as unknown as MigrationDestinationContext
  return { c, readContract }
}

it("is the recipient commitment of the DepositSIPA at the same coordinates, with its shared secret", async () => {
  const { c, readContract } = context()
  const direct = await migrationDirectCommitment(c, 20_000, 300_001)
  expect(readContract).not.toHaveBeenCalled()

  const sipa = await resolveMigrationDeposit(c, 20_000, 300_001)
  expect(direct.recipientCommitment).toBe(sipa.resolution.recipientHash.toString())
  expect(direct.sharedSecret).toBe(sipa.resolution.messageSecret.toBigInt())
  expect(direct.sharedSecret).toBe(deriveSelfSipaSecret(selfSipaKey, 20_000, 300_001).toBigInt())
})

it("marks a direct announcement with a domain-separated hash of the 32-byte commitment", () => {
  const commitment = `0x${"ab".repeat(32)}` as const
  const marker = keccak256(concat([keccak256(toHex("oxide.direct-migration")), commitment]))
  expect(directAnnouncementIntentHash(commitment)).toBe(marker)
  expect(directAnnouncementIntentHash(commitment.toUpperCase().replace("0X", "0x") as never)).toBe(
    marker,
  )
  // Never an ordinary deposit SIPA's intent hash, keccak256(abi.encode(bytes32 c)).
  expect(marker).not.toBe(keccak256(commitment))
  expect(() => directAnnouncementIntentHash("0xabcd")).toThrow("32 bytes")
})

it("announces a direct deposit with its shared secret, not resweepable, under the marker", async () => {
  const { c } = context()
  const notify = vi.fn<(...args: unknown[]) => { request: () => Promise<{ calls: unknown[] }> }>(
    () => ({ request: async () => ({ calls: [{ name: "notify_sipa_recipient" }] }) }),
  )
  const token = { methods: { notify_sipa_recipient: notify } }
  const direct = await migrationDirectCommitment(c, 20_000, 300_001)

  const calls = await migrationDirectAnnouncementCalls(
    { ...c, token } as never,
    20_000,
    300_001,
    direct.recipientCommitment,
  )
  expect(calls).toEqual([{ name: "notify_sipa_recipient" }])
  const [recipient, salt, resweepable, hi, lo] = notify.mock.calls[0]! as [
    AztecAddress,
    Fr,
    boolean,
    bigint,
    bigint,
  ]
  expect(recipient.equals(c.recipient)).toBe(true)
  expect(salt.toBigInt()).toBe(direct.sharedSecret)
  expect(resweepable).toBe(false)
  // The rail's check: the salt derives the commitment, and the intent hash is its marker.
  const marker = (hi << 128n) | lo
  expect(`0x${marker.toString(16).padStart(64, "0")}`).toBe(
    directAnnouncementIntentHash(direct.recipientCommitment),
  )

  await expect(
    migrationDirectAnnouncementCalls(
      { ...c, token } as never,
      20_000,
      300_002,
      direct.recipientCommitment,
    ),
  ).rejects.toThrow("does not match its coordinates")
})
