/**
 * Whether the page started on an origin with nothing stored: only then may a visitor's first screen
 * show before the wallet database opens.
 */
import { afterEach, describe, expect, it } from "vitest"
import { __resetFreshOriginForTests, originWasFresh } from "../../../src/platform/storage/freshOrigin"
import { testWalletDbs } from "../../support/fakeWalletDb"

const realStorage = Object.getOwnPropertyDescriptor(navigator, "storage")

function withOpfs(getDirectory: () => Promise<unknown>) {
  Object.defineProperty(navigator, "storage", { value: { getDirectory }, configurable: true })
}

afterEach(() => {
  __resetFreshOriginForTests()
  if (realStorage) Object.defineProperty(navigator, "storage", realStorage)
  else delete (navigator as { storage?: unknown }).storage
})

describe("originWasFresh", () => {
  it("is not fresh where any rollup's wallet database exists", async () => {
    withOpfs(async () => ({}))
    testWalletDbs().db("1234")
    expect(await originWasFresh()).toBe(false)
  })

  it("is fresh where storage is refused, as Safari Private Browsing refuses it", async () => {
    withOpfs(() => Promise.reject(new DOMException("The operation is insecure.", "SecurityError")))
    testWalletDbs().db("1234")
    expect(await originWasFresh()).toBe(true)
  })

  it("is not fresh when the databases cannot be listed", async () => {
    withOpfs(async () => ({}))
    const dbs = testWalletDbs()
    const list = dbs.list
    dbs.list = () => Promise.reject(new Error("listing failed"))
    try {
      expect(await originWasFresh()).toBe(false)
    } finally {
      dbs.list = list
    }
  })

  it("answers once per page, so a database this page opens later does not change it", async () => {
    withOpfs(async () => ({}))
    expect(await originWasFresh()).toBe(true)
    testWalletDbs().db("1234")
    expect(await originWasFresh()).toBe(true)
  })
})
