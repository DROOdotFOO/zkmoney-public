import { useCallback, useEffect, useState } from "react"
import { erc20Abi, formatUnits, type Address } from "viem"
import { MAINNET_CHAIN_ID } from "@oxide/l1-contracts"
import {
  bridgeByToken,
  SIPA_INTENT_NAMES,
  type OxideTableRow,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import { depositRows, depositTokenRoutes, type SipaFundingToken } from "@obsidion/front-core"
import { readSipaPortalTerms, sipaIntentOf } from "@obsidion/sdk"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { isDemoMode } from "../../dev/demoFlag"
import { getDeploymentTable, getOxideDeployment, l1PublicClient } from "../../config/oxideTuple"
import daiIcon from "../../assets/deposit/dai.svg"
import usdcIcon from "../../assets/deposit/USDCToken.svg"
import usdtIcon from "../../assets/deposit/USDTToken.svg"
import testIcon from "../../assets/deposit/ethereum.webp"

export interface DepositTokenOption {
  address: Address
  symbol: string
  decimals: number
  icon: string
  /** The row's token: what the sweep deposits and the row's portal holds. */
  settlesIn: Address
  /** The SIPA swaps this token into `settlesIn` before it deposits (mainnet USDC and USDT). */
  swapped: boolean
}

/** What a SIPA of the pinned table accepts for one intent. */
export interface DepositTokens {
  /** Every row's tokens, product rows included: what a sweep, a recovery or a record's lookup reads. Picker order. */
  options: DepositTokenOption[]
  /** Main's tokens: what the deposit, funding, request and limits surfaces offer. Picker order. */
  offered: DepositTokenOption[]
  /** The default pick: the pinned bridge's token for a deposit, the fee token for a registration. */
  settlement: DepositTokenOption
}

/** Icons by symbol; any other token shows the generic one. */
const ICONS: Record<string, string> = { DAI: daiIcon, USDC: usdcIcon, USDT: usdtIcon }

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The option a picked token settles in: itself, or the row token it swaps into. */
export function settlementOf(tokens: DepositTokens, token: DepositTokenOption): DepositTokenOption {
  return tokens.options.find((t) => sameAddress(t.address, token.settlesIn)) ?? tokens.settlement
}

const metadata = new Map<string, Promise<{ symbol: string; decimals: number }>>()

/** A token's ERC-20 symbol and decimals, read once per token: both are immutable. */
export function tokenMetadata(
  config: WebWalletConfig,
  token: Address,
): Promise<{ symbol: string; decimals: number }> {
  const key = `${config.l1ChainId}:${token.toLowerCase()}`
  let read = metadata.get(key)
  if (!read) {
    const client = l1PublicClient(config)
    read = Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]).then(([symbol, decimals]) => ({ symbol, decimals }))
    metadata.set(key, read)
    read.catch(() => {
      if (metadata.get(key) === read) metadata.delete(key)
    })
  }
  return read
}

/** The chain whose SIPA swap rule applies. A dev demo shows the mainnet shape on any chain. */
function swapChainId(config: WebWalletConfig): bigint {
  return import.meta.env.DEV && isDemoMode() ? MAINNET_CHAIN_ID : BigInt(config.l1ChainId)
}

/**
 * Every token a SIPA of the pinned table accepts for `intent`, read off the table's rows, and the ones Main offers. The
 * profile's `assets` only name and order the rows they match by portal: a row the profile omits is still listed, after
 * the named ones, and an asset with no row adds nothing.
 */
export async function loadDepositTokens(
  config: WebWalletConfig = getConfig(),
  intent: SipaIntentName = "deposit",
): Promise<DepositTokens> {
  const [{ pinned }, table] = await Promise.all([
    getOxideDeployment(config),
    getDeploymentTable(config),
  ])
  const routes = depositTokenRoutes(table, swapChainId(config), intent)
  if (routes.length === 0) {
    throw new Error(`The forwarding table routes no ${intent} sweep of any token`)
  }
  const rank = (row: OxideTableRow) => {
    const listed = config.assets.findIndex((asset) => sameAddress(asset.portal, row.bridge.portal))
    return listed === -1 ? config.assets.length + table.rows.indexOf(row) : listed
  }
  const ordered = [...routes].sort((a, b) => rank(a.row) - rank(b.row))
  const options = await Promise.all(
    ordered.map(async (route): Promise<DepositTokenOption> => {
      const read = await tokenMetadata(config, route.token)
      const named = route.swapped
        ? undefined
        : config.assets.find((asset) => sameAddress(asset.portal, route.row.bridge.portal))
      const symbol = named?.symbol ?? read.symbol
      return {
        address: route.token,
        symbol,
        decimals: read.decimals,
        icon: ICONS[symbol] ?? testIcon,
        settlesIn: route.row.bridge.underlying as Address,
        swapped: route.swapped,
      }
    }),
  )
  const main = new Set(depositRows(table).main)
  const offered = options.filter((_, i) => main.has(ordered[i]!.row))
  const settles = intent === "deposit" ? pinned.underlying : table.deployment.feeToken
  const settlement =
    options.find((t) => !t.swapped && settles && sameAddress(t.address, settles)) ?? options[0]!
  return { options, offered, settlement }
}

/** How long a mounted reader waits before it reads the accepted tokens again after a failure. */
export const DEPOSIT_TOKENS_RETRY_MS = 5_000

/** A component's read of the accepted tokens. */
export interface DepositTokensRead {
  /** Undefined until read. */
  tokens?: DepositTokens
  /** The last read failed and none has landed since. A failed read is retried while mounted. */
  failed: boolean
  /** Reads again now. */
  retry: () => void
}

/** {@link loadDepositTokens} for a component, with its loading and failure states. */
export function useDepositTokensRead(
  intent: SipaIntentName = "deposit",
  load: (intent: SipaIntentName) => Promise<DepositTokens> = (i) =>
    loadDepositTokens(getConfig(), i),
): DepositTokensRead {
  // Each result names its intent: one read for another intent is never this one's.
  const [read, setRead] = useState<{ intent: SipaIntentName; tokens: DepositTokens }>()
  const [failedFor, setFailedFor] = useState<SipaIntentName>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = () =>
      load(intent).then(
        (tokens) => {
          if (!live) return
          setRead({ intent, tokens })
          setFailedFor(undefined)
        },
        (err: unknown) => {
          console.warn("[deposit] accepted tokens unavailable:", err)
          if (!live) return
          setFailedFor(intent)
          timer = setTimeout(next, DEPOSIT_TOKENS_RETRY_MS)
        },
      )
    void next()
    return () => {
      live = false
      clearTimeout(timer)
    }
    // The loader is fixed for the caller's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, attempt])
  const retry = useCallback(() => {
    setFailedFor(undefined)
    setAttempt((n) => n + 1)
  }, [])
  return {
    tokens: read?.intent === intent ? read.tokens : undefined,
    failed: failedFor === intent,
    retry,
  }
}

/** {@link loadDepositTokens} for a component; undefined until read. A failed read is retried while mounted. */
export function useDepositTokens(intent: SipaIntentName = "deposit"): DepositTokens | undefined {
  return useDepositTokensRead(intent).tokens
}

/**
 * What a deposit of `token` credits. A row's own token credits its L2 asset one to one, less the row fee; a token the
 * SIPA swaps credits `settlement`, its row's token, at the market rate.
 */
export function depositCreditNote(
  token: DepositTokenOption,
  settlement: DepositTokenOption,
): string {
  return token.swapped
    ? `${token.symbol} is swapped to ${settlement.symbol} at the market rate, so the ${settlement.symbol} credited can differ.`
    : `Each ${token.symbol} you send is credited as 1 ${token.symbol}, less the fee.`
}

/** The tokens of `tokens`, `head` first. */
export function fundingTokensFrom(
  tokens: Pick<DepositTokens, "options">,
  head: SipaFundingToken,
): [SipaFundingToken, ...SipaFundingToken[]] {
  return [
    head,
    ...tokens.options.flatMap(({ address, symbol, decimals }) =>
      sameAddress(address, head.address) ? [] : [{ address, symbol, decimals }],
    ),
  ]
}

/**
 * Every token a SIPA for `intent` may be funded with, `head` first. `head` names its symbol and decimals when the
 * caller knows them; otherwise the table's listing does.
 */
export async function sipaFundingTokens(
  config: WebWalletConfig,
  head: Address | SipaFundingToken,
  intent: SipaIntentName = "deposit",
): Promise<[SipaFundingToken, ...SipaFundingToken[]]> {
  const tokens = await loadDepositTokens(config, intent)
  if (typeof head !== "string") return fundingTokensFrom(tokens, head)
  const listed = tokens.options.find((t) => sameAddress(t.address, head))
  const decimals = listed?.decimals ?? (await tokenMetadata(config, head)).decimals
  return fundingTokensFrom(tokens, { address: head, symbol: listed?.symbol ?? "", decimals })
}

/**
 * Every token a SIPA of the pinned table accepts for any intent, `head` first: what a recovery probes an address for.
 * Without the table it is `head` alone, so a recovery still moves the token it names.
 */
export async function recoveryProbeTokens(
  config: WebWalletConfig,
  head: Address,
): Promise<[SipaFundingToken, ...SipaFundingToken[]]> {
  const reads = await Promise.allSettled(
    SIPA_INTENT_NAMES.map((intent) => loadDepositTokens(config, intent)),
  )
  const options: DepositTokenOption[] = []
  for (const read of reads) {
    if (read.status === "rejected")
      console.warn("[recovery] accepted tokens unavailable:", read.reason)
    else
      for (const option of read.value.options)
        if (!options.some((t) => sameAddress(t.address, option.address))) options.push(option)
  }
  const listed = options.find((t) => sameAddress(t.address, head))
  const decimals = listed?.decimals ?? (await tokenMetadata(config, head)).decimals
  return fundingTokensFrom({ options }, { address: head, symbol: listed?.symbol ?? "", decimals })
}

/** What the deposit screen quotes for one picked token: its row's fee and cap, and the row's token. */
export interface DepositDisplayFacts {
  /** The quoted fee, display units of the row's token. */
  fee: string
  /** The row's token. */
  token: Address
  /** The row's sweep fee, base units. */
  sweepFeeAtomic: bigint
  /** The row's portal `TX_AMOUNT_CAP()`, base units. */
  txAmountCap: bigint
}

/**
 * Quote a deposit of `token`: the sweep fee and the cap of the row it settles on, read fresh off that row alone. The
 * fee is stamped on the record a deposit creates, so the detail sheet can reproduce it.
 */
export async function loadDepositDisplayFacts(
  token?: Pick<DepositTokenOption, "settlesIn">,
  intent: SipaIntentName = "deposit",
): Promise<DepositDisplayFacts> {
  const config = getConfig()
  const { deployment, pinned } = await getOxideDeployment(config)
  const settlesIn = (token?.settlesIn ?? pinned.underlying) as Address
  const bridge = bridgeByToken(deployment, settlesIn)
  if (!bridge || !deployment.forwardingTable) {
    throw new Error(`The deployment has no ${intent} row for ${settlesIn}`)
  }
  const [terms, { decimals }] = await Promise.all([
    readSipaPortalTerms(l1PublicClient(config), {
      forwardingTable: deployment.forwardingTable as Address,
      token: settlesIn,
      intent: sipaIntentOf(intent),
    }),
    tokenMetadata(config, settlesIn),
  ])
  if (!sameAddress(terms.portal, bridge.portal)) {
    throw new Error(`The forwarding table routes ${settlesIn} to ${terms.portal}, not its bridge`)
  }
  return {
    fee: formatUnits(terms.depositFee, decimals),
    token: settlesIn,
    sweepFeeAtomic: terms.depositFee,
    txAmountCap: terms.txAmountCap,
  }
}

/** The symbol a funding in `token` settles in; `fallback` until the tokens are read, or for a token the table omits. */
export function settlementSymbol(
  tokens: DepositTokens | undefined,
  token: string | undefined,
  fallback: string,
): string {
  const funded = token && tokens?.options.find((t) => sameAddress(t.address, token))
  return funded && tokens ? settlementOf(tokens, funded).symbol : fallback
}

/**
 * The row token a funding in `token` settles on: the pinned bridge's for a record that predates token tracking.
 * Undefined until read, or for a token the table omits.
 */
export function settlementToken(
  tokens: DepositTokens | undefined,
  token: string | undefined,
): Address | undefined {
  if (!token) return tokens?.settlement.settlesIn
  return tokens?.options.find((t) => sameAddress(t.address, token))?.settlesIn
}

/** The decimals of the row a funding in `token` settles on: the units of its record's amounts. */
export function settlementDecimals(
  tokens: DepositTokens | undefined,
  token: string | undefined,
): number | undefined {
  if (!tokens) return undefined
  const funded = token
    ? tokens.options.find((t) => sameAddress(t.address, token))
    : tokens.settlement
  return funded && settlementOf(tokens, funded).decimals
}
