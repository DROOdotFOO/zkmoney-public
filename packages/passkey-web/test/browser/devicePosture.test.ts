// @vitest-environment node
import { describe, expect, it } from "vitest"
import { classifyDevicePosture } from "../../src/browser/devicePosture.js"

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  // iPad in desktop mode and an iPhone with "Request Desktop Website" both send a Mac UA.
  desktopModeSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  empty: "",
}

describe("classifyDevicePosture", () => {
  it.each([
    ["iphoneSafari", "phone"],
    ["androidChrome", "phone"],
    ["macChrome", "laptop"],
    ["windowsEdge", "laptop"],
    ["ipadSafari", "laptop"],
    ["desktopModeSafari", "laptop"],
    ["androidTablet", "laptop"],
    ["empty", "laptop"],
  ] as const)("reads %s as a %s", (ua, posture) => {
    expect(classifyDevicePosture({ userAgent: UA[ua] })).toBe(posture)
  })

  it("Client Hints win over the user agent", () => {
    expect(classifyDevicePosture({ userAgent: UA.macChrome, userAgentDataMobile: true })).toBe(
      "phone",
    )
    expect(classifyDevicePosture({ userAgent: UA.iphoneSafari, userAgentDataMobile: false })).toBe(
      "laptop",
    )
  })
})
