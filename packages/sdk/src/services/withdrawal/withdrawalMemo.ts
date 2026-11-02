/**
 * The memo a wallet withdrawal carries in its recovery data (oxide's `WithdrawOperation.recoveryMemo`), encrypted to
 * the owner. The recovery data names the L1 address the burn pays, but for a swap or a Sky savings move that is an
 * escrow, so the memo carries what the escrow address commits to. A fresh device then rebuilds the record, and with
 * it the escrow's run and recovery, from chain alone. A direct withdrawal carries an empty memo.
 *
 *   byte 0      format version (0x01)
 *   then        [type: u8][len: u8][value: len bytes] entries —
 *               0x01 swap route (1 byte, the escrow's `SwapRoute` id), 0x02 swap recipient (20 bytes),
 *               0x03 escrow factory (20 bytes), 0x04 recovery commitment (32 bytes), 0x05 escrow relayer tip,
 *               0x06 escrow nonce (32 bytes), 0x07 swap daiForGas, 0x08 swap minEthForGas, 0x09 Sky route
 *               (1 byte, the escrow's `SkyRoute`), 0x0a Sky recipient commitment (32 bytes). Amounts are
 *               uint256 in their fewest big-endian bytes; the gas entries are written only when nonzero.
 *
 * Decoding is total: any input yields a (possibly empty) memo, never a throw. A swap or a Sky move is reported only
 * when every entry it needs is present and well-formed. The values are what the wallet asserted at burn time;
 * `withdrawEventSource.ts` checks them against the escrow the burn paid before a reader trusts them.
 */

import { getAddress, isAddress, type Address, type Hex } from "viem"
import { SkyRoute } from "@oxide/experiments/sky/sky_savings.js"
import type { SwapEscrowOutput } from "@obsidion/core/types"
import { swapOutputForRoute, swapRouteForOutput } from "../../oxide/escrow/swapOnWithdraw.js"

const VERSION = 0x01
const TYPE_SWAP_ROUTE = 0x01
const TYPE_SWAP_RECIPIENT = 0x02
const TYPE_ESCROW_FACTORY = 0x03
const TYPE_RECOVERY_COMMITMENT = 0x04
const TYPE_RELAYER_TIP = 0x05
const TYPE_ESCROW_NONCE = 0x06
const TYPE_DAI_FOR_GAS = 0x07
const TYPE_MIN_ETH_FOR_GAS = 0x08
const TYPE_SKY_ROUTE = 0x09
const TYPE_RECIPIENT_COMMITMENT = 0x0a

const ADDRESS_LEN = 20
const WORD_LEN = 32
const ZERO_ADDRESS = `0x${"00".repeat(ADDRESS_LEN)}`

/** What a swap-on-withdraw's escrow address commits to. */
export interface SwapWithdrawalMemo {
  output: SwapEscrowOutput
  /** Where the swap output lands. */
  recipient: Address
  /** The `SwapEscrowFactory` the escrow address was derived from. */
  factory: Address
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
  /** DAI the escrow swaps to ETH for `recipient`. */
  daiForGas: bigint
  /** The least ETH the gas swap must pay. */
  minEthForGas: bigint
}

/** What a Sky savings move's escrow address commits to. */
export interface SkyWithdrawalMemo {
  route: SkyRoute
  /** The `SkyEscrowFactory` the escrow address was derived from. */
  factory: Address
  /** The secret hash of the deposit the escrow makes; the move's nonce derives its salt. */
  recipientCommitment: Hex
  recoveryCommitment: Hex
  relayerTip: bigint
  nonce: Hex
}

export interface WithdrawalMemo {
  swap?: SwapWithdrawalMemo
  sky?: SkyWithdrawalMemo
}

export function encodeWithdrawalMemo(memo: WithdrawalMemo): Buffer {
  if (memo.swap && memo.sky) throw new Error("A withdrawal memo names one escrow")
  const entries: Buffer[] = []
  const put = (type: number, value: Buffer) => {
    entries.push(Buffer.from([type, value.length]), value)
  }
  if (memo.swap) {
    const { swap } = memo
    put(TYPE_SWAP_ROUTE, Buffer.from([swapRouteForOutput(swap.output)]))
    put(TYPE_SWAP_RECIPIENT, addressBytes(swap.recipient, "recipient"))
    put(TYPE_ESCROW_FACTORY, addressBytes(swap.factory, "factory"))
    put(TYPE_RECOVERY_COMMITMENT, hexBytes(swap.recoveryCommitment, WORD_LEN, "recoveryCommitment"))
    put(TYPE_RELAYER_TIP, uintBytes(swap.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(swap.nonce, WORD_LEN, "nonce"))
    if (swap.daiForGas > 0n) put(TYPE_DAI_FOR_GAS, uintBytes(swap.daiForGas))
    if (swap.minEthForGas > 0n) put(TYPE_MIN_ETH_FOR_GAS, uintBytes(swap.minEthForGas))
  }
  if (memo.sky) {
    const { sky } = memo
    if (!isSkyRoute(sky.route))
      throw new Error(`withdrawal memo Sky route is unknown: ${sky.route}`)
    put(TYPE_SKY_ROUTE, Buffer.from([sky.route]))
    put(TYPE_ESCROW_FACTORY, addressBytes(sky.factory, "factory"))
    put(
      TYPE_RECIPIENT_COMMITMENT,
      hexBytes(sky.recipientCommitment, WORD_LEN, "recipientCommitment"),
    )
    put(TYPE_RECOVERY_COMMITMENT, hexBytes(sky.recoveryCommitment, WORD_LEN, "recoveryCommitment"))
    put(TYPE_RELAYER_TIP, uintBytes(sky.relayerTip))
    put(TYPE_ESCROW_NONCE, hexBytes(sky.nonce, WORD_LEN, "nonce"))
  }
  return entries.length ? Buffer.concat([Buffer.from([VERSION]), ...entries]) : Buffer.alloc(0)
}

/**
 * A wrong version, a truncated entry, a duplicate (the first wins) or a malformed value never throws. A swap missing
 * an entry, naming the zero address or a zero recovery commitment, or naming a route no output maps to decodes as no
 * swap. A Sky move likewise, and a Sky move beside a swap route decodes as neither.
 */
export function decodeWithdrawalMemo(memo: Buffer): WithdrawalMemo {
  if (memo[0] !== VERSION) return {}
  const values = new Map<number, Buffer>()
  for (let pos = 1; pos + 2 <= memo.length; ) {
    const type = memo[pos]!
    const end = pos + 2 + memo[pos + 1]!
    if (end > memo.length) break
    if (!values.has(type)) values.set(type, memo.subarray(pos + 2, end))
    pos = end
  }
  const value = (type: number, len?: number) => {
    const bytes = values.get(type)
    return bytes && (len === undefined || bytes.length === len) ? bytes : undefined
  }
  const uint = (type: number) => {
    const bytes = value(type)
    return bytes && bytes.length >= 1 && bytes.length <= WORD_LEN
      ? BigInt(`0x${bytes.toString("hex")}`)
      : undefined
  }
  const route = value(TYPE_SWAP_ROUTE, 1)
  const factory = nonZeroAddress(value(TYPE_ESCROW_FACTORY, ADDRESS_LEN))
  const recoveryCommitment = nonZeroHex(value(TYPE_RECOVERY_COMMITMENT, WORD_LEN))
  const relayerTip = uint(TYPE_RELAYER_TIP)
  const nonceBytes = value(TYPE_ESCROW_NONCE, WORD_LEN)
  const nonce = nonceBytes && (`0x${nonceBytes.toString("hex")}` as Hex)
  const escrow =
    factory && recoveryCommitment && relayerTip !== undefined && nonce
      ? { factory, recoveryCommitment, relayerTip, nonce }
      : undefined
  if (route) {
    const output = swapOutputForRoute(route[0]!)
    const recipient = nonZeroAddress(value(TYPE_SWAP_RECIPIENT, ADDRESS_LEN))
    if (!output || !recipient || !escrow) return {}
    const daiForGas = uint(TYPE_DAI_FOR_GAS) ?? 0n
    const minEthForGas = uint(TYPE_MIN_ETH_FOR_GAS) ?? 0n
    return { swap: { output, recipient, ...escrow, daiForGas, minEthForGas } }
  }
  const skyRoute = value(TYPE_SKY_ROUTE, 1)?.[0]
  const recipientCommitment = nonZeroHex(value(TYPE_RECIPIENT_COMMITMENT, WORD_LEN))
  if (skyRoute === undefined || !isSkyRoute(skyRoute) || !recipientCommitment || !escrow) return {}
  return { sky: { route: skyRoute, recipientCommitment, ...escrow } }
}

function isSkyRoute(route: number): route is SkyRoute {
  return route === SkyRoute.Stake || route === SkyRoute.Unstake
}

function nonZeroAddress(bytes: Buffer | undefined): Address | undefined {
  if (!bytes) return undefined
  const hex = `0x${bytes.toString("hex")}`
  return hex === ZERO_ADDRESS ? undefined : getAddress(hex)
}

function nonZeroHex(bytes: Buffer | undefined): Hex | undefined {
  return bytes?.some((byte) => byte !== 0) ? `0x${bytes.toString("hex")}` : undefined
}

function addressBytes(address: string, what: string): Buffer {
  if (!isAddress(address)) throw new Error(`withdrawal memo ${what} is not an address: ${address}`)
  return Buffer.from(address.slice(2), "hex")
}

/** `value` in its fewest big-endian bytes, at least one. */
function uintBytes(value: bigint): Buffer {
  if (value < 0n || value >= 1n << 256n)
    throw new Error(`withdrawal memo uint256 out of range: ${value}`)
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex")
}

function hexBytes(hex: string, len: number, what: string): Buffer {
  if (!new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(hex)) {
    throw new Error(`withdrawal memo ${what} must be ${len}-byte 0x-hex: ${hex}`)
  }
  return Buffer.from(hex.slice(2), "hex")
}
