import { describe, expect, it } from "vitest"
import { isExtensionError } from "../../src/errors/extensionError"

const message = "The source https://wallet.zk.money/ has not been authorized yet"
const extensionScript = "chrome-extension://onhogfjeacnfoofkfgppdlbmlmnplgbn/page.js"
const walletScript = "https://wallet.zk.money/assets/index-abc.js"

function v8Error(...frames: string[]): Error {
  const err = new Error(message)
  err.stack = [`Error: ${message}`, ...frames.map((f) => `    at ${f}`)].join("\n")
  return err
}

function geckoError(...frames: string[]): Error {
  const err = new Error(message)
  err.stack = frames.join("\n")
  return err
}

describe("isExtensionError", () => {
  it("is true when every Gecko or WebKit frame is an extension script", () => {
    expect(
      isExtensionError(
        undefined,
        geckoError(`m@moz-extension://abc/page.js:2:10`, `@moz-extension://abc/page.js:1:1`),
      ),
    ).toBe(true)
    expect(
      isExtensionError(undefined, geckoError(`global code@safari-web-extension://abc/page.js:1:1`)),
    ).toBe(true)
  })

  it("is false when a wallet frame is mixed with an extension frame, in either order", () => {
    expect(
      isExtensionError(
        undefined,
        v8Error(`m (${extensionScript}:2:155931)`, `send (${walletScript}:1:100)`),
      ),
    ).toBe(false)
    expect(
      isExtensionError(
        undefined,
        v8Error(`send (${walletScript}:1:100)`, `m (${extensionScript}:2:155931)`),
      ),
    ).toBe(false)
  })

  it("ignores URLs in the message line", () => {
    const err = new Error(`could not load ${extensionScript}`)
    err.stack = `Error: ${err.message}\n    at f (${walletScript}:1:1)`
    expect(isExtensionError(undefined, err)).toBe(false)
  })

  it("is false for a non-Error reason, an empty filename, and an Error without frames", () => {
    expect(isExtensionError(undefined, "sponsor unreachable")).toBe(false)
    expect(isExtensionError("", null)).toBe(false)
    const bare = new Error("no stack")
    bare.stack = undefined
    expect(isExtensionError(undefined, bare)).toBe(false)
    expect(isExtensionError(undefined, v8Error())).toBe(false)
  })
})
