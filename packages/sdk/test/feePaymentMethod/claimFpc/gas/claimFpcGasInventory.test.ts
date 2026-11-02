/**
 * The ClaimFPC gas inventory, from every end it has to satisfy.
 *
 * Derivation check: `deriveClaimFpcGasBudgets` carries its own cross-checks and throws on any of:
 * `CLAIM_FPC_OVERHEAD_GAS` disagreeing with the kernel's metering constants or the measured table; a
 * fixed-shape model (authorize_intents, the registration gate, the SIPA notify, the publish_da
 * chunking) not reproducing its measured marginal to the gas; a worst-case spend budget failing to
 * cover its measured shape. Fails when an aztec bump moves the metering constants, when Noir and TS drift
 * apart, or when the checked-in gas table goes stale — the fix is updating the model / re-measuring
 * (CLAIMFPC_GAS_REPORT=1, sdk fpc suites), never editing numbers. The ladder case pins the modeled
 * spend recursion against the vendored oxide token source so a bumped pin that moves the ladder
 * fails here.
 *
 * Declared-limits check: what a sponsored send declares (`claimFpcSponsoredFee`) has to cover
 * every measured tx of its shape and still fit the ceiling the deploy priced from the same numbers
 * — under both policy shapes, since the deployed policy is what picks the declaration. Sandbox fees
 * are ~200,000x below testnet's, so no sandbox suite can catch a declared limit that overshoots a
 * policy ceiling; that arithmetic is pinned here instead.
 *
 * Cap-sizing check: the flat caps the shipped open policy runs on must cover every measured
 * shape AND every per-call inventory sum, which is what makes them a safe declaration for any batch
 * the product actually sends.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { claimFpcGateGas, claimFpcOverheadGas, claimFpcRefuelGas } from "@obsidion/contracts"
import { CLAIM_FPC_MAX_FEE_PER_GAS } from "@obsidion/core/constants"
import {
  CLAIM_FPC_BATCH_CAPS,
  claimFpcBatchGas,
  claimFpcCallGas,
  claimFpcGateMarginal,
  claimFpcSponsoredFee,
} from "../../../../src/feePaymentMethod/claimFpc/gas/claimFpcBatchGas.js"
import { claimFpcRefuelFee } from "../../../../src/feePaymentMethod/claimFpc/claimFpcRefuel.js"
import { deriveClaimFpcGasBudgets } from "../../../../src/feePaymentMethod/claimFpc/gas/claimFpcGasBudgets.js"
import {
  SPEND_LADDER,
  authorizeIntentsEffects,
  privateSideEffectGas,
} from "../../../../src/feePaymentMethod/claimFpc/gas/claimFpcGasModel.js"
import { CLAIM_FPC_GAS_TABLE } from "../../../../src/feePaymentMethod/claimFpc/gas/claimFpcGasTable.js"
import {
  KIND_BY_ADDRESS,
  KIND_BY_ANY,
  buildClaimFpcPolicy,
} from "../../../../src/feePaymentMethod/claimFpc/claimSponsoredCall.js"
import { flavorCalls } from "../../../utils/claimFpc/claimFpcShapes.js"

const OXIDE_TOKEN_MAIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../vendor/oxide/noir-projects/oxide_token_contract/src/main.nr",
)

const CONFIG_FEE_PER_GAS = CLAIM_FPC_MAX_FEE_PER_GAS
/** Testnet, 2026-08-06: worst predicted min fee 2.233e12 x the base wallet's 1.5 padding. */
const TESTNET_DECLARED_FEE_PER_L2_GAS = 3349589516130n

/** The calls a measured table key carries — the shared shape parser (email-claim aware). */
const callsOf = flavorCalls

/** What the circuit compares: declared limits priced at the tx's fee-per-gas. */
function maxPossibleFee(
  gas: { daGas: number; l2Gas: number },
  feePerDaGas: bigint,
  feePerL2Gas: bigint,
): bigint {
  return BigInt(gas.daGas) * feePerDaGas + BigInt(gas.l2Gas) * feePerL2Gas
}

/** The shipped policy: one `ByAny` leaf budgeted at the caps, priced as the deploy prices it. */
const BY_ANY_BUDGET = maxPossibleFee(CLAIM_FPC_BATCH_CAPS, CONFIG_FEE_PER_GAS, CONFIG_FEE_PER_GAS)
const openPolicy = () =>
  buildClaimFpcPolicy([
    { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: BY_ANY_BUDGET },
  ])
/** A per-call policy — its entries' targets are irrelevant to which GAS a client declares. */
const perCallPolicy = () =>
  buildClaimFpcPolicy([
    { kind: KIND_BY_ADDRESS, target: new Fr(0x101n), selector: new Fr(0x202n), max_fee: 1n },
  ])

/** Bracketed keys are sponsored-batch shapes; `refuel` is the FPC's own entrypoint tx. */
const batchFlavors = Object.entries(CLAIM_FPC_GAS_TABLE).filter(([key]) => key.includes("["))

describe("ClaimFPC gas derivation", () => {
  it("charges a name-claim subscribe the overhead plus that gate's own reported gas", () => {
    // A gate is its own circuit, and gas is metered on side effects: the NameClaim gate emits
    // none. The only shape the shipped deployment sends through it is the strict rail's
    // registration publish, and a `sponsor` carrying the same lone publish differs from it by
    // exactly the gate — nothing — measured on chain instead of read off the artifact.
    const gate = claimFpcGateGas("nameClaim")
    expect(gate).toEqual({ daGas: 0, l2Gas: 0 })

    const publish = "oxide_token.notify_sipa_recipient,broadcaster.broadcast_l1_operation_2k"
    const strict = CLAIM_FPC_GAS_TABLE[`subscribe[nameClaim,${publish}]`]!
    const bare = CLAIM_FPC_GAS_TABLE[`sponsor[${publish}]`]!
    expect({ daGas: strict.daGas - bare.daGas, l2Gas: strict.l2Gas - bare.l2Gas }).toEqual(gate)
  })

  it("charges a registration subscribe the overhead alone: the gate emits nothing", () => {
    // The registration gate proves the L1->L2 message exists without consuming it, so like the
    // NameClaim gate it emits no side effect and reports zero.
    const gate = claimFpcGateGas("registration")
    expect(gate).toEqual({ daGas: 0, l2Gas: 0 })
    expect(gate).toEqual(claimFpcGateMarginal("registration"))

    const { base } = deriveClaimFpcGasBudgets()
    const mAuth = privateSideEffectGas(authorizeIntentsEffects())
    const measured = CLAIM_FPC_GAS_TABLE["subscribe[registration,authorize_intents]"]!
    expect({
      daGas: measured.daGas - mAuth.daGas,
      l2Gas: measured.l2Gas - mAuth.l2Gas,
    }).toEqual({ daGas: base.daGas + gate.daGas, l2Gas: base.l2Gas + gate.l2Gas })
  })

  it("adds the gate's cost to what a registration subscribe declares", () => {
    const { base, mAuth } = deriveClaimFpcGasBudgets()
    const gate = claimFpcGateMarginal("registration")!
    expect(claimFpcBatchGas(callsOf("subscribe[registration,authorize_intents]"))).toEqual({
      daGas: base.daGas + gate.daGas + mAuth.daGas,
      l2Gas: base.l2Gas + gate.l2Gas + mAuth.l2Gas,
    })
    // A gate name is not a sponsorable call: only a subscribe's leading leg may carry one.
    expect(() => claimFpcCallGas({ name: "registration" })).toThrow(/no per-call gas budget/)
  })

  it("prices a rail without a gate at nothing", () => {
    // A rail entered by gift refuses every subscribe before any gate runs, so nothing is ever
    // priced through it; the artifact reader and the client mirror both say zero.
    expect(claimFpcGateGas("none")).toEqual({ daGas: 0, l2Gas: 0 })
    expect(claimFpcGateMarginal("none")).toEqual({ daGas: 0, l2Gas: 0 })
  })

  it("accepts the compiled contract's overhead and rejects a drifted one", () => {
    expect(() => deriveClaimFpcGasBudgets(claimFpcOverheadGas())).not.toThrow()
    const drifted = { ...claimFpcOverheadGas(), l2Gas: claimFpcOverheadGas().l2Gas + 100 }
    expect(() => deriveClaimFpcGasBudgets(drifted)).toThrow(/overhead gas drift/)
  })

  it("mirrors the vendored oxide token's spend ladder", () => {
    const src = readFileSync(OXIDE_TOKEN_MAIN, "utf8")
    const noirGlobal = (name: string): number => {
      const match = new RegExp(`global ${name}: u32 = (\\d+);`).exec(src)
      if (!match) throw new Error(`global ${name} not found in ${OXIDE_TOKEN_MAIN}`)
      return Number(match[1])
    }
    expect(SPEND_LADDER.initialNotes).toBe(noirGlobal("INITIAL_TRANSFER_CALL_MAX_NOTES"))
    expect(SPEND_LADDER.recursiveNotes).toBe(noirGlobal("RECURSIVE_TRANSFER_CALL_MAX_NOTES"))
    expect(SPEND_LADDER.initialDeposits).toBe(noirGlobal("INITIAL_TRANSFER_CALL_MAX_DEPOSITS"))
    expect(SPEND_LADDER.recursiveDeposits).toBe(noirGlobal("RECURSIVE_TRANSFER_CALL_MAX_DEPOSITS"))
  })
})

describe("ClaimFPC per-call inventory", () => {
  it("prices every per-call-budgeted call and refuses the rest", () => {
    const budgets = deriveClaimFpcGasBudgets()
    expect(claimFpcCallGas({ name: "authorize_intents" })).toEqual(budgets.mAuth)
    expect(claimFpcCallGas({ name: "notify_sipa_recipient" })).toEqual(budgets.mSipaNotify)
    expect(claimFpcCallGas({ name: "announce" })).toEqual(budgets.mLinkAnnounce)
    expect(claimFpcCallGas({ name: "broadcast_l1_operation_2k" })).toEqual(budgets.mL1Operation)
    expect(claimFpcCallGas({ name: "broadcast_l1_operation_4k" })).toEqual(budgets.mL1Operation4k)
    expect(claimFpcCallGas({ name: "broadcast_l1_operation_pair_2k" })).toEqual(
      budgets.mL1OperationPair,
    )
    expect(claimFpcCallGas({ name: "gift_voucher" })).toEqual(budgets.mGift)
    expect(claimFpcCallGas({ name: "transfer" })).toEqual(budgets.mTransfer)
    expect(claimFpcCallGas({ name: "withdraw" })).toEqual(budgets.mWithdraw)
    expect(claimFpcCallGas({ name: "deposit" })).toEqual(budgets.mPaylinkDeposit)
    expect(claimFpcCallGas({ name: "claim" })).toEqual(budgets.mPaylinkClaim)
    expect(claimFpcCallGas({ name: "refund" })).toEqual(budgets.mPaylinkClaim)
    expect(claimFpcCallGas({ name: "claim_to_l1" })).toEqual(budgets.mPaylinkClaimToL1)
    // Proof-bearing exits include the email registry's public validation.
    expect(claimFpcCallGas({ name: "claim_to_l1", args: new Array(573) })).toEqual(
      budgets.mPaylinkEmailClaimToL1,
    )
    // The email claim shares the name; the zkJWT vkey+proof in its args is the discriminator.
    expect(claimFpcCallGas({ name: "claim", args: new Array(573) })).toEqual(
      budgets.mPaylinkEmailClaim,
    )
    expect(budgets.mPaylinkEmailClaim.l2Gas).toBeGreaterThan(budgets.mPaylinkClaim.l2Gas)
    expect(claimFpcCallGas({ name: "publish_da" })).toEqual(budgets.mPublishDa)
    expect(() => claimFpcCallGas({ name: "mint_to_private" })).toThrow(/no per-call gas budget/)
  })

  it("charges the entrypoint overhead once per batch", () => {
    const { base, mAuth, mSipaNotify, mL1Operation } = deriveClaimFpcGasBudgets()
    expect(claimFpcBatchGas([])).toEqual(base)
    const sipaPublish = [{ name: "notify_sipa_recipient" }, { name: "broadcast_l1_operation_2k" }]
    expect(claimFpcBatchGas([{ name: "authorize_intents" }, ...sipaPublish])).toEqual({
      daGas: base.daGas + mAuth.daGas + mSipaNotify.daGas + mL1Operation.daGas,
      l2Gas: base.l2Gas + mAuth.l2Gas + mSipaNotify.l2Gas + mL1Operation.l2Gas,
    })
  })

  it("declares limits that cover every measured sponsored batch and fit its ceiling", async () => {
    const policy = await perCallPolicy()
    expect(batchFlavors.length).toBe(Object.keys(CLAIM_FPC_GAS_TABLE).length - 1)
    for (const [tableKey, measured] of batchFlavors) {
      const { gasSettings } = claimFpcSponsoredFee(policy, callsOf(tableKey))
      // The assert sums both limits, and no sponsorable call registers a public teardown function.
      expect(gasSettings.teardownGasLimits.l2Gas, tableKey).toBe(0)
      const declared = {
        daGas: gasSettings.gasLimits.daGas + gasSettings.teardownGasLimits.daGas,
        l2Gas: gasSettings.gasLimits.l2Gas + gasSettings.teardownGasLimits.l2Gas,
      }

      // Execution: the tx must fit inside what it declared.
      expect(declared.daGas, `${tableKey} daGas`).toBeGreaterThanOrEqual(measured.daGas)
      expect(declared.l2Gas, `${tableKey} l2Gas`).toBeGreaterThanOrEqual(measured.l2Gas)

      // Sponsorship: the batch's ceiling is these same numbers at the config's price, so the assert
      // holds exactly while the tx declares no more per gas than the FPC sponsors at.
      const ceiling = maxPossibleFee(declared, CONFIG_FEE_PER_GAS, CONFIG_FEE_PER_GAS)
      expect(
        maxPossibleFee(declared, 0n, TESTNET_DECLARED_FEE_PER_L2_GAS),
        `${tableKey} at testnet fees`,
      ).toBeLessThanOrEqual(ceiling)
    }
  })
})

/**
 * Shapes the sdk sends only on a rail whose policy sponsors any call. Their worst-case per-call
 * inventory sums above the caps, so `claimSponsoredPaylink` refuses them on a per-call policy
 * (`ClaimBatchFullError`) and the wallet sends the broadcast and the claim apart.
 */
const OPEN_POLICY_ONLY = new Set([
  "sponsor[paylink_direct.claim_with_withdrawal,oxide_token.notify_sipa_recipient,broadcaster.broadcast_l1_operation_2k,broadcaster.broadcast_l1_operation_2k,oxide_token.publish_da]",
])

describe("ClaimFPC flat batch caps", () => {
  it("declares the caps for any batch an open policy sponsors", async () => {
    const policy = await openPolicy()
    // Shape-independent by construction: an open policy has no per-call inventory to consult, and
    // the calls below are not even in one.
    for (const calls of [[], [{ name: "mint_to_private" }, { name: "some_third_party_call" }]]) {
      const { gasSettings } = claimFpcSponsoredFee(policy, calls)
      expect(gasSettings.teardownGasLimits.l2Gas).toBe(0)
      expect({ daGas: gasSettings.gasLimits.daGas, l2Gas: gasSettings.gasLimits.l2Gas }).toEqual(
        CLAIM_FPC_BATCH_CAPS,
      )
    }
  })

  it("covers every measured shape and every per-call inventory sum", () => {
    for (const [tableKey, measured] of batchFlavors) {
      expect(CLAIM_FPC_BATCH_CAPS.daGas, `${tableKey} daGas`).toBeGreaterThanOrEqual(measured.daGas)
      expect(CLAIM_FPC_BATCH_CAPS.l2Gas, `${tableKey} l2Gas`).toBeGreaterThanOrEqual(measured.l2Gas)
      // A per-call policy is never asked for these: the sdk splits them into shapes covered here.
      if (OPEN_POLICY_ONLY.has(tableKey)) continue
      // The worst-case per-call budgets sit above their measured shapes, so covering them is the
      // stronger statement: a per-call policy could be swapped in without moving the caps.
      const inventory = claimFpcBatchGas(callsOf(tableKey))
      expect(CLAIM_FPC_BATCH_CAPS.daGas, `${tableKey} inventory daGas`).toBeGreaterThanOrEqual(
        inventory.daGas,
      )
      expect(CLAIM_FPC_BATCH_CAPS.l2Gas, `${tableKey} inventory l2Gas`).toBeGreaterThanOrEqual(
        inventory.l2Gas,
      )
    }
  })

  it("leaves fee headroom the defaults would spend", () => {
    // The circuit's cap for an open batch: the entrypoint overhead plus the ByAny budget, both at
    // the config's price. Why declare at all — left to default, the gas-estimation simulation
    // declares three times MAX_PROCESSABLE_L2_GAS (GasSettings.forEstimation), already past the
    // ceiling, and a real send the network's per-tx admission limit, which leaves under 1.5x fee
    // headroom at today's testnet fee. Declaring the caps keeps 3x.
    // Numbers are testnet's (txsLimits.gas l2 6_540_000).
    const ceiling =
      maxPossibleFee(claimFpcOverheadGas(), CONFIG_FEE_PER_GAS, CONFIG_FEE_PER_GAS) + BY_ANY_BUDGET
    const atTestnetFees = (l2Gas: number) =>
      maxPossibleFee({ daGas: 0, l2Gas }, 0n, TESTNET_DECLARED_FEE_PER_L2_GAS)

    expect(atTestnetFees(CLAIM_FPC_BATCH_CAPS.l2Gas) * 3n).toBeLessThanOrEqual(ceiling)
    expect(
      maxPossibleFee(CLAIM_FPC_BATCH_CAPS, CONFIG_FEE_PER_GAS, CONFIG_FEE_PER_GAS),
    ).toBeLessThanOrEqual(ceiling)
    expect(atTestnetFees(3 * 6_540_000)).toBeGreaterThan(ceiling)
    expect((atTestnetFees(6_540_000) * 3n) / 2n).toBeGreaterThan(ceiling)
  })
})

describe("ClaimFPC refuel", () => {
  it("pins refuel's declared limits to the artifact global and the measured table", () => {
    // refuel is the FPC's own entrypoint tx (fixed shape), so declared == artifact == measured
    // exactly; claimFpcRefuelFee declares the table entry, and the sandbox e2e pins the live send.
    const measured = CLAIM_FPC_GAS_TABLE["refuel"]!
    expect(claimFpcRefuelGas()).toEqual({ daGas: measured.daGas, l2Gas: measured.l2Gas })
    const { gasSettings } = claimFpcRefuelFee()
    expect(gasSettings.teardownGasLimits.l2Gas).toBe(0)
    expect({ daGas: gasSettings.gasLimits.daGas, l2Gas: gasSettings.gasLimits.l2Gas }).toEqual(
      claimFpcRefuelGas(),
    )
  })
})
