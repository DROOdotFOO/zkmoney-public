import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec-labs/stdlib/abi"
import { describe, expect, it } from "vitest"
import type { ContractService } from "@obsidion/contracts"

import {
  CLAIM_FPC_POLICY_DEPTH,
  CLAIM_FPC_POLICY_LEAVES,
  KIND_BY_ADDRESS,
  KIND_BY_CLASS,
  KIND_BY_SELF,
  KIND_BY_ANY,
  buildClaimFpcPolicy,
  claimFpcPolicyMerkleProofsForCalls,
  claimFpcPolicySponsorsAnyCall,
  claimFpcPolicyMerkleRoot,
  parseClaimFpcPolicyManifest,
  railByName,
  serializeClaimFpcPolicyManifest,
} from "../../../src/feePaymentMethod/claimFpc/claimSponsoredCall.js"
import { loadClaimFpcPolicy } from "../../../src/services/claimFpc/claimSponsor.js"
import { buildSponsoredCallBatch } from "../../../src/feePaymentMethod/claimFpc/sponsoredCall.js"

const entries = [
  { kind: KIND_BY_ADDRESS, target: new Fr(0x101n), selector: new Fr(0x201n), max_fee: 11n },
  { kind: KIND_BY_CLASS, target: new Fr(0x102n), selector: new Fr(0x202n), max_fee: 12n },
  { kind: KIND_BY_SELF, target: Fr.ZERO, selector: new Fr(0x203n), max_fee: 13n },
]

/** A narrow rail beside an open one, as a client reads a manifest back. */
const STRICT_ENTRIES = [entries[0]!]
const OPEN_ENTRIES = [{ kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 99n }]

async function twoRailManifest() {
  return serializeClaimFpcPolicyManifest([
    {
      name: "registration-broadcast",
      gate: "nameClaim",
      policy: await buildClaimFpcPolicy(STRICT_ENTRIES),
    },
    { name: "registered", gate: "nameClaim", policy: await buildClaimFpcPolicy(OPEN_ENTRIES) },
  ])
}

async function expectedRails() {
  return [
    {
      railId: 0,
      name: "registration-broadcast",
      gate: "nameClaim",
      policy: await buildClaimFpcPolicy(STRICT_ENTRIES),
    },
    {
      railId: 1,
      name: "registered",
      gate: "nameClaim",
      policy: await buildClaimFpcPolicy(OPEN_ENTRIES),
    },
  ]
}

function call(to: Fr, selector: Fr, type = FunctionType.PRIVATE): FunctionCall {
  return FunctionCall.from({
    name: "test",
    to: AztecAddress.fromFieldUnsafe(to),
    selector: FunctionSelector.fromField(selector),
    type,
    isStatic: false,
    hideMsgSender: false,
    args: [],
  })
}

describe("ClaimFPC Merkle policy", () => {
  it("commits every entry into a fixed 64-leaf tree", async () => {
    const policy = await buildClaimFpcPolicy(entries)

    expect(CLAIM_FPC_POLICY_DEPTH).toBe(6)
    expect(CLAIM_FPC_POLICY_LEAVES).toBe(64)
    expect(policy.witnesses.map(({ entry }) => entry)).toEqual(entries)

    for (let index = 0; index < entries.length; index++) {
      const witness = policy.witnesses[index]!
      expect(witness.leaf_index).toBe(index)
      expect(witness.sibling_path).toHaveLength(CLAIM_FPC_POLICY_DEPTH)
      expect(await claimFpcPolicyMerkleRoot(witness)).toEqual(policy.root)
    }
  })

  it("hashes leaf 1 to the literals the Noir policy test pins", async () => {
    // The other half of the pair is `policy_root_matches_typescript_builder` in
    // claim_fpc/src/config.nr, which hardcodes this same leaf-1 vector.
    const witness = (await buildClaimFpcPolicy(entries)).witnesses[1]!

    expect(witness.leaf_index).toBe(1)
    expect(witness.sibling_path.map((sibling) => sibling.toString())).toEqual([
      "0x257857454af9dde5f54aa0307948d0d1d6f41c92cee16c7a8599979d5b0abe8c",
      "0x2de03ff10a62c8347db7e10667b34a35aebd608f98ebf46ba191bb15c4b0aaea",
      "0x01a8d53d1fa97e760f19ea8385a777d2660b3615412ce4c381cfd562a89b7889",
      "0x04f2429580a6148ef625520387e38373d6e7e09380f5ca9ce73288ab98e05b45",
      "0x17645d95165a7995e5ad1c0771d685fa8f2575e20c6fcfc7729628b44e0e2682",
      "0x1e6930d6c22422844f4a3988a2f8744e5179efdc4e13e5acb82cf4c5a16d2c41",
    ])
    expect((await claimFpcPolicyMerkleRoot(witness)).toString()).toBe(
      "0x137155a814cbe1b4698468c4f8df80a01e5788e2f7ffa6f0fec1d7b8978f1fdd",
    )
  })

  it("round-trips every rail with its own root, keyed by declaration order", async () => {
    const manifest = await twoRailManifest()

    expect(manifest.version).toBe(2)
    expect(manifest.rails.map((rail) => rail.name)).toEqual([
      "registration-broadcast",
      "registered",
    ])
    // One root per rail, and they differ — a rail's policy binds only its own batches.
    expect(manifest.rails[0]!.policy.root).not.toBe(manifest.rails[1]!.policy.root)
    await expect(parseClaimFpcPolicyManifest(manifest)).resolves.toEqual(await expectedRails())
  })

  it("refuses a rail whose entries do not reproduce its declared root", async () => {
    const manifest = await twoRailManifest()
    const tampered = {
      ...manifest,
      rails: [
        manifest.rails[0]!,
        {
          ...manifest.rails[1]!,
          policy: { ...manifest.rails[1]!.policy, root: new Fr(0xbadn).toString() },
        },
      ],
    }
    await expect(parseClaimFpcPolicyManifest(tampered)).rejects.toThrow("root mismatch")
  })

  it("rejects missing, incompatible, and malformed public manifests", async () => {
    const manifest = await twoRailManifest()

    await expect(parseClaimFpcPolicyManifest(undefined)).rejects.toThrow("missing")
    // Version 1 is the single-policy shape: it names no rails, so nothing can declare one.
    await expect(parseClaimFpcPolicyManifest({ ...manifest, version: 1 })).rejects.toThrow(
      "version",
    )
    await expect(parseClaimFpcPolicyManifest({ ...manifest, depth: 5 })).rejects.toThrow("depth")
    await expect(parseClaimFpcPolicyManifest({ ...manifest, rails: [] })).rejects.toThrow(
      "no rails",
    )
    await expect(
      parseClaimFpcPolicyManifest({
        ...manifest,
        rails: [manifest.rails[0]!, { ...manifest.rails[1]!, name: manifest.rails[0]!.name }],
      }),
    ).rejects.toThrow("duplicate")
    await expect(
      parseClaimFpcPolicyManifest({
        ...manifest,
        rails: [{ ...manifest.rails[0]!, gate: "someGateThisSdkCannotBuild" }],
      }),
    ).rejects.toThrow("witnesses for")
    await expect(
      parseClaimFpcPolicyManifest({
        ...manifest,
        rails: [
          {
            ...manifest.rails[0]!,
            policy: {
              ...manifest.rails[0]!.policy,
              entries: [{ ...manifest.rails[0]!.policy.entries[0]!, maxFee: "not-a-number" }],
            },
          },
        ],
      }),
    ).rejects.toThrow("invalid")
  })

  it("resolves a declared rail name to its id and refuses an undeclared one", async () => {
    const rails = await parseClaimFpcPolicyManifest(await twoRailManifest())

    expect(railByName(rails, "registration-broadcast").railId).toBe(0)
    expect(railByName(rails, "registered").railId).toBe(1)
    expect(railByName(rails, "registered").policy.root).toEqual(
      (await buildClaimFpcPolicy(OPEN_ENTRIES)).root,
    )
    expect(() => railByName(rails, "no-such-rail")).toThrow("no rail named")
  })

  it("evicts rejected cached manifests so a corrected registry object can be retried", async () => {
    const fpcAddress = AztecAddress.fromFieldUnsafe(new Fr(0xf0cn))
    const validManifest = await twoRailManifest()
    const mutableManifest = {
      ...validManifest,
      rails: [
        {
          ...validManifest.rails[0]!,
          policy: { ...validManifest.rails[0]!.policy, root: new Fr(0xbadn).toString() },
        },
        validManifest.rails[1]!,
      ],
    }
    const contractService = {
      getContractRecord: async () => ({
        meta: { policyManifest: mutableManifest },
        address: fpcAddress,
      }),
    } as unknown as ContractService

    await expect(loadClaimFpcPolicy(contractService, "registered")).rejects.toThrow("root mismatch")
    mutableManifest.rails[0]!.policy.root = validManifest.rails[0]!.policy.root
    await expect(loadClaimFpcPolicy(contractService, "registered")).resolves.toEqual({
      rail: (await expectedRails())[1],
      fpcAddress,
    })
  })

  it("changes the root when any policy field changes", async () => {
    const base = await buildClaimFpcPolicy(entries)

    for (const changed of [
      { ...entries[0]!, kind: KIND_BY_CLASS },
      { ...entries[0]!, target: new Fr(0x999n) },
      { ...entries[0]!, selector: new Fr(0x999n) },
      { ...entries[0]!, max_fee: 999n },
    ]) {
      const policy = await buildClaimFpcPolicy([changed, ...entries.slice(1)])
      expect(policy.root).not.toEqual(base.root)
    }
  })

  it("selects address, class, and self leaves for a batch and rejects unknown calls", async () => {
    const policy = await buildClaimFpcPolicy(entries)
    const fpcAddress = AztecAddress.fromFieldUnsafe(new Fr(0xf0cn))
    const witnesses = claimFpcPolicyMerkleProofsForCalls(
      policy,
      [
        call(entries[0]!.target, entries[0]!.selector),
        call(new Fr(0x777n), entries[1]!.selector),
        call(fpcAddress.toField(), entries[2]!.selector),
      ],
      [undefined, { classId: entries[1]!.target } as never, undefined],
      fpcAddress,
    )

    expect(witnesses).toHaveLength(5)
    expect(witnesses.slice(0, 3).map((witness) => witness.leaf_index)).toEqual([0, 1, 2])
    expect(witnesses.slice(3)).toEqual([policy.emptyWitness, policy.emptyWitness])

    expect(() =>
      claimFpcPolicyMerkleProofsForCalls(
        policy,
        [call(new Fr(0x999n), entries[0]!.selector)],
        [],
        fpcAddress,
      ),
    ).toThrow("no entry")

    expect(() =>
      claimFpcPolicyMerkleProofsForCalls(
        policy,
        Array.from({ length: 6 }, () => call(entries[0]!.target, entries[0]!.selector)),
        [],
        fpcAddress,
      ),
    ).toThrow("at most 5")
  })

  it("rejects malformed or oversized immutable policies before deployment", async () => {
    await expect(
      buildClaimFpcPolicy([{ kind: KIND_BY_SELF, target: Fr.ONE, selector: Fr.ONE, max_fee: 1n }]),
    ).rejects.toThrow("zero target")

    await expect(
      buildClaimFpcPolicy(
        Array.from({ length: CLAIM_FPC_POLICY_LEAVES + 1 }, (_, index) => ({
          kind: KIND_BY_ADDRESS,
          target: new Fr(BigInt(index + 1)),
          selector: Fr.ONE,
          max_fee: 1n,
        })),
      ),
    ).rejects.toThrow("at most 64")

    await expect(buildClaimFpcPolicy([entries[0]!, entries[0]!])).rejects.toThrow("duplicate")

    await expect(
      buildClaimFpcPolicy([{ kind: KIND_BY_ANY, target: Fr.ONE, selector: Fr.ZERO, max_fee: 1n }]),
    ).rejects.toThrow("zero target and selector")
  })

  it("routes every call through a ByAny leaf, the FPC's own included", async () => {
    const byAny = { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 99n }
    const policy = await buildClaimFpcPolicy([entries[0]!, entries[2]!, byAny])
    const fpcAddress = AztecAddress.fromFieldUnsafe(new Fr(0xf0cn))

    // A ByAny leaf DISABLES per-call matching: a call a committed entry would match rides it too,
    // because that one leaf is what the circuit budgets the batch by — and so does a call into the
    // FPC, whose `#[only_self]` functions ByAny reaches like any other target.
    const witnesses = claimFpcPolicyMerkleProofsForCalls(
      policy,
      [
        call(entries[0]!.target, entries[0]!.selector),
        call(new Fr(0x999n), new Fr(0x888n)),
        call(fpcAddress.toField(), entries[2]!.selector),
        call(fpcAddress.toField(), new Fr(0x888n)),
      ],
      [],
      fpcAddress,
    )
    expect(witnesses.slice(0, 4).map((w) => w.entry.kind)).toEqual([
      KIND_BY_ANY,
      KIND_BY_ANY,
      KIND_BY_ANY,
      KIND_BY_ANY,
    ])
  })

  it("matches a public call the same way as a private one", async () => {
    // Public legs are ordinary policy matches: the selector IS the function they run. The circuit
    // does not take this field's word for it — it re-derives the selector from the calldata the
    // batch dispatches (`bound_selector`, config.nr) — but an honest client's two agree.
    const fpcAddress = AztecAddress.fromFieldUnsafe(new Fr(0xf0cn))
    const publicCall = call(entries[0]!.target, entries[0]!.selector, FunctionType.PUBLIC)

    const perCall = await buildClaimFpcPolicy(entries)
    expect(
      claimFpcPolicyMerkleProofsForCalls(perCall, [publicCall], [], fpcAddress)[0]!.entry,
    ).toEqual(entries[0])

    const open = await buildClaimFpcPolicy([
      { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 99n },
    ])
    expect(
      claimFpcPolicyMerkleProofsForCalls(open, [publicCall], [], fpcAddress)[0]!.entry.kind,
    ).toBe(KIND_BY_ANY)

    // A public leg's calldata is bounded: the FPC holds the whole preimage to bind the selector.
    const oversized = FunctionCall.from({
      ...publicCall,
      args: Array.from({ length: 16 }, () => Fr.ZERO),
    })
    await expect(buildSponsoredCallBatch([oversized])).rejects.toThrow(/calldata fields/)
  })

  it("reports whether a policy sponsors any call, which is what picks the declared gas", async () => {
    const byAny = { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 99n }
    expect(claimFpcPolicySponsorsAnyCall(await buildClaimFpcPolicy(entries))).toBe(false)
    expect(claimFpcPolicySponsorsAnyCall(await buildClaimFpcPolicy([entries[0]!, byAny]))).toBe(
      true,
    )
  })
})
