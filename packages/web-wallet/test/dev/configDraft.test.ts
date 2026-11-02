import { beforeEach, expect, it, vi } from "vitest"
import {
  clearProfileDraft,
  hasProfileDraft,
  profileDraft,
  profileDraftFetch,
  saveProfileDraft,
} from "../../src/dev/configDraft"

beforeEach(() => sessionStorage.clear())

it("serves a saved profile only for its source URL and delegates other requests", async () => {
  const upstream = vi.fn(async () => new Response("live")) as typeof fetch
  const url = "https://preview.example/profiles/current.json"
  saveProfileDraft(url, '{"profileId":"sandbox"}')

  const fetchWithDraft = profileDraftFetch(upstream)
  expect(await (await fetchWithDraft(url)).text()).toBe('{"profileId":"sandbox"}')
  expect(
    await (await fetchWithDraft("https://preview.example/artifacts/current.json")).text(),
  ).toBe("live")
  expect(upstream).toHaveBeenCalledTimes(1)

  clearProfileDraft()
  expect(hasProfileDraft()).toBe(false)
  expect(await (await fetchWithDraft(url)).text()).toBe("live")
})

it("ignores malformed stored drafts", () => {
  sessionStorage.setItem("webwallet.preview-config-draft", "{bad")
  expect(hasProfileDraft()).toBe(false)
  expect(profileDraft("https://preview.example/profile.json")).toBeUndefined()
})
