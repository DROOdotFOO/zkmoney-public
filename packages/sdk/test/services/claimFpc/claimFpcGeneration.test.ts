/**
 * ClaimFPC selection across oxide deployment generations. A balance on a retired generation can only
 * be spent through the ClaimFPC that generation named: that FPC's immutable Config pins the L1
 * NamePortal its registration gate consumes, and the FPC's own address is part of the message leaf
 * the gate looks for. Selecting any other instance produces a message search that can never hit.
 *
 * The manifests here carry the shape a real deploy publishes — every rail whitelists BY_ANY — so
 * nothing about a generation can be inferred from its policy entries.
 */

import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractService } from "@obsidion/contracts"
import { loadClaimFpcPolicyAt } from "../../../src/services/claimFpc/claimSponsor.js"

const V7_FPC = "0x13cf2c5af6b3eeacbea9b6db3b751280944a53681ebf4c5670a8d579e518d919"
const V6_FPC = "0x0e5d295ee75c8891732e882935fb11c616e21d74e6e0505f7de956cee0ca236a"
const V3_FPC = "0x269eaa98b4ac39a0cc57bdf8229b83d7e89184de42aef0edbac5d560a55f2eb9"

const ZERO = `0x${"00".repeat(32)}`
const BY_ANY_ROOT = "0x132c3179e1b98a786a84be2824a607a50271804d108870905f64b3e80fb5e141"

const byAnyRail = (name: string, gate: string) => ({
  name,
  gate,
  policy: {
    root: BY_ANY_ROOT,
    entries: [{ kind: 4, target: ZERO, selector: ZERO, maxFee: "20160000000000000000" }],
  },
})

const manifest = () => ({
  version: 2,
  depth: 6,
  rails: [
    byAnyRail("registration-broadcast", "nameClaim"),
    byAnyRail("registered", "registration"),
    byAnyRail("voucher", "none"),
  ],
})

function stubService(current: string, retired: string[]): ContractService {
  return {
    getContractRecord: async () => ({
      address: AztecAddress.fromStringUnsafe(current),
      meta: {
        policyManifest: manifest(),
        retired: retired.map((address) => ({ address, policyManifest: manifest() })),
      },
    }),
  } as unknown as ContractService
}

const staging = () => stubService(V7_FPC, [V3_FPC, V6_FPC])

describe("loadClaimFpcPolicyAt", () => {
  it.each([
    ["a retired generation", V6_FPC, V6_FPC],
    ["any spelling of its case", V6_FPC.toUpperCase().replace("0X", "0x"), V6_FPC],
    ["the current instance", V7_FPC, V7_FPC],
  ])("selects the ClaimFPC the caller names: %s", async (_, named, expected) => {
    const { rail, fpcAddress } = await loadClaimFpcPolicyAt(staging(), "registered", named)
    expect(fpcAddress?.toString()).toBe(expected)
    expect(rail.gate).toBe("registration")
  })

  it("refuses a retired generation the profile dropped", async () => {
    const withoutV6 = stubService(V7_FPC, [V3_FPC])
    await expect(loadClaimFpcPolicyAt(withoutV6, "registered", V6_FPC)).rejects.toThrow(
      /publishes no ClaimFPC at/,
    )
  })
})
