import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractService } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../../src/obsidion/ObsidionWallet.js"
import {
  ClaimFpcCatalogUnavailableError,
  bindClaimFpcCatalog,
  claimFpcCatalogAddresses,
  fieldToL1Address,
  identityBindingFromConfig,
  readClaimFpcIdentityCatalog,
  type ClaimFpcConfigFields,
} from "../../../src/services/claimFpc/claimFpcIdentityCatalog.js"

const CURRENT = `0x${"0b".repeat(32)}`
const RETIRED = `0x${"0a".repeat(32)}`
const OLDER = `0x${"09".repeat(32)}`

const PORTAL = `0x${"00".repeat(19)}e1`
const OTHER_PORTAL = `0x${"00".repeat(19)}e2`
const ZERO_PORTAL = `0x${"00".repeat(20)}`

const withPortal: ClaimFpcConfigFields = {
  factory_address: 0xc1n,
  implementation_address: 0xd1n,
  name_portal_address: 0xe1n,
}
/** A pre-portal class: the field is not in its struct at all. */
const withoutPortal: ClaimFpcConfigFields = {
  factory_address: 0xc2n,
  implementation_address: 0xd2n,
}

describe("fieldToL1Address", () => {
  it("keeps a full-width address", () => {
    expect(fieldToL1Address(BigInt(`0x${"c1".repeat(20)}`))).toBe(`0x${"c1".repeat(20)}`)
  })

  it("refuses a field wider than an L1 address rather than truncating it", () => {
    expect(() => fieldToL1Address(BigInt(`0x${"c1".repeat(21)}`))).toThrow(
      /wider than an L1 address/,
    )
  })
})

describe("identityBindingFromConfig", () => {
  it("takes the lent portal when the config has none", () => {
    expect(identityBindingFromConfig(RETIRED, withoutPortal, OTHER_PORTAL)).toEqual({
      fpcAddress: RETIRED,
      accountFactory: `0x${"00".repeat(19)}c2`,
      implementation: `0x${"00".repeat(19)}d2`,
      namePortal: OTHER_PORTAL,
    })
  })

  it("reads a zero portal as a value, not an absence", () => {
    const zero = { ...withoutPortal, name_portal_address: 0n }
    expect(identityBindingFromConfig(RETIRED, zero, OTHER_PORTAL).namePortal).toBe(ZERO_PORTAL)
  })

  it("refuses a config missing a factory or implementation, naming the FPC", () => {
    const noFactory = { implementation_address: 0xd1n, name_portal_address: 0xe1n }
    expect(() =>
      identityBindingFromConfig(RETIRED, noFactory as unknown as ClaimFpcConfigFields),
    ).toThrow(new RegExp(`${RETIRED}.*factory_address`))
    const noImplementation = { factory_address: 0xc1n, name_portal_address: 0xe1n }
    expect(() =>
      identityBindingFromConfig(RETIRED, noImplementation as unknown as ClaimFpcConfigFields),
    ).toThrow(new RegExp(`${RETIRED}.*implementation_address`))
  })
})

describe("bindClaimFpcCatalog", () => {
  it("leaves a retired config's own portal alone", async () => {
    const own = { ...withoutPortal, name_portal_address: 0xe2n }
    const bindings = await bindClaimFpcCatalog(CURRENT, [
      { fpcAddress: CURRENT, config: withPortal },
      { fpcAddress: RETIRED, config: own },
    ])
    expect(bindings[1]!.namePortal).toBe(OTHER_PORTAL)
  })

  it("finds the current FPC in any position and however its address is cased", async () => {
    const bindings = await bindClaimFpcCatalog(CURRENT.toUpperCase(), [
      { fpcAddress: RETIRED, config: withoutPortal },
      { fpcAddress: OLDER, config: withoutPortal },
      { fpcAddress: CURRENT, config: withPortal },
    ])
    expect(bindings.map((b) => b.namePortal)).toEqual([PORTAL, PORTAL, PORTAL])
  })

  it("never lends the current FPC a portal: a current config without one is refused", async () => {
    await expect(
      bindClaimFpcCatalog(CURRENT, [
        { fpcAddress: CURRENT, config: withoutPortal },
        { fpcAddress: RETIRED, config: withPortal },
      ]),
    ).rejects.toThrow(new RegExp(`${CURRENT}.*name_portal_address`))
  })

  it("refuses a retired config without a portal when the profile names no current FPC", async () => {
    await expect(
      bindClaimFpcCatalog(undefined, [{ fpcAddress: RETIRED, config: withoutPortal }]),
    ).rejects.toThrow(ClaimFpcCatalogUnavailableError)
  })

  it("binds a retired-only profile whose configs are complete", async () => {
    const bindings = await bindClaimFpcCatalog(undefined, [
      { fpcAddress: RETIRED, config: withPortal },
      { fpcAddress: OLDER, config: { ...withPortal, name_portal_address: 0xe2n } },
    ])
    expect(bindings.map((b) => b.namePortal)).toEqual([PORTAL, OTHER_PORTAL])
  })

  it("names the FPC whose field is wider than an address", async () => {
    const wide = { ...withPortal, name_portal_address: BigInt(`0x${"c1".repeat(21)}`) }
    await expect(
      bindClaimFpcCatalog(CURRENT, [
        { fpcAddress: CURRENT, config: withPortal },
        { fpcAddress: RETIRED, config: wide },
      ]),
    ).rejects.toThrow(new RegExp(`${RETIRED} does not answer:.*wider than an L1 address`))
  })
})

describe("readClaimFpcIdentityCatalog", () => {
  it("reports a failed artifact lookup against the FPC it was for, without waiting on the others", async () => {
    const asked: string[] = []
    const contractService = {
      getContractRecord: async () => ({
        address: AztecAddress.fromStringUnsafe(CURRENT),
        meta: { retired: [{ address: RETIRED }] },
      }),
      getArtifactForContract: (_name: string, address: AztecAddress) => {
        asked.push(address.toString())
        if (address.toString() === RETIRED)
          return Promise.reject(new Error("no artifact for this class"))
        return new Promise(() => {})
      },
    } as unknown as ContractService
    const wallet = {} as ObsidionWallet
    await expect(readClaimFpcIdentityCatalog(wallet, contractService)).rejects.toThrow(
      new RegExp(`${RETIRED} does not answer: no artifact for this class`),
    )
    expect(asked).toEqual([CURRENT, RETIRED])
    // A serialised read would hang on the pending lookup; fail fast.
  }, 5_000)
})

describe("claimFpcCatalogAddresses", () => {
  const current = AztecAddress.fromStringUnsafe(CURRENT)

  it("keeps a retired instance when the profile names no current one", () => {
    expect(claimFpcCatalogAddresses(undefined, { retired: [{ address: RETIRED }] })).toEqual([
      RETIRED,
    ])
  })

  it("names one address once when the retired list repeats the current instance", () => {
    expect(
      claimFpcCatalogAddresses(current, {
        retired: [{ address: CURRENT.toUpperCase() }, { address: RETIRED }],
      }),
    ).toEqual([CURRENT, RETIRED])
  })

  it("refuses a retired entry that names no address, because dropping it hides an account", () => {
    expect(() => claimFpcCatalogAddresses(current, { retired: [{}] })).toThrow(
      ClaimFpcCatalogUnavailableError,
    )
  })

  it("refuses a retired entry whose address is not a well-formed address", () => {
    expect(() => claimFpcCatalogAddresses(current, { retired: [{ address: 7 }] })).toThrow(
      ClaimFpcCatalogUnavailableError,
    )
    expect(() => claimFpcCatalogAddresses(current, { retired: [{ address: "0xabc" }] })).toThrow(
      ClaimFpcCatalogUnavailableError,
    )
  })

  it("refuses a retired list that is not a list, rather than reading it as none", () => {
    expect(() => claimFpcCatalogAddresses(current, { retired: "not-a-list" })).toThrow(
      ClaimFpcCatalogUnavailableError,
    )
  })

  it("refuses a profile that publishes no ClaimFPC at all, rather than reporting none", () => {
    expect(() => claimFpcCatalogAddresses(undefined, undefined)).toThrow(
      ClaimFpcCatalogUnavailableError,
    )
    expect(() => claimFpcCatalogAddresses(undefined, {})).toThrow(ClaimFpcCatalogUnavailableError)
    expect(() => claimFpcCatalogAddresses(undefined, { retired: [] })).toThrow(
      ClaimFpcCatalogUnavailableError,
    )
  })

  it("is the current instance alone when the profile publishes no retired list", () => {
    expect(claimFpcCatalogAddresses(current, undefined)).toEqual([CURRENT])
    expect(claimFpcCatalogAddresses(current, {})).toEqual([CURRENT])
  })

  it("refuses a good entry beside a malformed one, so no generation is quietly lost", () => {
    expect(() =>
      claimFpcCatalogAddresses(current, { retired: [{ address: RETIRED }, { address: null }] }),
    ).toThrow(ClaimFpcCatalogUnavailableError)
  })
})
