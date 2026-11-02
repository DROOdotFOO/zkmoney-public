/**
 * Each row of the pinned table credits its own token one to one, less its fee, in that token's units; only a swap
 * input names the token it is swapped into. Over a two-row table (DAI and USDC, each its own row) no USDC copy names
 * DAI.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  mainnetTokens,
  ROW_SUSDS,
  ROW_USDC,
  savingsRowTokens,
  twoRowTokens,
  usdcFeeTokens,
} from "../../support/depositTokens"

const { settlementToken } = await import("../../../src/features/deposit/loadDepositFacts")
const { tokenFigure } = await import("../../../src/ui/format")
const { DepositTermsRows, fundingAssetsLabel, swapAssetsLabel } = await import(
  "../../../src/features/onboarding/steps/DepositTermsRows"
)

describe("what a row's token credits", () => {
  it("finds the row a funding token settles on", () => {
    expect(settlementToken(twoRowTokens(), ROW_USDC)).toBe(ROW_USDC)
    expect(settlementToken(mainnetTokens(), MAINNET_USDC)).toBe(MAINNET_DAI)
    expect(settlementToken(twoRowTokens(), `0x${"ee".repeat(20)}`)).toBeUndefined()
    expect(settlementToken(undefined, ROW_USDC)).toBeUndefined()
    // A record that predates token tracking was made on the pinned bridge.
    expect(settlementToken(twoRowTokens("USDC"), undefined)).toBe(ROW_USDC)
  })

  it("resolves a Savings row's record, though the funding copy names only Main's token", () => {
    expect(settlementToken(savingsRowTokens(), ROW_SUSDS)).toBe(ROW_SUSDS)
    expect(fundingAssetsLabel(savingsRowTokens())).toBe("DAI")
    expect(swapAssetsLabel(savingsRowTokens())).toBeUndefined()
  })
})

describe("a fee in the row token's units", () => {
  it("states it to the cent with the token's symbol", () => {
    expect(tokenFigure("0.1", "USDC")).toBe("0.10 USDC")
    expect(tokenFigure("1200", "DAI")).toBe("1,200 DAI")
    expect(tokenFigure("0.000001", "USDC")).toBe("<0.01 USDC")
  })
})

describe("copy over a two-row table", () => {
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
  })

  it("quotes a USDC fee token's registration terms with no swap note", async () => {
    await act(async () => {
      root.render(
        <DepositTermsRows
          total={15_000_000n}
          fee={5_000_000n}
          sweepFee={500_000n}
          tokenSymbol="USDC"
          tokenDecimals={6}
          kind="standard"
          swapAssets={swapAssetsLabel(usdcFeeTokens())}
        />,
      )
    })
    expect(container.querySelector('[data-testid="deposit-terms-swap-note"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="deposit-terms-opening-balance"]')?.textContent,
    ).toBe("$10.00")
    expect(container.textContent).not.toContain("DAI")
  })
})
