import { afterEach, describe, expect, it } from "vitest"
import {
  clearNameGrant,
  nameGrantToken,
  pageNameGrantToken,
  stashInboundNameGrant,
} from "../../../../src/features/onboarding/nameGrant"

describe("inbound name grant", () => {
  afterEach(() => {
    clearNameGrant()
    window.history.replaceState(null, "", "/")
  })

  it("removes the bearer token from the URL and scopes it to the claim handle", () => {
    window.history.replaceState(null, "", "/claim/Taga?grant=grant-token")
    stashInboundNameGrant()

    expect(window.location.search).toBe("")
    expect(nameGrantToken("taga")).toBe("grant-token")
    expect(nameGrantToken("tagb")).toBeUndefined()
    expect(sessionStorage.getItem("obsidion.name-grant-handle")).toBe("taga")
  })

  it("keeps an unscoped grant from following a different signup", () => {
    sessionStorage.setItem("obsidion.name-grant", "used-token")
    expect(nameGrantToken("new-user")).toBeUndefined()
    expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()

    window.history.replaceState(null, "", "/claim?grant=used-token")
    stashInboundNameGrant()
    expect(nameGrantToken("new-user")).toBeUndefined()
    expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()
  })

  it("belongs only to its own claim page and bound sign-in", () => {
    window.history.replaceState(null, "", "/claim/Taga?grant=grant-token")
    stashInboundNameGrant()
    const page = (path: string) => pageNameGrantToken(new URL(path, window.location.origin))

    expect(page("/claim/Taga")).toBe("grant-token")
    expect(page("/enter?handle=taga&bound=1")).toBe("grant-token")
    expect(page("/claim/tagb")).toBeUndefined()
    expect(page("/enter?handle=taga")).toBeUndefined()
    expect(page("/enter?handle=tagb&bound=1")).toBeUndefined()
    expect(page("/enter")).toBeUndefined()
    expect(page("/contacts/taga/send")).toBeUndefined()
  })
})
