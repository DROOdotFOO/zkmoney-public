/**
 * Two decisions the deposit gateway makes without the chain: how many of today's slots are spent,
 * read off this wallet's own salts, and what an address shown earlier still publishes once it no
 * longer re-derives.
 */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getAddress, type Hex } from "viem"
import { buildDepositIntent, deriveSelfSipaSecret, selfSipaNonce } from "@obsidion/sdk"
import type { SIPADepositRecord } from "@obsidion/front-core"
import { publishInputsFromRecord, slotFloor } from "../../../../src/features/deposit/sipaGateway"

const KEY = new Fr(0x5e1fn)
const DAY = 20662
const salt = (slot: number, key = KEY, day = DAY) =>
  deriveSelfSipaSecret(key, day, selfSipaNonce(slot)).toString()

describe("slotFloor", () => {
  it("stops at the first unused slot", () => {
    expect(slotFloor(new Set([salt(0), salt(2)]), KEY, DAY)).toBe(1)
  })
})

const SIPA = getAddress(`0x${"ab".repeat(20)}`)
const IMPL = getAddress(`0x${"11".repeat(20)}`)
const FACTORY = getAddress(`0x${"22".repeat(20)}`)
const RECOVERY = getAddress(`0x${"55".repeat(20)}`)
const USER = `0x${"0e".repeat(32)}`
const SECRET = `0x${"03".repeat(32)}`
const COMMITMENT = `0x${"44".repeat(32)}` as Hex
const INTENT = buildDepositIntent({ implementation: IMPL, recipientCommitment: COMMITMENT })
const base = {
  sipaAddress: SIPA,
  recipientL2Address: USER,
  messageSecret: SECRET,
  recipientHash: COMMITMENT,
}
const origin = { sipaFactory: FACTORY, implementation: IMPL, intentHash: INTENT.intentHash }
const record = (over: Record<string, unknown>) =>
  ({ ...base, ...over } as unknown as SIPADepositRecord)

describe("publishInputsFromRecord", () => {
  it("rebuilds a legacy-eoa address's publish inputs from its record alone", () => {
    const inputs = publishInputsFromRecord(
      record({
        origin: {
          ...origin,
          protocol: "legacy-eoa",
          rollupVersion: "7",
          resweepable: true,
          recoveryAddress: RECOVERY,
        },
      }),
    )
    expect(inputs).not.toBeNull()
    expect(inputs!.address).toBe(SIPA)
    expect(inputs!.user.toString()).toBe(USER)
    expect(inputs!.messageSecret.toString()).toBe(SECRET)
    expect(inputs!.intent).toEqual(INTENT)
    expect(inputs!.sipaArgs).toEqual({
      implementation: IMPL,
      intentHash: INTENT.intentHash,
      rollupVersion: 7n,
      resweepable: true,
      recoveryAddress: RECOVERY,
    })
    // The factory the address was derived under travels with it; a broadcast must not pair the
    // args with another one.
    expect(inputs!.candidate).toMatchObject({ protocol: "legacy-eoa", sipaFactory: FACTORY })
  })

  it("carries an account address's recovery commitment", () => {
    const commitment = `0x${"66".repeat(32)}`
    const inputs = publishInputsFromRecord(
      record({
        origin: {
          ...origin,
          protocol: "account",
          rollupVersion: "7",
          resweepable: true,
          recoveryCommitment: commitment,
          recoveryAccount: RECOVERY,
          accountFactory: FACTORY,
        },
      }),
    )
    expect(inputs!.sipaArgs).toMatchObject({ recoveryCommitment: commitment, rollupVersion: 7n })
    expect("recoveryAddress" in inputs!.sipaArgs).toBe(false)
  })

  it("has nothing to publish without the origin, or when the record's intent does not match", () => {
    expect(publishInputsFromRecord(null)).toBeNull()
    expect(publishInputsFromRecord(record({}))).toBeNull()
    const mismatched = { ...origin, intentHash: `0x${"77".repeat(32)}` }
    expect(
      publishInputsFromRecord(
        record({
          origin: {
            ...mismatched,
            protocol: "legacy-eoa",
            rollupVersion: "7",
            resweepable: false,
            recoveryAddress: RECOVERY,
          },
        }),
      ),
    ).toBeNull()
  })
})
