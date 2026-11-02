import type { Account } from "@aztec-labs/aztec.js/account"
import type { TxReceipt } from "@aztec-labs/stdlib/tx"
import { getSponsoredFeePaymentMethod } from "../feePaymentMethod/index.js"
import type { FeeJuiceContract } from "@aztec-labs/aztec.js/protocol"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ObsidionWallet } from "../obsidion/ObsidionWallet.js"
import type { SendInteractionOptions, TxSendResultMined } from "@aztec-labs/aztec.js/contracts"
import { sha256 } from "@aztec-labs/foundation/crypto/sha256"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Gas, GasFees, GasSettings } from "@aztec-labs/stdlib/gas"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import { retryUntil } from "@aztec-labs/foundation/retry"
import { createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client"
import { AZTEC_NODE_URL } from "@obsidion/core/constants"

/**
 * The fee a new tx must actually cover to be admitted. `getCurrentMinFees` is only the
 * fee floor; under accumulated excess mana the block base fee sits well above it, and the
 * sequencer drops any tx priced below the base fee at inclusion (surfacing as "Tx dropped by
 * P2P node" / "Insufficient fee per gas"). Returns max(floor, latest block base fee) per
 * dimension so callers price against reality, not the floor.
 */
export async function getBlockBaseMaxFees(node: AztecNode): Promise<GasFees> {
  const minFees = await node.getCurrentMinFees()
  const blockFees = (await node.getBlockData("latest"))?.header.globalVariables.gasFees
  if (!blockFees) return minFees
  return new GasFees(
    minFees.feePerDaGas > blockFees.feePerDaGas ? minFees.feePerDaGas : blockFees.feePerDaGas,
    minFees.feePerL2Gas > blockFees.feePerL2Gas ? minFees.feePerL2Gas : blockFees.feePerL2Gas,
  )
}

/**
 * Helper method to create an async transaction with immediate hash and delayed completion.
 *
 * @param initFn Function that initializes and sends the transaction
 * @param waitFn Function that processes the transaction result after waiting
 * @returns Object with txPromise, txHash, and sentTx promises
 */
export const createAsyncTransaction = <T, R>(
  initFn: () => Promise<T & { txHash: string }>,
  waitFn: (result: T & { txHash: string }) => Promise<R>,
): {
  txPromise: Promise<R>
  txHash: Promise<string>
  sentTx: Promise<T & { txHash: string }>
} => {
  // Execute initialization once and store result
  const initPromise = initFn()

  // Chain the promises for the full result
  const promiseChain = initPromise.then(waitFn)

  // Create txHash promise from initPromise
  const txHashPromise = initPromise.then((result) => result.txHash)

  // Mark txHash as handled to prevent unhandled rejection warnings
  // when initPromise fails - the error will still be propagated through txPromise
  txHashPromise.catch(() => {})

  // `sentTx` exposes the full send-time result.
  const sentTxPromise = initPromise.then((result) => result)
  sentTxPromise.catch(() => {})

  // Return the three promises
  return {
    txPromise: promiseChain,
    txHash: txHashPromise,
    sentTx: sentTxPromise,
  }
}

// Example: ciphertext: Fr[]
export function frArrayToBase64(ciphertext: Fr[]): string {
  const bytes = Buffer.concat(
    ciphertext.map(
      (fr) => Buffer.from(fr.toBuffer()), // Aztec Fr is already 32 bytes BE
    ),
  )
  return bytes.toString("base64")
}

export function base64ToFrArray(base64: string): Fr[] {
  const bytes = Buffer.from(base64, "base64")

  if (bytes.length % 32 !== 0) {
    throw new Error("Invalid ciphertext length")
  }

  const frs: Fr[] = []

  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = bytes.slice(i, i + 32)
    frs.push(Fr.fromBuffer(chunk))
  }

  return frs
}

// Helper function to process a batch of addresses with a given processor function
export const processBatch = async <T, R>(
  batch: T[],
  processor: (item: T) => Promise<R>,
  batchNumber?: number,
): Promise<R[]> => {
  const results = await Promise.all(batch.map(processor))
  if (batchNumber !== undefined) {
    console.log(`Batch ${batchNumber} processing completed`)
  }
  return results
}

export const isValidBool = (response: Fr[][]): boolean => {
  if (
    response.toString() === "0x0000000000000000000000000000000000000000000000000000000000000001"
  ) {
    return true
  } else {
    return false
  }
}

/** Per wallet: a handle sends through the wallet, and so the node, it is bound to. */
const feeJuiceContracts = new WeakMap<ObsidionWallet, FeeJuiceContract>()

// `null` means intentionally omit an external fee payer and let the account pay
// with its existing fee juice balance.
export type EmptyTxFeePaymentMethod = FeePaymentMethod | null

export const sendEmptyTx = async (
  wallet: ObsidionWallet,
  account: Account,
  feePaymentMethod?: EmptyTxFeePaymentMethod,
): Promise<TxSendResultMined<TxReceipt>> => {
  console.log("sendEmptyTx...")

  let feeJuiceContract = feeJuiceContracts.get(wallet)
  if (!feeJuiceContract) {
    // Lazy: keeps the ~1MB FeeJuice artifact out of the entry chunk.
    const { FeeJuiceContract } = await import("@aztec-labs/aztec.js/protocol")
    feeJuiceContract = FeeJuiceContract.withWallet(wallet)
    feeJuiceContracts.set(wallet, feeJuiceContract)
  }

  const sendOptions: SendInteractionOptions = {
    from: account.getAddress(),
  }

  const { txsLimits } = await wallet.node.getNodeInfo()
  const gasSettings = GasSettings.fallback({
    maxFeesPerGas: await getBlockBaseMaxFees(wallet.node),
    gasLimits: Gas.from(txsLimits.gas),
  })

  if (feePaymentMethod === null) {
    sendOptions.fee = { gasSettings }
  } else {
    const paymentMethod = feePaymentMethod ?? (await getSponsoredFeePaymentMethod(wallet.pxe))
    sendOptions.fee = {
      paymentMethod,
      gasSettings: paymentMethod.getGasSettings() ?? gasSettings,
    }
  }

  return await feeJuiceContract.methods.check_balance(0n).send(sendOptions)
}

export const sendEmptyTxs = async (
  wallet: ObsidionWallet,
  account: Account,
  count: number,
  feePaymentMethod?: EmptyTxFeePaymentMethod,
) => {
  for (let i = 0; i < count; i++) {
    const currentBlock = await wallet.node.getBlockNumber()
    await sendEmptyTx(wallet, account, feePaymentMethod)

    // Wait for block to increment
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 500)) // Wait 0.5 seconds
      const newBlock = await wallet.node.getBlockNumber()
      if (newBlock > currentBlock) {
        break
      }
    }
  }
}

const WARP_SLOT_TAKEN = /is expired: L1 synced to/

type SandboxWarpOptions = { timeoutSeconds?: number; nodeUrl?: string }

const ignoreLostSlot = (error: Error) => {
  if (!WARP_SLOT_TAKEN.test(error.message)) throw error
}

async function warpSandboxUntil(
  ready: () => Promise<boolean>,
  description: string,
  options?: SandboxWarpOptions,
): Promise<void> {
  const debug = createAztecNodeDebugClient(options?.nodeUrl ?? AZTEC_NODE_URL)
  await retryUntil(
    async () => {
      if (await ready()) return true
      await debug.warpL2TimeAtLeastBy(1).catch(ignoreLostSlot)
      return undefined
    },
    description,
    options?.timeoutSeconds ?? 300,
    1,
  )
}

/**
 * Sandbox-only: advance blocks until an L1→L2 inbox message is consumable.
 *
 * Each block comes from the local network's debug RPC: no tx, no key, no client-side proving.
 * Pass `nodeUrl` when `node` is not the default sandbox node.
 */
export async function waitForSandboxL1ToL2Message(
  node: AztecNode,
  messageHash: Fr,
  options?: SandboxWarpOptions,
): Promise<void> {
  await warpSandboxUntil(
    () => isL1ToL2MessageReady(node, messageHash),
    `L1→L2 message ${messageHash}`,
    options,
  )
}

export async function warpSandboxTimeTo(
  node: AztecNode,
  timestamp: number,
  options?: SandboxWarpOptions,
): Promise<void> {
  await createAztecNodeDebugClient(options?.nodeUrl ?? AZTEC_NODE_URL)
    .warpL2TimeAtLeastTo(timestamp)
    .catch(ignoreLostSlot)
  await warpSandboxUntil(
    async () => {
      const latest = (await node.getBlockData("latest"))?.header.globalVariables.timestamp
      return latest !== undefined && latest >= BigInt(timestamp)
    },
    `L2 time ${timestamp}`,
    options,
  )
}

/**
 * Retry a transaction wait operation multiple times with configurable options
 * @param fn The function to retry that returns a promise
 * @param options Configuration options including number of retries, delay between retries, etc.
 * @returns The result of the successful function call or undefined if all retries fail
 */
export const retryTransactionWait = async <T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number
    delayMs?: number
    onError?: (error: any, attempt: number) => void
    onRetry?: (attempt: number) => void
  } = {},
): Promise<T | undefined> => {
  const {
    maxRetries = 10,
    delayMs = 1000,
    onError = (error, attempt) => console.log(`Attempt ${attempt} failed:`, error),
    onRetry = (attempt) => console.log(`Retrying... Attempt ${attempt + 1}/${maxRetries}`),
  } = options

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      onError(error, attempt + 1)

      if (attempt < maxRetries - 1) {
        onRetry(attempt)
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }
  }

  return undefined
}

// Checks `window`, not `process`: browser bundles polyfill `process`.
export const isNodeJS = () => !("window" in globalThis)

/**
 * Hash encrypted data and truncate to 112 bits (14 bytes)
 * @param encryptedData - Encrypted data to hash
 * @returns Truncated hash as hex string
 */
export function hashAndTruncate(encryptedData: Buffer): string {
  const hash = sha256(encryptedData)
  // Truncate to 112 bits (14 bytes)
  const truncated = hash.subarray(0, 14)
  return truncated.toString("hex")
}

/** The L2 anchor day the FPC checks freshness against — chain time, never the browser clock. */
export async function chainEpochDay(wallet: ObsidionWallet): Promise<number> {
  const block = await wallet.node.getBlock("latest" as never)
  if (!block) throw new Error("no L2 block — is the node running?")
  return epochDay(block.header.globalVariables.timestamp)
}

/** Days since epoch — the circuit's u32 `day`. Feed it the chain's anchor timestamp, not wall clock.
 * Shared by the paylink and SIPA services.
 */
export function epochDay(timestampSeconds: number | bigint): number {
  return Number(BigInt(timestampSeconds) / 86400n)
}
