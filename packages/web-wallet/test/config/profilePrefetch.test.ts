/**
 * The config profile is requested as the page starts; the boot's first request for it takes that
 * response, and its deadline still applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetProfilePrefetchForTests,
  prefetchProfile,
  profileFetch,
} from "../../src/config/profilePrefetch"

const URL = "https://cdn.example.test/profiles/v5/current.json"
const env = { VITE_CONFIG_PROFILE_URL: URL }
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response("{}"))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  __resetProfilePrefetchForTests()
  vi.unstubAllGlobals()
})

describe("prefetchProfile", () => {
  it("requests the profile once, and the boot's request takes it", async () => {
    prefetchProfile(env)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(URL)
    const response = await profileFetch(URL, { headers: { accept: "application/json" } })
    expect(await response.text()).toBe("{}")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A later request is a request of its own.
    await profileFetch(URL)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("leaves any other request to fetch", async () => {
    prefetchProfile(env)
    await profileFetch("https://cdn.example.test/artifacts/manifest.json")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("aborts the prefetch when the boot's deadline does", async () => {
    prefetchProfile(env)
    const prefetchSignal = fetchMock.mock.calls[0][1].signal as AbortSignal
    const deadline = new AbortController()
    void profileFetch(URL, { signal: deadline.signal })
    expect(prefetchSignal.aborted).toBe(false)
    deadline.abort()
    expect(prefetchSignal.aborted).toBe(true)
  })

  it("is not made by a desktop build, whose launcher may name another profile", () => {
    prefetchProfile({ ...env, VITE_DESKTOP_BUILD: "true" })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
