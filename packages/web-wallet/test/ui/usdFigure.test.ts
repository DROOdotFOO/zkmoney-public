import { describe, expect, it } from "vitest"
import { usdFigure } from "../../src/ui/format"

describe("usdFigure", () => {
  it("renders dollars, dropping cents on whole amounts", () => {
    expect(usdFigure("0.5")).toBe("$0.50")
    expect(usdFigure("115")).toBe("$115")
  })
  it("never renders a real charge as free", () => {
    expect(usdFigure("0.001")).toBe("<$0.01")
    expect(usdFigure("0")).toBe("$0")
  })
})
