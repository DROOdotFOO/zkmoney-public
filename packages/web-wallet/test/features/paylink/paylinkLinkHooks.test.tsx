/**
 * The two reads a visitor's link page gates on: this browser's own cash-out of the link, and how
 * many voucher uses the link's escrow still holds.
 *
 * Both decide whether a holder is offered a way to get their money, so both fail in the same
 * direction: a wrong answer either hands over a cash-out the escrow cannot pay for, or tells
 * someone their funds are gone while they sit in escrow.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const records: { list: unknown[] } = { list: [] }
const linkVoucherUses = vi.fn()

vi.mock("../../../src/features/withdraw/useWithdrawals", () => ({
  useWithdrawals: () => ({ records: records.list }),
}))
vi.mock("../../../src/features/paylink/paylinkExit", () => ({
  linkWithdrawalIdentity: (fragment: string) => ({ id: `hash:${fragment}` }),
  linkVoucherUses: (...args: unknown[]) => linkVoucherUses(...args),
}))
// Stable identities: `useLinkExitDeps` memoises on these, and a fresh object per render would
// re-run the read effect on every render it caused.
const CTX = {
  teeSigner: { _id: "signer" } as { _id: string } | undefined,
  wallet: { _id: "wallet", networkId: "0xrollup" } as
    | { _id: string; networkId: string }
    | undefined,
  cs: { contractService: { _id: "cs" } },
}
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => CTX.cs,
}))

const { useLinkVoucher, useLinkWithdrawal } = await import(
  "../../../src/features/paylink/usePaylinkDeps"
)
const { closeSession } = await import("../../../src/platform/session")
const { openTestSession } = await import("../../support/session")

/** A visitor's session over the wallet and signer `CTX` holds; one left out is not up yet. */
const openSession = () => {
  closeSession()
  openTestSession({ wallet: CTX.wallet, teeSigner: CTX.teeSigner })
}

const link = (fragment: string, over: Record<string, unknown> = {}) =>
  ({ fragment, status: "unclaimed", flavor: "direct", ...over } as never)

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  CTX.teeSigner = { _id: "signer" }
  CTX.wallet = { _id: "wallet", networkId: "0xrollup" }
  openSession()
  records.list = []
  linkVoucherUses.mockReset()
  linkVoucherUses.mockReturnValue(new Promise<number>(() => {}))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/**
 * Mounts ONE component and re-renders it with a new fragment, so a fragment change is a prop
 * change under a mounted route rather than a remount. A remount clears the hook's state for free,
 * which is exactly the case these tests must not be measuring.
 */
function harness<T>(read: (fragment: string) => T): {
  seen: T[]
  render: (fragment: string) => void
  renderAsync: (fragment: string) => Promise<void>
} {
  const seen: T[] = []
  const Probe = ({ fragment }: { fragment: string }) => {
    seen.push(read(fragment))
    return <span>{fragment}</span>
  }
  const render = (fragment: string) => act(() => root.render(<Probe fragment={fragment} />))
  return {
    seen,
    render,
    renderAsync: async (fragment: string) => {
      await act(async () => root.render(<Probe fragment={fragment} />))
    },
  }
}

describe("this browser's own cash-out of a link", () => {
  it("reports no withdrawal for a failed cash-out, so the funded link stays retryable", () => {
    // `cashOutLink` throws only pre-mine, so a failed record means the escrow still holds the
    // money. Reporting it would say "You withdrew" and take the retry away.
    records.list = [{ paylinkId: "hash:frag-a", phase: "failed", error: "proving failed" }]
    const h = harness((f) => useLinkWithdrawal(link(f)))
    h.render("frag-a")

    expect(h.seen.at(-1)).toBeUndefined()
  })

  it("finds the retry that worked past the attempt that did not", () => {
    records.list = [
      { paylinkId: "hash:frag-a", phase: "failed" },
      { paylinkId: "hash:frag-a", phase: "l2_mined" },
    ]
    const h = harness((f) => useLinkWithdrawal(link(f)))
    h.render("frag-a")

    expect((h.seen.at(-1) as { phase: string }).phase).toBe("l2_mined")
  })

  it("ignores another link's withdrawal", () => {
    records.list = [{ paylinkId: "hash:frag-b", phase: "l2_mined" }]
    const h = harness((f) => useLinkWithdrawal(link(f)))
    h.render("frag-a")

    expect(h.seen.at(-1)).toBeUndefined()
  })

  it("does not read the link's registration burn as a cash-out, at any phase", () => {
    // The ticket signup seeds this record before its batch signs and keeps it through the mine.
    // Reporting it would replace the signup with a withdrawal page mid-claim.
    const burn = { paylinkId: "hash:frag-a", source: "paylink", intent: "registration" }
    for (const phase of ["submitting", "l2_mined", "done"]) {
      records.list = [{ ...burn, phase }]
      const h = harness((f) => useLinkWithdrawal(link(f)))
      h.render("frag-a")
      expect(h.seen.at(-1)).toBeUndefined()
    }
  })
})

describe("the voucher uses a link's escrow holds", () => {
  it("drops the previous link's answer when the fragment changes under a mounted route", async () => {
    const h = harness((f) => useLinkVoucher(link(f)).uses)
    linkVoucherUses.mockResolvedValue(2)
    await h.renderAsync("frag-a")
    expect(h.seen.at(-1)).toBe(2)

    // frag-b's read is still in flight. Carrying frag-a's 2 over would offer a cash-out the
    // replacement link may have no voucher to pay for.
    let settle: (n: number) => void = () => {}
    linkVoucherUses.mockReturnValue(new Promise<number>((res) => (settle = res)))
    h.render("frag-b")
    expect(h.seen.at(-1)).toBeUndefined()

    await act(async () => settle(0))
    expect(h.seen.at(-1)).toBe(0)
  })

  it("reports an unknown voucher on timeout, and lets the visitor retry", async () => {
    vi.useFakeTimers()
    const h = harness((f) => useLinkVoucher(link(f)))
    h.render("frag-a")
    await act(async () => void vi.advanceTimersByTime(12_000))
    expect(h.seen.at(-1)?.uses).toBeUndefined()
    expect(h.seen.at(-1)?.error).toBeTruthy()
    linkVoucherUses.mockResolvedValue(1)
    await act(async () => h.seen.at(-1)!.retry())
    expect(h.seen.at(-1)?.uses).toBe(1)
    expect(h.seen.at(-1)?.error).toBeUndefined()
  })

  it("does not mistake a failed voucher read for an unfunded email link", async () => {
    linkVoucherUses.mockRejectedValue(new Error("RPC unavailable"))
    const h = harness((f) => useLinkVoucher(link(f, { flavor: "email" })))
    await h.renderAsync("frag-a")
    expect(h.seen.at(-1)?.uses).toBeUndefined()
    expect(h.seen.at(-1)?.error).toBeTruthy()
  })

  it("ignores a timed-out answer after a successful retry", async () => {
    vi.useFakeTimers()
    let finishOld!: (n: number) => void
    linkVoucherUses.mockReturnValue(
      new Promise<number>((resolve) => {
        finishOld = resolve
      }),
    )
    const h = harness((f) => useLinkVoucher(link(f, { flavor: "email" })))
    h.render("frag-a")
    await act(async () => void vi.advanceTimersByTime(12_000))
    linkVoucherUses.mockResolvedValue(1)
    await act(async () => h.seen.at(-1)!.retry())
    await act(async () => finishOld(0))
    expect(h.seen.at(-1)?.uses).toBe(1)
    expect(h.seen.at(-1)?.error).toBeUndefined()
  })
})
