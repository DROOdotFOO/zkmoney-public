import { AZTEC_NODE_URL, L1_RPC_URL as CORE_L1_RPC_URL } from "@obsidion/core/constants"
import type { PayLinkAsset } from "../../src/services/paylink/types.js"

export const SHARED_MUTABLE_DELAY_BLOCKS = 25 // 10 blocks == 360 secs
export const SANDBOX_URL = AZTEC_NODE_URL
export const L1_RPC_URL = process.env.SANDBOX_L1_RPC_URL || CORE_L1_RPC_URL.LOCAL
export const TIMEOUT = 300_000

export const DEFAULT_ACCOUNT_INDEX = 0
export const SENDER_ACCOUNT_INDEX = 1
export const RECEIVER_ACCOUNT_INDEX = 2
export const MINT_AMOUNT = 1000000000000000000n

export const TEST_TOKEN: PayLinkAsset = {
  name: "BOLD",
  symbol: "BOLD",
  address: "",
  decimals: 9,
}

export const TEST_TOKEN_TYPE = "BOLD"
