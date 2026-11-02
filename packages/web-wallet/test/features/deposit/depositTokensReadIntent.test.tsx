/** A token read answers only the intent it was made for: a registration never shows deposit coins. */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import type { SipaIntentName } from "@obsidion/core/oxide"
import {
  useDepositTokensRead,
  type DepositTokens,
} from "../../../src/features/deposit/loadDepositFacts"
import { singleToken } from "../../support/depositTokens"

const DEPOSIT = singleToken("0x00000000000000000000000000000000000000d1", "DAI")
const REGISTRATION = singleToken("0x00000000000000000000000000000000000000e2", "USDC")

describe("useDepositTokensRead", () => {
  it("drops an earlier intent's tokens once the intent changes, until its own read lands", async () => {
    const pending = new Map<SipaIntentName, (tokens: DepositTokens) => void>()
    const load = (intent: SipaIntentName) =>
      new Promise<DepositTokens>((resolve) => pending.set(intent, resolve))
    let shown: DepositTokens | undefined
    function Reader({ intent }: { intent: SipaIntentName }) {
      shown = useDepositTokensRead(intent, load).tokens
      return null
    }
    const root = createRoot(document.createElement("div"))
    await act(async () => root.render(<Reader intent="deposit" />))
    // The deposit read lands, then the registration is found owed.
    await act(async () => pending.get("deposit")!(DEPOSIT))
    expect(shown).toBe(DEPOSIT)
    await act(async () => root.render(<Reader intent="registration" />))
    expect(shown).toBeUndefined()
    await act(async () => pending.get("registration")!(REGISTRATION))
    expect(shown).toBe(REGISTRATION)
    act(() => root.unmount())
  })
})
