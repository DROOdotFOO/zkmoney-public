import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import {
  setWithdrawableSources,
  skipUnrefundableSource,
  useWithdrawableSources,
} from "../../../../src/features/migration/oldVersionWithdraw"
import { walletStorage } from "../../../../src/platform/storage/walletStorage"

/** The active account, committed, as a booted wallet has it. */
const activate = (id: string) => walletStorage.commitItem("webwallet.storageId", id)

const source = (portal: string) => ({ source: { portal }, savings: false, open: vi.fn() } as never)

describe("withdrawable sources", () => {
  it("skips an unrefundable portal for its account only", async () => {
    await activate("alice")
    const sources = [source("0xA"), source("0xB")]
    setWithdrawableSources(sources)
    skipUnrefundableSource({ portal: "0xa" } as never)
    const shown = () => {
      let value: readonly { source: { portal: string } }[] = []
      const root = createRoot(document.createElement("div"))
      act(() =>
        root.render(
          createElement(() => {
            value = useWithdrawableSources()
            return null
          }),
        ),
      )
      act(() => root.unmount())
      return value
    }
    expect(shown().map((s) => s.source.portal)).toEqual(["0xB"])

    await activate("bob")
    setWithdrawableSources(sources)
    expect(shown().map((s) => s.source.portal)).toEqual(["0xA", "0xB"])
  })
})
