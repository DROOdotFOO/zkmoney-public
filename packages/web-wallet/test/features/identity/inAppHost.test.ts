/** The document mark that lets the styles keep an app's own bar clear. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { markInAppBrowser } from "../../../src/features/identity/inAppHost"

const UA = {
  iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  laptop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
}

afterEach(() => {
  vi.restoreAllMocks()
})

function marked(userAgent: string): boolean {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  const root = document.createElement("div")
  markInAppBrowser(root)
  return root.dataset.inAppBrowser !== undefined
}

describe("markInAppBrowser", () => {
  it("leaves Safari and a laptop unmarked", () => {
    expect(marked(UA.iosSafari)).toBe(false)
    expect(marked(UA.laptop)).toBe(false)
  })

  it("marks the document root by default", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.iosX)
    try {
      markInAppBrowser()
      expect(document.documentElement.dataset.inAppBrowser).toBe("")
    } finally {
      delete document.documentElement.dataset.inAppBrowser
    }
  })
})
