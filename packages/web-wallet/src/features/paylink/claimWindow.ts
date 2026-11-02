/**
 * Recipient-side claim window on `/link`. `from_claimable` is not in the URL — it lives in the
 * escrow note (and on this device's create row). Compare against chain-tip seconds, never the wall
 * clock: the sandbox ticker and `Date.now()` routinely diverge.
 */

import { useEffect, useRef, useState } from "react"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { isPaylinkWindowNotOpenRevert, isPaylinkWindowRevert } from "@obsidion/front-core"
import type { LinkStatus, PaymentLink } from "./types"

/** A link that can no longer be claimed has nothing else to offer: its message is the whole page. */
export const CLOSED_LINK_COPY: Record<
  Exclude<LinkStatus, "unclaimed">,
  { title: string; caption: string }
> = {
  claimed: {
    title: "This link is no longer available",
    caption: "It has already been claimed or cancelled by the sender.",
  },
  expired: { title: "This link has expired", caption: "Ask the sender to send a new link." },
  retired: {
    title: "This link has been retired",
    caption:
      "It was made before the latest zk.money upgrade and can't be claimed. The funds go back to the sender when they upgrade.",
  },
}

/** One-line form of `CLOSED_LINK_COPY` for sheets over an open claim. */
export function closedLinkMessage(status: LinkStatus): string | undefined {
  if (status === "unclaimed") return undefined
  const { title, caption } = CLOSED_LINK_COPY[status]
  return `${title}. ${caption}`
}

export const LINK_STATUS_LABEL: Record<LinkStatus, string> = {
  unclaimed: "Unclaimed",
  claimed: "Claimed",
  expired: "Expired",
  retired: "Retired",
}

export const PAYLINK_NOT_CLAIMABLE_YET_MESSAGE =
  "This link isn't claimable yet. Try again in a moment."

/**
 * Seconds past `from_claimable` before the wallet offers a claim. The prompt reads the node tip, but the
 * claim proves against the block the PXE has synced to, which trails the tip; a claim taken at the
 * boundary was refused as not yet claimable.
 */
export const PAYLINK_CLAIM_MARGIN_SECONDS = 30
export const PAYLINK_WINDOW_MESSAGE =
  "The window for this action has closed. Refresh the link to see what it offers now."

/** The link at `chainNow`, by the contract's `is_past`. An unknown tip or window reads as open;
 *  the contract still refuses a late claim. */
export function withExpiry(link: PaymentLink, chainNow: number | undefined): PaymentLink {
  const past = link.claimableUntil != null && chainNow != null && chainNow > link.claimableUntil
  return link.status === "unclaimed" && past ? { ...link, status: "expired" } : link
}

/** Error-sheet copy for a claim the escrow's time gate refused; `undefined` for any other error. */
export function claimWindowRevertCopy(
  error: unknown,
): { title: string; message: string } | undefined {
  if (isPaylinkWindowNotOpenRevert(error))
    return { title: "Not claimable yet", message: PAYLINK_NOT_CLAIMABLE_YET_MESSAGE }
  // Expired at the window's end: waiting won't reopen it.
  if (isPaylinkWindowRevert(error))
    return { title: "Window closed", message: PAYLINK_WINDOW_MESSAGE }
}

/**
 * Seconds until a claim can be offered: 0 once the window plus the proving margin is open, and
 * `undefined` while either timestamp is unknown. Unknown is not open — a claim taken then is refused
 * by the chain.
 */
export function claimWaitSeconds(
  claimableFrom: number | undefined,
  chainNow: number | undefined,
): number | undefined {
  if (claimableFrom == null || chainNow == null) return undefined
  return Math.max(0, claimableFrom + PAYLINK_CLAIM_MARGIN_SECONDS - chainNow)
}

/** Remaining seconds as `m:ss`, or `h:mm:ss` once an hour has elapsed. */
export function formatClaimCountdown(remainingSec: number): string {
  const sec = Math.max(0, Math.floor(remainingSec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Slot boundaries are `genesis + k * slotDuration`, in Unix seconds on a live network. */
interface SlotGrid {
  genesis: number
  slotDuration: number
}

/**
 * Device-clock seconds until the block that opens a claim at chain time `target` lands. A block
 * carries its slot's start time and lands `lead` seconds before it, so the window opens with the
 * first slot at or after `target`.
 */
export function secondsToOpeningBlock(target: number, now: number, grid: SlotGrid, lead: number) {
  const slot = Math.ceil((target - grid.genesis) / grid.slotDuration)
  return Math.ceil(grid.genesis + slot * grid.slotDuration - lead - now)
}

/**
 * The countdown for a positive `claimWait`. Chain time moves a whole slot at a time, so the label
 * runs on the device clock toward the block that opens the window. Where chain time is not device
 * time (the sandbox warps it) the label steps with each block instead. The claim itself stays gated
 * on chain time.
 */
export function useClaimCountdown(
  claimWait: number | undefined,
  chainNow: number | undefined,
  node: AztecNode | undefined,
): string | undefined {
  const [grid, setGrid] = useState<SlotGrid>()
  useEffect(() => {
    if (!node) return
    let live = true
    Promise.resolve()
      .then(() => node.getL1Constants())
      .then(
        (c) => live && setGrid({ genesis: Number(c.l1GenesisTime), slotDuration: c.slotDuration }),
        () => {}, // No grid: the label steps with each block.
      )
    return () => {
      live = false
    }
  }, [node])

  // How far ahead of the device clock a block's timestamp is when it lands. Measured on a block seen
  // arriving, never on the first read, which may be of a block that landed a slot ago; the label
  // says "about" until then.
  const [lead, setLead] = useState<number>()
  const firstRead = useRef<number>(undefined)
  useEffect(() => {
    if (chainNow === undefined) return
    if (firstRead.current === undefined) firstRead.current = chainNow
    else if (chainNow !== firstRead.current) setLead(chainNow - Date.now() / 1000)
  }, [chainNow])

  const [now, setNow] = useState<number>()
  useEffect(() => {
    if (!claimWait) return
    const read = () => setNow(Date.now() / 1000)
    read()
    const timer = setInterval(read, 1000)
    return () => clearInterval(timer)
  }, [claimWait])

  if (!claimWait || chainNow === undefined) return undefined
  const onGrid = now !== undefined && grid && Math.abs(chainNow - now) < 2 * grid.slotDuration
  const left = onGrid
    ? secondsToOpeningBlock(chainNow + claimWait, now, grid, lead ?? 0)
    : claimWait
  if (left <= 0) return "Ready to claim any moment now"
  const about = onGrid && lead === undefined ? "about " : ""
  return `Ready to claim in ${about}${formatClaimCountdown(left)}`
}
