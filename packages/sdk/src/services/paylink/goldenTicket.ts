/**
 * Golden ticket witness: everything the `golden_ticket` circuit needs to prove that a paylink note of
 * at least `threshold` sits under a recent note-tree root, siloed to a paylink escrow, bound to one
 * L1 owner. The wallet proves it; the account-service verifies it and grants the reduced schedule.
 */
import type { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/poseidon"
import type { NotesFilter, PXE } from "@aztec-labs/pxe/client/lazy"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { computeUniqueNoteHash, siloNoteHash } from "@aztec-labs/stdlib/hash"
import type { NoteDao } from "@aztec-labs/stdlib/note"
import { type ContractName, type ContractService, DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { DOM_SEP__GOLDEN_TICKET } from "@obsidion/core/constants"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import type { PaylinkParams } from "./PaylinkService.js"
import { LINK_CLASS_REFUSAL } from "./link/paylinkInlineCodec.js"
import { unpackPaylinkData } from "./escrow/paylinkNoteData.js"
import { registerEscrow } from "./claim/paylinkVoucher.js"

/** Both escrows keep the note in their first storage slot. */
export const PAYLINK_NOTE_STORAGE_SLOT = 1n

/**
 * The chain, as this PXE sees it, does not hold the link's note where the witness needs it: not
 * synced yet, pruned, or reorged. Nothing was redeemed; the wallet retries after the next block.
 */
export class GoldenTicketWitnessError extends Error {
  readonly retryable = true
  constructor(message: string) {
    super(message)
    this.name = "GoldenTicketWitnessError"
  }
}

export interface GoldenTicketDeps {
  wallet: ObsidionWallet
  contractService: ContractService
}

/** The circuit's public inputs, in ABI order; `nullifier` is its return value. */
export interface GoldenTicketPublicInputs {
  root: Fr
  blockNumber: number
  threshold: bigint
  token: AztecAddress
  /** Direct then email paylink class ids. */
  classIds: [Fr, Fr]
  owner: EthAddress
}

export interface GoldenTicketWitness {
  /** ABI input map for `noir_js` / `abiEncode`. */
  inputs: Record<string, unknown>
  publicInputs: GoldenTicketPublicInputs
  /** The note's leaf in the note-hash tree; the nullifier derives from it. */
  uniqueNoteHash: Fr
  nullifier: Fr
  /** What the note holds; below `threshold` the proof can only fail. */
  amount: bigint
}

const hex = (f: { toString(): string }) => f.toString()

/**
 * The class pair a ticket proves against, direct then email: the link's own class in its flavor's
 * slot and the other flavor's current class in the other, so a link under an older reviewed class
 * still proves and a link under the current classes sends the current pair. `escrow` is the link's
 * escrow as `registerEscrow` resolves it. Its class must be one its own flavor has had here:
 * `registerEscrow` finds a reviewed class by id alone, whatever flavor the manifest lists it under.
 */
export async function paylinkClassIds(
  contractService: Pick<ContractService, "getArtifactForContract" | "getKnownClassIds">,
  paylinkType: string,
  escrow: { currentContractClassId: Fr },
): Promise<[Fr, Fr]> {
  const own = escrow.currentContractClassId
  const slot = async (name: ContractName) => {
    const current = (
      await getContractClassFromArtifact(await contractService.getArtifactForContract(name))
    ).id
    if (paylinkType !== name || own.equals(current)) return current
    if (!(await contractService.getKnownClassIds(name)).includes(own.toString())) {
      throw new Error(LINK_CLASS_REFUSAL)
    }
    return own
  }
  return [await slot(DEFAULT_CONTRACTS.paylinkDirect), await slot(DEFAULT_CONTRACTS.paylinkEmail)]
}

export function goldenTicketNullifier(uniqueNoteHash: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([uniqueNoteHash], DOM_SEP__GOLDEN_TICKET)
}

/** The proof's public-input vector as bb.js emits it: the public params in order, then the return. */
export function goldenTicketPublicInputVector(p: GoldenTicketPublicInputs, nullifier: Fr): Fr[] {
  return [
    p.root,
    new Fr(p.threshold),
    p.token.toField(),
    p.classIds[0],
    p.classIds[1],
    p.owner.toField(),
    nullifier,
  ]
}

/**
 * The escrow's settled paylink note as the PXE stores it, read through `PXE.debug.getNotes`, the one
 * note-preimage read `@aztec-labs/pxe` 5.2.0 exposes. Upstream marks it debug-only because a note layout
 * is a contract's implementation detail; here the escrow contract and its note layout are
 * wallet-owned, the read runs inside the PXE job queue behind its block sync and the escrow's own
 * `sync_state`, and the `NotesFilter` / `NoteDao` types make a rename at the next repin a build
 * error. An escrow utility returning the same preimage replaces this at the next escrow redeploy,
 * since a new utility changes the class id.
 */
async function readSettledPaylinkNote(
  pxe: PXE,
  escrow: AztecAddress,
): Promise<NoteDao | undefined> {
  const filter: NotesFilter = {
    contractAddress: escrow,
    scopes: [escrow],
    owner: escrow,
    storageSlot: new Fr(PAYLINK_NOTE_STORAGE_SLOT),
  }
  const notes: NoteDao[] = await pxe.debug.getNotes(filter)
  return notes[0]
}

/**
 * The witness with everything but the owner and the threshold: the escrow rebuilt in this PXE, its
 * settled note, and the note's membership path under one block's note-tree root. Nothing here needs
 * the redeemer's key, so it can be read before the passkey exists.
 */
export interface PreparedGoldenTicketWitness {
  /** ABI inputs without `owner` and `threshold`. */
  inputs: Record<string, unknown>
  root: Fr
  blockNumber: number
  token: AztecAddress
  classIds: [Fr, Fr]
  uniqueNoteHash: Fr
  nullifier: Fr
  amount: bigint
}

/**
 * Rebuild the escrow in this PXE, read its settled paylink note, and fetch the note's membership
 * path under the block's note-tree root. `blockNumber` defaults to the node's latest block. Throws
 * `GoldenTicketWitnessError` while the chain disagrees with the PXE.
 */
export async function prepareGoldenTicketWitness(
  deps: GoldenTicketDeps,
  params: PaylinkParams,
  opts: { blockNumber?: number } = {},
): Promise<PreparedGoldenTicketWitness> {
  const { instance, keys } = await registerEscrow(deps, params)
  const classIds = await paylinkClassIds(deps.contractService, params.paylinkType, instance)
  const escrow = instance.address
  const dao = await readSettledPaylinkNote(deps.wallet.pxe, escrow)
  if (!dao) {
    throw new GoldenTicketWitnessError(
      "The link's note is not in this wallet's view of the chain yet. Try again after the next block.",
    )
  }

  const node = deps.wallet.node
  const blockNumber = opts.blockNumber ?? Number(await node.getBlockNumber())
  const header = (await node.getBlockData(blockNumber as never))?.header
  if (!header) {
    throw new GoldenTicketWitnessError(
      `Block ${blockNumber} is not available from the node. Try again after the next block.`,
    )
  }
  const root = header.state.partial.noteHashTree.root

  const uniqueNoteHash = await computeUniqueNoteHash(
    dao.noteNonce,
    await siloNoteHash(escrow, dao.noteHash),
  )
  const witness = await node.getNoteHashMembershipWitness(blockNumber as never, uniqueNoteHash)
  if (!witness) {
    throw new GoldenTicketWitnessError(
      `The link's note is not under block ${blockNumber}. Try again after the next block.`,
    )
  }

  const token = AztecAddress.fromFieldUnsafe(dao.note.items[6]!)
  const pk = keys.publicKeys
  const inputs: Record<string, unknown> = {
    root: hex(root),
    token: { inner: hex(token.toField()) },
    class_ids: classIds.map(hex),
    note: paylinkNoteInput(dao),
    randomness: hex(dao.randomness),
    note_nonce: hex(dao.noteNonce),
    witness: {
      leaf_index: `0x${witness.leafIndex.toString(16)}`,
      sibling_path: witness.siblingPath.map(hex),
    },
    public_keys: {
      npk_m_hash: hex(pk.npkMHash),
      ivpk_m: {
        inner: { x: hex(pk.ivpkM.x), y: hex(pk.ivpkM.y), is_infinite: pk.ivpkM.isInfinite },
      },
      ovpk_m_hash: hex(pk.ovpkMHash),
      tpk_m_hash: hex(pk.tpkMHash),
      mspk_m_hash: hex(pk.mspkMHash),
      fbpk_m_hash: hex(pk.fbpkMHash),
    },
    class_id: hex(instance.currentContractClassId),
  }
  return {
    inputs,
    root,
    blockNumber,
    token,
    classIds,
    uniqueNoteHash,
    nullifier: await goldenTicketNullifier(uniqueNoteHash),
    amount: unpackPaylinkData(dao.note.items[2]!).amount,
  }
}

/**
 * Throws `GoldenTicketWitnessError` unless the prepared note is still the escrow's settled note. A
 * link claimed or cancelled since keeps its note under the prepared root, where a proof still
 * verifies, so a redeem checks this before it spends the ticket.
 */
export async function assertGoldenTicketNoteSettled(
  deps: GoldenTicketDeps,
  params: PaylinkParams,
  prepared: Pick<PreparedGoldenTicketWitness, "uniqueNoteHash">,
): Promise<void> {
  const { instance } = await registerEscrow(deps, params)
  const dao = await readSettledPaylinkNote(deps.wallet.pxe, instance.address)
  const unique =
    dao &&
    (await computeUniqueNoteHash(dao.noteNonce, await siloNoteHash(instance.address, dao.noteHash)))
  if (!unique?.equals(prepared.uniqueNoteHash)) {
    throw new GoldenTicketWitnessError(
      "The link's note is no longer in this wallet's view of the chain.",
    )
  }
}

/** Binds a prepared witness to the redeemer and the threshold the service asks for. */
export function finishGoldenTicketWitness(
  prepared: PreparedGoldenTicketWitness,
  opts: { threshold: bigint; owner: EthAddress },
): GoldenTicketWitness {
  const { inputs, root, blockNumber, token, classIds, uniqueNoteHash, nullifier, amount } = prepared
  return {
    inputs: {
      ...inputs,
      threshold: `0x${opts.threshold.toString(16)}`,
      owner: hex(opts.owner.toField()),
    },
    publicInputs: {
      root,
      blockNumber,
      threshold: opts.threshold,
      token,
      classIds,
      owner: opts.owner,
    },
    uniqueNoteHash,
    nullifier,
    amount,
  }
}

/** {@link prepareGoldenTicketWitness} then {@link finishGoldenTicketWitness}, in one call. */
export async function buildGoldenTicketWitness(
  deps: GoldenTicketDeps,
  params: PaylinkParams,
  opts: { threshold: bigint; owner: EthAddress; blockNumber?: number },
): Promise<GoldenTicketWitness> {
  return finishGoldenTicketWitness(await prepareGoldenTicketWitness(deps, params, opts), opts)
}

/** Packed `PaylinkNote` items in declaration order. */
function paylinkNoteInput(dao: NoteDao) {
  const items = dao.note.items
  if (items.length !== 7) throw new Error(`paylink note packs 7 fields, got ${items.length}`)
  return {
    hash: hex(items[0]!),
    sender_hash: hex(items[1]!),
    data: hex(items[2]!),
    refundable_until: hex(items[3]!),
    oidc_key_registry: { inner: hex(items[4]!) },
    vkey_hash: hex(items[5]!),
    token_address: { inner: hex(items[6]!) },
  }
}
