import { deviceStorage } from "../platform/storage/rollupStorage"

/** The link a visitor arrived on. `ticket` is a payment link that pays for the account. */
export const CHANNELS = ["paylink", "ticket", "request_link", "pay_page", "invite", "none"] as const
export type Channel = (typeof CHANNELS)[number]

/** Where the visit came from: a known utm_source, else the referrer's site. */
export const TRAFFIC_SOURCES = [
  "email",
  "x-post",
  "x-ads",
  "search",
  "telegram",
  "discord",
  "reddit",
  "other",
  "direct",
] as const
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number]

export type Attribution = { channel: Channel; source: TrafficSource }

const NO_ATTRIBUTION: Attribution = { channel: "none", source: "direct" }

const REFERRER_SOURCES: readonly [TrafficSource, RegExp][] = [
  ["x-post", /^((www|mobile)\.)?(x|twitter)\.com$|^t\.co$/],
  ["search", /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.brave\.com|yahoo\.com)$/],
  ["telegram", /(^|\.)(t\.me|telegram\.org|telegram\.me)$/],
  ["discord", /(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/],
  ["reddit", /(^|\.)reddit\.com$/],
]
/** zk.money's own hosts hand a visit on; they are not where it came from. */
const OWN_HOST = /(^|\.)zk\.money$|^localhost$/

function isTagged(value: string | null): value is Exclude<TrafficSource, "direct"> {
  return value !== "direct" && (TRAFFIC_SOURCES as readonly (string | null)[]).includes(value)
}

function referrerHost(referrer: string): string | undefined {
  try {
    return new URL(referrer).hostname
  } catch {
    return undefined
  }
}

function referrerSource(host: string | undefined): TrafficSource {
  if (!host || OWN_HOST.test(host)) return "direct"
  return REFERRER_SOURCES.find(([, pattern]) => pattern.test(host))?.[0] ?? "other"
}

function channelOf(url: URL): Channel {
  const path = url.pathname.replace(/\/+$/, "")
  if (path === "/link" || path === "/p") return "paylink"
  if (path === "/request" || path === "/r") return "request_link"
  if (path.startsWith("/pay/")) return "pay_page"
  if (url.searchParams.has("invite")) return "invite"
  return "none"
}

/**
 * The link from the path, the source from a known utm_source, else the referrer. An unknown
 * utm_source is still a tagged visit, so it counts as `other`. `ref` is the referrer's host as a
 * hop that became the referrer saw it (paylink-web). Only the resolved values leave this function.
 */
export function attribution(href: string, referrer: string): Attribution {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return NO_ATTRIBUTION
  }
  const utm = url.searchParams.get("utm_source")
  const host = url.searchParams.get("ref") || referrerHost(referrer)
  const source = isTagged(utm) ? utm : utm && utm !== "direct" ? "other" : referrerSource(host)
  return { channel: channelOf(url), source }
}

const STORAGE_KEY = "webwallet.attribution"
/** A visit within this long of the last tagged one keeps its channel and source. */
export const ATTRIBUTION_TTL_MS = 60 * 60 * 1000

function readStored(now: number): Attribution {
  try {
    const raw = deviceStorage.getItem(STORAGE_KEY)
    if (!raw) return NO_ATTRIBUTION
    const { channel, source, at } = JSON.parse(raw) as Attribution & { at: number }
    if (!(now - at < ATTRIBUTION_TTL_MS)) return NO_ATTRIBUTION
    if (!CHANNELS.includes(channel) || !TRAFFIC_SOURCES.includes(source)) return NO_ATTRIBUTION
    return { channel, source }
  } catch {
    return NO_ATTRIBUTION
  }
}

function store(value: Attribution, now: number): void {
  try {
    deviceStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, at: now }))
  } catch {
    // Unstored attribution lasts the page.
  }
}

let landing: Attribution = NO_ATTRIBUTION

/**
 * Runs once before routing, which can drop the landing URL's query on a redirect. Each field this
 * visit leaves untagged keeps the value from a visit in the last hour, so a reload or a second tab
 * stays attributed.
 */
export function captureLandingSource(now = Date.now()): void {
  const current = attribution(window.location.href, document.referrer)
  const stored = readStored(now)
  landing = {
    channel: current.channel !== "none" ? current.channel : stored.channel,
    source: current.source !== "direct" ? current.source : stored.source,
  }
  // Only a tagged visit restarts the hour; untagged visits read it without extending it.
  if (current.channel !== "none" || current.source !== "direct") store(landing, now)
}

export function landingAttribution(): Attribution {
  return landing
}

/** A payment link turned out to pay for the account. */
export function markTicketChannel(now = Date.now()): void {
  landing = { ...landing, channel: "ticket" }
  store(landing, now)
}

/** True the first time `name` is asked for in this tab; tabs without storage answer true per page. */
const askedThisPage = new Set<string>()
export function firstInTab(name: string): boolean {
  const key = `zkm.once.${name}`
  try {
    if (sessionStorage.getItem(key)) return false
    sessionStorage.setItem(key, "1")
    return true
  } catch {
    if (askedThisPage.has(key)) return false
    askedThisPage.add(key)
    return true
  }
}
