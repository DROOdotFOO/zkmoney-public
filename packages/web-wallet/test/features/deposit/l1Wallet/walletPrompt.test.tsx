/**
 * The wait on a connected wallet's prompt: when a sheet calls it stalled, how it refuses a second
 * request while the wallet holds the first, and the note that offers the way back.
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import {
  clearWalletPrompt,
  useWalletPrompt,
  useWalletPromptStall,
  WALLET_PROMPT_STALL_MS,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPrompt,
} from "../../../../src/features/deposit/walletPrompt"

const OPEN = "Your wallet still has the previous request open. Approve or reject it there first."

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe("useWalletPromptStall", () => {
  function Probe({ waiting }: { waiting: boolean }) {
    return <span>{useWalletPromptStall(waiting) ? "stalled" : "waiting"}</span>
  }
  const show = (waiting: boolean) => act(async () => root.render(<Probe waiting={waiting} />))
  const pass = (ms: number) => act(async () => vi.advanceTimersByTime(ms))

  it("flips once the wait has held for the stall window, and resets when the wait ends", async () => {
    vi.useFakeTimers()
    await show(true)
    await pass(WALLET_PROMPT_STALL_MS - 1)
    expect(container.textContent).toBe("waiting")
    await pass(1)
    expect(container.textContent).toBe("stalled")
    await show(false)
    expect(container.textContent).toBe("waiting")
    // A new wait runs its own clock from the start.
    await show(true)
    await pass(WALLET_PROMPT_STALL_MS - 1)
    expect(container.textContent).toBe("waiting")
    await pass(1)
    expect(container.textContent).toBe("stalled")
  })
})

describe("useWalletPrompt", () => {
  const hook: { current?: WalletPrompt } = {}
  function Probe() {
    hook.current = useWalletPrompt()
    return <span>{hook.current.open ? "open" : "idle"}</span>
  }
  const prompt = () => hook.current!
  const begin = async () => {
    let token = 0
    await act(async () => {
      token = prompt().begin()
    })
    return token
  }

  beforeEach(() => act(async () => root.render(<Probe />)))
  // The slot outlives the probe: forget whatever a case left open.
  afterEach(() => act(async () => clearWalletPrompt()))

  it("refuses a second request while the first is open, and allows one once it settles", async () => {
    const first = await begin()
    expect(container.textContent).toBe("open")
    expect(() => prompt().begin()).toThrow(WalletPromptOpenError)
    expect(() => prompt().begin()).toThrow(OPEN)
    await act(async () => prompt().settle(first))
    expect(container.textContent).toBe("idle")
    await begin()
    expect(container.textContent).toBe("open")
  })

  it("marks a cancelled request abandoned until the wallet answers, and still refuses a new one", async () => {
    const token = await begin()
    expect(prompt().cancelled(token)).toBe(false)
    expect(prompt().openElsewhere).toBeUndefined()
    await act(async () => prompt().cancel())
    expect(prompt().cancelled(token)).toBe(true)
    expect(prompt().open).toBe(true)
    expect(prompt().openElsewhere).toBe(OPEN)
    expect(() => prompt().begin()).toThrow(WalletPromptOpenError)
    await act(async () => prompt().settle(token))
    expect(prompt().open).toBe(false)
    expect(prompt().openElsewhere).toBeUndefined()
    expect(prompt().cancelled(token)).toBe(false)
  })

  it("ignores a settle for a request it never issued", async () => {
    const token = await begin()
    await act(async () => prompt().settle(token + 1))
    await act(async () => prompt().settle(undefined))
    expect(prompt().open).toBe(true)
    await act(async () => prompt().settle(token))
  })

  it("shows a sheet that closes and reopens the request the wallet still holds", async () => {
    const token = await begin()
    await act(async () => prompt().cancel())
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<Probe />))
    expect(container.textContent).toBe("open")
    expect(prompt().openElsewhere).toBe(OPEN)
    expect(() => prompt().begin()).toThrow(WalletPromptOpenError)
    // The wallet's answer reaches the request through the first sheet's token, wherever it lands.
    await act(async () => prompt().settle(token))
    expect(container.textContent).toBe("idle")
    await begin()
    expect(container.textContent).toBe("open")
  })
})

describe("WalletPromptNote", () => {
  it("names the wallet and offers Cancel", async () => {
    const onCancel = vi.fn()
    await act(async () =>
      root.render(<WalletPromptNote walletName="Rainbow" onCancel={onCancel} />),
    )
    const note = container.querySelector('[data-testid="wallet-prompt-stall"]')!
    expect(note.getAttribute("role")).toBe("status")
    expect(note.textContent).toBe(
      "Still waiting for Rainbow. Open it to approve the request, or cancel and try again. Cancel",
    )
    await act(async () => container.querySelector("button")!.click())
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("says 'your wallet' without a name, and offers no Cancel without a handler", async () => {
    await act(async () => root.render(<WalletPromptNote />))
    expect(container.textContent).toBe(
      "Still waiting for your wallet. Open it to approve the request, or cancel and try again.",
    )
    expect(container.querySelector("button")).toBeNull()
  })
})
