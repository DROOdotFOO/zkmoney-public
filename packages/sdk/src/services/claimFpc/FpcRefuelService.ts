/**
 * Permissionless ClaimFPC top-up: after a wallet's own L2 ops, check the FPC's fee-juice balance
 * and, below a threshold, consume one in-flight skim-funding message via the FPC's `refuel`
 * entrypoint. The FPC pays for the tx out of the claimed amount itself (`claim_and_end_setup`),
 * so this needs no user account, no signature, and no FPC balance.
 *
 * Everything is recoverable from chain + the FPC's own config: candidate messages come from the
 * canonical FeeJuicePortal's `DepositToAztecPublic` L1 logs filtered by recipient, and the claim
 * secret is public (oxide's `PORTAL_CONSTANT_SECRET`, mirrored in `config.claim_secret`). Losing a claim race to
 * another wallet is the expected common case and costs only local proving time — the duplicate
 * message nullifier drops the tx before any fee is charged.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { computeFeeJuiceMessageNullifier } from "@aztec-labs/stdlib/messaging"
import { computeSecretHash, siloNullifier } from "@aztec-labs/stdlib/hash"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import { createLogger } from "@aztec-labs/foundation/log"
import { parseAbiItem, type PublicClient } from "viem"
import { ensureContractRegisteredInPXE } from "@obsidion/contracts"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"
import { claimFpcRefuelFee } from "../../feePaymentMethod/claimFpc/claimFpcRefuel.js"

const log = createLogger("wallet-sdk:fpc-refuel")

const DEPOSIT_TO_AZTEC_PUBLIC = parseAbiItem(
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
)

/** The FPC to top up. Resolved lazily per attempt so registry redeploys are picked up. */
export interface FpcRefuelTarget {
  address: AztecAddress
  artifact: ContractArtifact
}

export interface FpcRefuelOptions {
  /** Fee-juice balance (wei) below which a refuel is attempted. */
  threshold: bigint
  /** How far back to scan the portal's L1 logs for candidate deposits. */
  l1ScanBlocks?: bigint
  /** Minimum spacing between attempts; bursts of user txs share one check. */
  cooldownMs?: number
}

/**
 * Fire-and-forget from the post-tx tail of a sponsored flow, strictly AFTER the primary
 * `sendTx` promise settles — the wallet serializes local proving, so a refuel started earlier
 * would throw `LocalProvingInFlight` (and a user tx started while a refuel proves would hit the
 * same; the cooldown plus the few-second refuel proof keep that window small).
 */
export class FpcRefuelService {
  private readonly threshold: bigint
  private readonly l1ScanBlocks: bigint
  private readonly cooldownMs: number
  private lastAttemptMs = 0
  private inflight = false

  constructor(
    private readonly wallet: ObsidionWallet,
    private readonly node: AztecNode,
    private readonly resolveFpc: () => Promise<FpcRefuelTarget | undefined>,
    private readonly l1: PublicClient,
    options: FpcRefuelOptions,
  ) {
    this.threshold = options.threshold
    this.l1ScanBlocks = options.l1ScanBlocks ?? 50_000n
    this.cooldownMs = options.cooldownMs ?? 60_000
  }

  /**
   * Never throws; a refuel is opportunistic and must not surface into the user's flow.
   * `target` overrides the constructor resolver — each portal generation's L1 funder deposits to
   * its own FPC, so a flow sponsored by a retired-generation FPC refuels THAT instance.
   */
  async maybeRefuel(target?: FpcRefuelTarget): Promise<void> {
    if (this.inflight || Date.now() - this.lastAttemptMs < this.cooldownMs) return
    this.inflight = true
    this.lastAttemptMs = Date.now()
    try {
      await this.checkAndRefuel(target)
    } catch (error) {
      log.warn(`refuel attempt failed: ${error}`)
    } finally {
      this.inflight = false
    }
  }

  private async checkAndRefuel(target?: FpcRefuelTarget): Promise<void> {
    const fpc = target ?? (await this.resolveFpc())
    if (!fpc) return

    const balance = await this.feeJuiceBalance(fpc.address)
    if (balance >= this.threshold) return
    log.info(`ClaimFPC fee juice ${balance} below ${this.threshold}, scanning for skim deposits`)

    const candidate = await this.findClaimableDeposit(fpc)
    if (!candidate) {
      log.info("no claimable skim deposit in flight")
      return
    }

    await ensureContractRegisteredInPXE(this.wallet.pxe, this.wallet.node, fpc.address, () =>
      Promise.resolve(fpc.artifact),
    )
    const contract = Contract.at(fpc.address, fpc.artifact, this.wallet)
    const requested = await contract.methods.refuel!(
      candidate.amount,
      candidate.leafIndex,
    ).request()
    // Declare the FPC as feePayer (it set_as_fee_payer()s in-circuit) so no wallet default
    // payment method gets merged in — a NO_FROM entrypoint payload must stay a single call.
    const payload = new ExecutionPayload(
      requested.calls,
      requested.authWitnesses,
      requested.capsules,
      requested.extraHashedArgs,
      fpc.address,
    )
    await this.wallet.sendTx(payload, {
      from: NO_FROM,
      fee: claimFpcRefuelFee(),
      wait: NO_WAIT,
    })
    log.info(`refuel submitted: ${candidate.amount} fee juice (leaf ${candidate.leafIndex})`)
  }

  private async feeJuiceBalance(owner: AztecAddress): Promise<bigint> {
    const { feeJuice } = await this.node.getProtocolContractAddresses()
    // Imported on use: the module parses the whole FeeJuice artifact when it loads.
    const { computeFeePayerBalanceStorageSlot } = await import(
      "@aztec-labs/protocol-contracts/fee-juice"
    )
    const slot = await computeFeePayerBalanceStorageSlot(owner)
    return (await this.node.getPublicStorageAt("latest", feeJuice, slot)).toBigInt()
  }

  /** Oldest ripe, unconsumed portal deposit addressed to the FPC within the scan window. */
  private async findClaimableDeposit(
    fpc: FpcRefuelTarget,
  ): Promise<{ amount: bigint; leafIndex: bigint } | undefined> {
    const nodeInfo = await this.node.getNodeInfo()
    const portal = nodeInfo.l1ContractAddresses.feeJuicePortalAddress
    const latest = await this.l1.getBlockNumber()
    const logs = await this.l1.getLogs({
      address: portal.toString() as `0x${string}`,
      event: DEPOSIT_TO_AZTEC_PUBLIC,
      args: { to: fpc.address.toString() as `0x${string}` },
      fromBlock: latest > this.l1ScanBlocks ? latest - this.l1ScanBlocks : 0n,
      toBlock: latest,
    })
    if (logs.length === 0) return undefined

    // The consumption nullifier needs the secret preimage; it is public and pinned in the FPC's
    // own config, so chain state is the only source this reads.
    const secret = await this.claimSecret(fpc)
    // Only skim deposits carry the config secret's hash; admin funding bridges to the same
    // address with one-off secrets, and refuel can never consume those.
    const skimSecretHash = (await computeSecretHash(secret)).toString().toLowerCase()
    const { feeJuice } = await this.node.getProtocolContractAddresses()

    for (const entry of logs) {
      const { amount, key, index, secretHash } = entry.args
      if (amount === undefined || key === undefined || index === undefined) continue
      if (secretHash?.toLowerCase() !== skimSecretHash) continue
      const messageHash = Fr.fromHexString(key)
      if (!(await isL1ToL2MessageReady(this.node, messageHash))) continue
      // The tree holds the nullifier siloed by the consuming contract (the canonical FeeJuice).
      const nullifier = await siloNullifier(
        feeJuice,
        await computeFeeJuiceMessageNullifier(messageHash, secret),
      )
      const consumed = await this.node.getNullifierMembershipWitness("latest", nullifier)
      if (consumed !== undefined) continue
      return { amount, leafIndex: index }
    }
    return undefined
  }

  private async claimSecret(fpc: FpcRefuelTarget): Promise<Fr> {
    const contract = Contract.at(fpc.address, fpc.artifact, this.wallet)
    // Utility read of public state; `from` only scopes note views, and this reads none.
    const sim = await contract.methods.get_config!().simulate({ from: NO_FROM })
    const config = sim.result as { claim_secret: bigint }
    return new Fr(config.claim_secret)
  }
}
