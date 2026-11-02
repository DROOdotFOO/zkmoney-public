import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { PublicKeys } from "@aztec-labs/stdlib/keys"
import {
  type ContractArtifact,
  FunctionCall,
  FunctionSelector,
  FunctionType,
  encodeArguments,
  getFunctionReturnType,
} from "@aztec-labs/stdlib/abi"
import type { AuthWitness } from "@aztec-labs/stdlib/auth-witness"
import { ExecutionPayload, HashedValues, type Capsule } from "@aztec-labs/stdlib/tx"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import {
  MAX_SPONSORED_CALLS,
  buildIntentCapsule,
  buildSponsoredCallBatch,
} from "./sponsoredCall.js"
import type { BootstrapKeyProof } from "./bootstrapKeyWitness.js"

/** Mirrors claim_fpc's fixed binary policy tree. */
export const CLAIM_FPC_POLICY_DEPTH = 6
export const CLAIM_FPC_POLICY_LEAVES = 1 << CLAIM_FPC_POLICY_DEPTH
export const CLAIM_FPC_POLICY_VERSION = 2 as const
/** Mirrors claim_fpc's `MAX_RAILS`: rail slots one deployment can carry. */
export const CLAIM_FPC_MAX_RAILS = 4
export const DOM_SEP_CLAIM_FPC_POLICY_LEAF = 1239
export const DOM_SEP_CLAIM_FPC_POLICY_NODE = 1240
export const KIND_EMPTY = 0
export const KIND_BY_ADDRESS = 1
export const KIND_BY_CLASS = 2
/** A call back into the FPC itself (an `#[only_self]` function); `target` is unused and must be
 * zero. Only a per-call policy needs one — a BY_ANY leaf already matches those calls. */
export const KIND_BY_SELF = 3
/** Matches ANY dispatched call, the FPC's own `#[only_self]` functions included; `target` and
 * `selector` must be zero, and `max_fee` is a PER-BATCH budget the circuit counts at most once. A
 * policy carrying one sponsors openly — see `claimFpcPolicySponsorsAnyCall`. */
export const KIND_BY_ANY = 4

export interface ClaimFpcWhitelistEntry {
  kind: number
  /** Address (BY_ADDRESS), contract class id (BY_CLASS), or zero (BY_SELF, BY_ANY). */
  target: Fr
  /** Function selector as a field. */
  selector: Fr
  max_fee: bigint
}

/** Merkle inclusion proof for one call against the immutable policy root. */
export interface ClaimFpcPolicyMerkleProof {
  entry: ClaimFpcWhitelistEntry
  leaf_index: number
  sibling_path: Fr[]
}

/** Runtime policy: canonical entries plus precomputed witnesses for cheap payload construction. */
export interface ClaimFpcPolicy {
  root: Fr
  witnesses: ClaimFpcPolicyMerkleProof[]
  emptyWitness: ClaimFpcPolicyMerkleProof
}

/**
 * The gates claim_fpc implements, keyed by the kind a client declares. The value is the contract
 * function the rail's `gate_selector` has to name, so `gateSelector` derives that selector from the
 * artifact instead of anyone transcribing it. `none` is a rail entered by `gift_voucher` alone: its
 * selector is the `CLAIM_FPC_GATE_NONE` sentinel, which `subscribe` refuses outright.
 */
export const CLAIM_FPC_GATE_FUNCTIONS = {
  nameClaim: "_gate_name_claim",
  registration: "_gate_registration",
  none: null,
} as const satisfies Record<string, string | null>

/** Mirrors claim_fpc's `GATE_NONE`: the configured-but-closed gate of a rail entered by gift. */
export const CLAIM_FPC_GATE_NONE = 1

export type ClaimFpcGateKind = keyof typeof CLAIM_FPC_GATE_FUNCTIONS

export const CLAIM_FPC_GATE_KINDS = Object.keys(CLAIM_FPC_GATE_FUNCTIONS) as ClaimFpcGateKind[]

/** Mirror of the Noir `Rail`: one sponsorship offer of a deployment. */
export interface ClaimFpcRail {
  /** Selector of the `#[only_self]` gate `subscribe` runs; zero marks an empty slot. */
  gate_selector: Fr
  policy_root: Fr
  /** Sponsored-tx allowance per refill window; the rail's SubscriptionNote refills to this cap. */
  max_tx: number
  /** Refill window in seconds (86400 for a daily rail); 0 never refills. */
  refill_period: bigint
}

/** JSON-safe public representation stored beside the ClaimFPC registry record. Rail order IS the
 * `rail_id` the entrypoints take, so it is part of the deployment's identity, not a display order. */
export interface ClaimFpcPolicyManifest {
  version: typeof CLAIM_FPC_POLICY_VERSION
  depth: typeof CLAIM_FPC_POLICY_DEPTH
  rails: Array<{
    name: string
    gate: ClaimFpcGateKind
    policy: {
      root: string
      entries: Array<{
        kind: number
        target: string
        selector: string
        maxFee: string
      }>
    }
  }>
}

/** One published rail, resolved for use: its id, its gate, and its checked policy. */
export interface ClaimFpcRailPolicy {
  railId: number
  name: string
  gate: ClaimFpcGateKind
  policy: ClaimFpcPolicy
}

/** The whole config (the ClaimFPC `configure` argument, one-shot after deploy). */
export interface ClaimFpcConfig {
  domain_owner_pub_key_x_hi: Fr
  domain_owner_pub_key_x_lo: Fr
  domain_owner_pub_key_y_hi: Fr
  domain_owner_pub_key_y_lo: Fr
  registry_domain_separator_hi: Fr
  registry_domain_separator_lo: Fr
  factory_address: Fr
  implementation_address: Fr
  /** L1 `NamePortal` — the only sender whose name-ownership message the registration gate
   * consumes. */
  name_portal_address: Fr
  /** The price the FPC sponsors at, per gas dimension. The circuit prices the contract's own
   * `CLAIM_FPC_OVERHEAD_GAS` at these once per batch; entry `max_fee`s are gas priced the same way
   * — a call's marginal gas, or the whole-batch caps for a BY_ANY entry. */
  max_fee_per_da_gas: bigint
  max_fee_per_l2_gas: bigint
  /** Fixed-width rail slots; index is the `rail_id`. Empty slots carry a zero `gate_selector`. */
  rails: ClaimFpcRail[]
  /** Preimage of the secret hash oxide's skim pool attaches to its FeeJuicePortal deposits for
   * this FPC. Public by design (oxide's `PORTAL_CONSTANT_SECRET`); it only lets anyone run `refuel`. */
  claim_secret: Fr
}

export function emptyClaimFpcRail(): ClaimFpcRail {
  return { gate_selector: Fr.ZERO, policy_root: Fr.ZERO, max_tx: 0, refill_period: 0n }
}

/** Pad rail slots to the config's fixed width. */
export function padClaimFpcRails(rails: ClaimFpcRail[]): ClaimFpcRail[] {
  if (rails.length === 0 || rails.length > CLAIM_FPC_MAX_RAILS) {
    throw new Error(
      `a ClaimFPC deployment carries 1..${CLAIM_FPC_MAX_RAILS} rails, got ${rails.length}`,
    )
  }
  return [
    ...rails,
    ...Array.from({ length: CLAIM_FPC_MAX_RAILS - rails.length }, emptyClaimFpcRail),
  ]
}

/** The gate function's ABI, from the deployed artifact. */
function gateFunctionAbi(artifact: ContractArtifact, kind: ClaimFpcGateKind) {
  const name = CLAIM_FPC_GATE_FUNCTIONS[kind]
  const abi = artifact.functions.find((f) => f.name === name)
  if (!abi) {
    throw new Error(
      `ClaimFPC artifact has no "${name}" gate — it predates the "${kind}" rail; ` +
        "rebuild it with pnpm build-contracts -c claim_fpc",
    )
  }
  return abi
}

/**
 * The selector a rail's `gate_selector` must carry to run `kind`. Derived from the artifact the
 * deploy is about to deploy, so a renamed or re-signatured gate cannot be configured stale.
 */
export async function gateSelector(
  artifact: ContractArtifact,
  kind: ClaimFpcGateKind,
): Promise<FunctionSelector> {
  if (CLAIM_FPC_GATE_FUNCTIONS[kind] === null) {
    return FunctionSelector.fromField(new Fr(CLAIM_FPC_GATE_NONE))
  }
  const abi = gateFunctionAbi(artifact, kind)
  return FunctionSelector.fromNameAndParameters(abi.name, abi.parameters)
}

/** The witnesses one gate kind consumes. `subscribe` carries only their hash. A rail with no gate
 * takes none: naming it builds a subscribe the rail refuses, which is what a test of that sends. */
export type ClaimFpcGateWitness =
  | ({ kind: "nameClaim" } & NameClaimWitness)
  | ({ kind: "registration" } & RegistrationWitness)
  | { kind: "none" }

/** A gate's arguments, in its ABI's order. */
export function gateArgs(user: AztecAddress, gate: ClaimFpcGateWitness): unknown[] {
  if (gate.kind === "none") return []
  if (gate.kind === "registration") {
    return [
      user,
      Array.from(gate.nameHash),
      Array.from(gate.bootstrapPubKeyX),
      Array.from(gate.bootstrapPubKeyY),
      Array.from(gate.keyWitness),
      gate.leafIndex,
    ]
  }
  return [
    user,
    Array.from(gate.nameHash),
    Array.from(gate.nonce),
    Array.from(gate.deadline),
    Array.from(gate.claimSig),
    Array.from(gate.bootstrapPubKeyX),
    Array.from(gate.bootstrapPubKeyY),
    Array.from(gate.bindingSig),
  ]
}

export function emptyWhitelistEntry(): ClaimFpcWhitelistEntry {
  return { kind: KIND_EMPTY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 0n }
}

function validatePolicyEntries(entries: ClaimFpcWhitelistEntry[]): void {
  if (entries.length === 0 || entries.length > CLAIM_FPC_POLICY_LEAVES) {
    throw new Error(
      `ClaimFPC policy must have at most ${CLAIM_FPC_POLICY_LEAVES} entries and cannot be empty, ` +
        `got ${entries.length}`,
    )
  }
  const entryKeys = new Set<string>()
  for (const entry of entries) {
    if (![KIND_BY_ADDRESS, KIND_BY_CLASS, KIND_BY_SELF, KIND_BY_ANY].includes(entry.kind)) {
      throw new Error(`invalid ClaimFPC policy kind ${entry.kind}`)
    }
    if (entry.kind === KIND_BY_SELF && !entry.target.isZero()) {
      throw new Error(
        `BY_SELF policy entry must carry a zero target (selector ${entry.selector}); ` +
          "the target is the FPC itself by definition",
      )
    }
    if (entry.kind === KIND_BY_ANY && (!entry.target.isZero() || !entry.selector.isZero())) {
      throw new Error("BY_ANY policy entry must carry a zero target and selector")
    }
    if (entry.max_fee < 0n || entry.max_fee >= 1n << 128n) {
      throw new Error(`ClaimFPC policy max_fee must fit u128, got ${entry.max_fee}`)
    }
    const entryKey = `${entry.kind}:${entry.target}:${entry.selector}`
    if (entryKeys.has(entryKey)) {
      throw new Error(
        `duplicate ClaimFPC policy entry for kind ${entry.kind}, target ${entry.target}, ` +
          `selector ${entry.selector}`,
      )
    }
    entryKeys.add(entryKey)
  }
}

async function hashPolicyEntry(entry: ClaimFpcWhitelistEntry): Promise<Fr> {
  return poseidon2HashWithSeparator(
    [new Fr(BigInt(entry.kind)), entry.target, entry.selector, new Fr(entry.max_fee)],
    DOM_SEP_CLAIM_FPC_POLICY_LEAF,
  )
}

async function hashPolicyNode(left: Fr, right: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([left, right], DOM_SEP_CLAIM_FPC_POLICY_NODE)
}

/** Recompute a policy root from one leaf and its six bottom-up siblings. */
export async function claimFpcPolicyMerkleRoot(witness: ClaimFpcPolicyMerkleProof): Promise<Fr> {
  if (
    !Number.isInteger(witness.leaf_index) ||
    witness.leaf_index < 0 ||
    witness.leaf_index >= CLAIM_FPC_POLICY_LEAVES
  ) {
    throw new Error(`ClaimFPC policy leaf index out of range: ${witness.leaf_index}`)
  }
  if (witness.sibling_path.length !== CLAIM_FPC_POLICY_DEPTH) {
    throw new Error(
      `ClaimFPC policy witness needs ${CLAIM_FPC_POLICY_DEPTH} siblings, ` +
        `got ${witness.sibling_path.length}`,
    )
  }

  let current = await hashPolicyEntry(witness.entry)
  for (let level = 0; level < CLAIM_FPC_POLICY_DEPTH; level++) {
    const sibling = witness.sibling_path[level]!
    current =
      ((witness.leaf_index >> level) & 1) === 0
        ? await hashPolicyNode(current, sibling)
        : await hashPolicyNode(sibling, current)
  }
  return current
}

/** Build the fixed 64-leaf policy and every proof once; payloads only select and encode them. */
export async function buildClaimFpcPolicy(
  entries: ClaimFpcWhitelistEntry[],
): Promise<ClaimFpcPolicy> {
  validatePolicyEntries(entries)
  const paddedEntries = [
    ...entries,
    ...Array.from({ length: CLAIM_FPC_POLICY_LEAVES - entries.length }, emptyWhitelistEntry),
  ]
  const levels: Fr[][] = [await Promise.all(paddedEntries.map(hashPolicyEntry))]
  for (let level = 0; level < CLAIM_FPC_POLICY_DEPTH; level++) {
    const previous = levels[level]!
    const next = await Promise.all(
      Array.from({ length: previous.length / 2 }, (_, index) =>
        hashPolicyNode(previous[index * 2]!, previous[index * 2 + 1]!),
      ),
    )
    levels.push(next)
  }

  const witnessAt = (leafIndex: number): ClaimFpcPolicyMerkleProof => ({
    entry: paddedEntries[leafIndex]!,
    leaf_index: leafIndex,
    sibling_path: Array.from(
      { length: CLAIM_FPC_POLICY_DEPTH },
      (_, level) => levels[level]![(leafIndex >> level) ^ 1]!,
    ),
  })

  return {
    root: levels[CLAIM_FPC_POLICY_DEPTH]![0]!,
    witnesses: entries.map((_, index) => witnessAt(index)),
    emptyWitness: witnessAt(entries.length < CLAIM_FPC_POLICY_LEAVES ? entries.length : 0),
  }
}

/** One rail as its deployer names it: a name clients declare, a gate kind, and a built policy. */
export interface ClaimFpcRailPolicySpec {
  name: string
  gate: ClaimFpcGateKind
  policy: ClaimFpcPolicy
}

export function serializeClaimFpcPolicyManifest(
  rails: ClaimFpcRailPolicySpec[],
): ClaimFpcPolicyManifest {
  return {
    version: CLAIM_FPC_POLICY_VERSION,
    depth: CLAIM_FPC_POLICY_DEPTH,
    rails: rails.map(({ name, gate, policy }) => ({
      name,
      gate,
      policy: {
        root: policy.root.toString(),
        entries: policy.witnesses.map(({ entry }) => ({
          kind: entry.kind,
          target: entry.target.toString(),
          selector: entry.selector.toString(),
          maxFee: entry.max_fee.toString(),
        })),
      },
    })),
  }
}

/**
 * Parse untrusted registry JSON into this deployment's rails, indexed by `rail_id`. Fails closed on
 * anything that would make a client build an unusable batch: an unknown version, a rail whose
 * entries do not reproduce its declared root, a gate this sdk cannot build witnesses for, or a
 * duplicate name (two rails answering to one declaration is ambiguous, not a preference).
 */
export async function parseClaimFpcPolicyManifest(raw: unknown): Promise<ClaimFpcRailPolicy[]> {
  if (!raw || typeof raw !== "object")
    throw new Error(
      "ClaimFPC policy manifest is missing — deploy it with " +
        "`pnpm run:deploy -n <network>` from packages/tooling/l2-contracts-deployer",
    )
  const manifest = raw as Partial<ClaimFpcPolicyManifest>
  if (manifest.version !== CLAIM_FPC_POLICY_VERSION) {
    throw new Error(`unsupported ClaimFPC policy version ${String(manifest.version)}`)
  }
  if (manifest.depth !== CLAIM_FPC_POLICY_DEPTH) {
    throw new Error(`ClaimFPC policy depth must be ${CLAIM_FPC_POLICY_DEPTH}`)
  }
  if (!Array.isArray(manifest.rails) || manifest.rails.length === 0) {
    throw new Error("ClaimFPC policy manifest carries no rails")
  }
  if (manifest.rails.length > CLAIM_FPC_MAX_RAILS) {
    throw new Error(
      `ClaimFPC policy manifest declares ${manifest.rails.length} rails, ` +
        `the contract holds ${CLAIM_FPC_MAX_RAILS}`,
    )
  }

  const names = new Set<string>()
  const rails: ClaimFpcRailPolicy[] = []
  for (const [railId, rail] of manifest.rails.entries()) {
    if (!rail?.name || typeof rail.name !== "string") {
      throw new Error(`ClaimFPC rail ${railId} has no name`)
    }
    if (names.has(rail.name)) {
      throw new Error(`duplicate ClaimFPC rail name "${rail.name}"`)
    }
    names.add(rail.name)
    if (!CLAIM_FPC_GATE_KINDS.includes(rail.gate)) {
      throw new Error(
        `ClaimFPC rail "${rail.name}" names gate "${String(rail.gate)}"; this sdk builds ` +
          `witnesses for ${CLAIM_FPC_GATE_KINDS.join(", ")}`,
      )
    }
    if (typeof rail.policy?.root !== "string" || !Array.isArray(rail.policy.entries)) {
      throw new Error(`ClaimFPC rail "${rail.name}" has no policy root or entries`)
    }

    let entries: ClaimFpcWhitelistEntry[]
    let declaredRoot: Fr
    try {
      declaredRoot = Fr.fromString(rail.policy.root)
      entries = rail.policy.entries.map((entry) => ({
        kind: entry.kind,
        target: Fr.fromString(entry.target),
        selector: Fr.fromString(entry.selector),
        max_fee: BigInt(entry.maxFee),
      }))
    } catch (error) {
      throw new Error(`invalid ClaimFPC rail "${rail.name}": ${String(error)}`)
    }

    const policy = await buildClaimFpcPolicy(entries)
    if (!policy.root.equals(declaredRoot)) {
      throw new Error(
        `ClaimFPC rail "${rail.name}" policy root mismatch: declared ${declaredRoot}, ` +
          `computed ${policy.root}`,
      )
    }
    rails.push({ railId, name: rail.name, gate: rail.gate, policy })
  }
  return rails
}

/**
 * The rail a client declares, by name. Names are the contract between a deployment and its clients:
 * a flow says which offer it rides, and the deployment decides what that offer costs and allows.
 * An absent name is a deploy/client mismatch — loud here rather than a batch the FPC refuses.
 */
export function railByName(rails: ClaimFpcRailPolicy[], name: string): ClaimFpcRailPolicy {
  const rail = rails.find((candidate) => candidate.name === name)
  if (!rail)
    throw new UnknownRailError(
      name,
      rails.map((r) => r.name),
    )
  return rail
}

/** A rail name the deployment does not declare: a client/deploy mismatch, not a failed read. */
export class UnknownRailError extends Error {
  constructor(readonly railName: string, offered: string[]) {
    super(
      `ClaimFPC has no rail named "${railName}" — this deployment offers ` +
        offered.map((n) => `"${n}"`).join(", "),
    )
    this.name = "UnknownRailError"
  }
}

/** Split a 32-byte value into the (hi, lo) 16-byte field halves config.nr stores. */
export function bytes32ToFieldPair(bytes: Uint8Array): [Fr, Fr] {
  if (bytes.length !== 32) throw new Error("expected 32 bytes")
  return [
    Fr.fromBuffer(Buffer.concat([Buffer.alloc(16), bytes.slice(0, 16)])),
    Fr.fromBuffer(Buffer.concat([Buffer.alloc(16), bytes.slice(16, 32)])),
  ]
}

/** ABI shape of an unused ClassWitness slot (never dereferenced by the contract). */
export function emptyClassWitness() {
  return {
    class_id: Fr.ZERO,
    salted_initialization_hash: Fr.ZERO,
    public_keys: PublicKeys.default().toNoirStruct(),
  }
}

export interface ClassWitnessInput {
  classId: Fr
  saltedInitializationHash: Fr
  publicKeys: ReturnType<PublicKeys["toNoirStruct"]>
}

/**
 * What both gates rest on: the bootstrap key CREATE2-derives the OxideAccount the L1 side names,
 * and signs the L2 address being subscribed. Deriving the account rather than taking it is what
 * stops a caller pointing a gate at somebody else's L1 identity; the signature is what stops an
 * observer of that (public) L1 data subscribing an address of their own. All byte arrays
 * big-endian, and every one of them re-derives from the master secret plus public L1 data.
 */
export interface OxideAccountBinding {
  /** The name the L1 side commits to: the claimed node, and the one the registry stores. */
  nameHash: Uint8Array // 32
  bootstrapPubKeyX: Uint8Array // 32
  bootstrapPubKeyY: Uint8Array // 32
  bindingSig: Uint8Array // 64 (r||s over keccak("OBSIDION_L2_BINDING_V1" || l2_address))
}

/** The NameClaim gate's witnesses: the binding, plus the domain owner's L1 authorization of it. */
export interface NameClaimWitness extends OxideAccountBinding {
  nonce: Uint8Array // 32 (uint256)
  deadline: Uint8Array // 32 (uint256; signed data only, never enforced)
  claimSig: Uint8Array // 64 (r||s of the domain owner's EIP-712 signature; pubkey pinned in config)
}

/**
 * The registration gate's witnesses: the bootstrap key proof, plus the leaf of the NamePortal
 * message naming that key's address and the name. The key derives from the master secret and the
 * leaf index comes from the Inbox's logs (`findRegistrationMessage`, services/registrationMessage.ts),
 * so a wallet restored on a fresh device rebuilds them.
 */
export interface RegistrationWitness extends BootstrapKeyProof {
  nameHash: Uint8Array // 32
  leafIndex: Fr
}

interface CommonOpts {
  fpcAddress: AztecAddress
  fpcArtifact: ContractArtifact
  /** The rail this batch rides — its id in the deployed config (`railByName`). */
  railId: number
  /** That rail's policy, already checked against its declared root. */
  policy: ClaimFpcPolicy
  user: AztecAddress
  /** The account whose call authorizes `intentHashes`, when it is not `user` (a paylink's escrow
   *  paying for a claim into the recipient's account). Owns the intent capsule. */
  intentsAccount?: AztecAddress
  innerCalls: FunctionCall[]
  classWitnesses?: (ClassWitnessInput | undefined)[]
  /**
   * The intent list the account's intents note commits to. The FPC never sees these — they feed
   * the PXE-side capsule `verify_private_authwit` reads. `combinedAuthWitness` (the user's one
   * signature over their intents-only hash) rides the payload of the batch whose
   * `authorize_intents` call writes that note; a batch that only reads the note carries none.
   */
  intentHashes?: Fr[]
  combinedAuthWitness?: AuthWitness
  /**
   * Tx-global capsules to carry alongside the intent capsule — the seam the
   * TEE-attested oxide-token flows use (seed/strict-mode/signature/DA
   * capsules are keyed by (contract, slot), so they ride the tx whole rather
   * than per-call).
   */
  extraCapsules?: Capsule[]
}

/**
 * Does this policy sponsor any private non-FPC call? True when it commits a `BY_ANY` entry, which
 * is what makes the batch's budget flat (that entry's per-batch `max_fee`) instead of a sum of
 * per-call ceilings — so it also decides which gas a client declares (`claimFpcDeclaredGas`).
 */
export function claimFpcPolicySponsorsAnyCall(policy: ClaimFpcPolicy): boolean {
  return policy.witnesses.some(({ entry }) => entry.kind === KIND_BY_ANY)
}

/** Select the committed leaf for every real call, then pad the fixed-width witness ABI. */
export function claimFpcPolicyMerkleProofsForCalls(
  policy: ClaimFpcPolicy,
  calls: FunctionCall[],
  classWitnesses: (ClassWitnessInput | undefined)[],
  fpcAddress: AztecAddress,
): ClaimFpcPolicyMerkleProof[] {
  if (calls.length > MAX_SPONSORED_CALLS) {
    throw new Error(`ClaimFPC supports at most ${MAX_SPONSORED_CALLS} calls, got ${calls.length}`)
  }
  // A BY_ANY leaf DISABLES per-call matching: the batch rides that one leaf and its per-batch
  // budget. Assembly is otherwise identical either way — callers pass the class witnesses a
  // per-call policy would need, and an open policy ignores them.
  const byAny = policy.witnesses.find(({ entry }) => entry.kind === KIND_BY_ANY)
  const selected = calls.map((call, callIndex) => {
    const selector = call.selector.toField()
    const classWitness = classWitnesses[callIndex]
    // Public and private calls match the same way: `selector` is the function either one runs, and
    // for a public call the FPC re-derives it from the calldata rather than trusting this field.
    const specific = policy.witnesses.find(({ entry }) => {
      if (!entry.selector.equals(selector)) return false
      if (entry.kind === KIND_BY_ADDRESS) return entry.target.equals(call.to.toField())
      if (entry.kind === KIND_BY_CLASS) {
        return classWitness !== undefined && entry.target.equals(classWitness.classId)
      }
      return entry.kind === KIND_BY_SELF && entry.target.isZero() && call.to.equals(fpcAddress)
    })
    const witness = byAny ?? specific
    if (!witness) {
      throw new Error(
        `ClaimFPC policy has no entry for call ${callIndex} ` +
          `(${call.to}:${selector.toString()})`,
      )
    }
    return witness
  })

  return [
    ...selected,
    ...Array.from({ length: MAX_SPONSORED_CALLS - selected.length }, () => policy.emptyWitness),
  ]
}

async function buildPayload(
  opts: CommonOpts,
  entrypoint: string,
  extraArgs: unknown[],
  extraArgsPreimages: HashedValues[] = [],
): Promise<ExecutionPayload> {
  const intentHashes = opts.intentHashes ?? []
  const account = opts.intentsAccount ?? opts.user
  // A batch that calls the account authorizes its intents and needs the signature. One that only
  // consumes them reads the intents note an earlier batch wrote.
  const authorizes = opts.innerCalls.some((call) => call.to.equals(account))
  if (intentHashes.length > 0 && authorizes && !opts.combinedAuthWitness) {
    throw new Error("intentHashes provided without the combined auth witness")
  }

  const { calls, extraHashedArgs, publicCalldata, publicCalldataLens } =
    await buildSponsoredCallBatch(opts.innerCalls)
  const witnesses = Array.from({ length: MAX_SPONSORED_CALLS }, (_, i) => {
    const w = opts.classWitnesses?.[i]
    return w
      ? {
          class_id: w.classId,
          salted_initialization_hash: w.saltedInitializationHash,
          public_keys: w.publicKeys,
        }
      : emptyClassWitness()
  })
  const policyWitnesses = claimFpcPolicyMerkleProofsForCalls(
    opts.policy,
    opts.innerCalls,
    opts.classWitnesses ?? [],
    opts.fpcAddress,
  )

  const abi = opts.fpcArtifact.functions.find((f) => f.name === entrypoint)
  if (!abi) throw new Error(`ClaimFPC artifact has no "${entrypoint}" function`)
  const selector = await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters)
  const args = encodeArguments(abi, [
    opts.railId,
    calls,
    witnesses,
    policyWitnesses,
    publicCalldata,
    publicCalldataLens,
    opts.user,
    ...extraArgs,
  ])

  const entrypointCall = FunctionCall.from({
    name: entrypoint,
    to: opts.fpcAddress,
    selector,
    type: FunctionType.PRIVATE,
    isStatic: false,
    hideMsgSender: false,
    args,
    returnType: getFunctionReturnType(abi),
  })

  return new ExecutionPayload(
    [entrypointCall],
    opts.combinedAuthWitness ? [opts.combinedAuthWitness] : [],
    [
      ...(intentHashes.length > 0
        ? [buildIntentCapsule(opts.intentsAccount ?? opts.user, intentHashes)]
        : []),
      ...(opts.extraCapsules ?? []),
    ],
    [...extraHashedArgs, ...extraArgsPreimages],
    opts.fpcAddress,
  )
}

/**
 * Build the `subscribe` ExecutionPayload: onboarding onto one rail. The gate's witnesses ride the
 * tx's hashed args and `subscribe` carries only their hash, so the entrypoint's ABI is the same
 * whichever gate the rail names. The account's `authorize_intents` call rides `innerCalls` like any
 * other batched call. Send with `{ from: NO_FROM }` and `additionalScopes: [user]` — the user owns
 * every note the batch reads.
 */
export async function buildClaimSubscribePayload(
  opts: CommonOpts & {
    gate: ClaimFpcGateWitness
  },
): Promise<ExecutionPayload> {
  // No gate runs on such a rail: `subscribe` refuses it before reading the hash, so any hash serves.
  if (opts.gate.kind === "none") return buildPayload(opts, "subscribe", [Fr.ZERO])
  const abi = gateFunctionAbi(opts.fpcArtifact, opts.gate.kind)
  const gateArguments = await HashedValues.fromArgs(
    encodeArguments(abi, gateArgs(opts.user, opts.gate)),
  )
  return buildPayload(opts, "subscribe", [gateArguments.hash], [gateArguments])
}

/**
 * Build the `sponsor` ExecutionPayload: a follow-up sponsored batch on a rail the user already
 * holds. Rate limiting lives entirely in that rail's SubscriptionNote — the client supplies no date
 * or index.
 */
export async function buildClaimSponsorPayload(opts: CommonOpts): Promise<ExecutionPayload> {
  return buildPayload(opts, "sponsor", [])
}
