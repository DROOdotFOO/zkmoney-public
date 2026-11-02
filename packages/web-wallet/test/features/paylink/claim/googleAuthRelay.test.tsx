import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { signInWithGoogleIdToken } from "../../../../src/features/paylink/googleAuth"
import { rollupKey } from "../../../../src/platform/storage/rollupStorage"

const opened: string[] = []
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  opened.length = 0
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url))
    return { close: vi.fn() } as unknown as Window
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})
const stateAt = (i: number) => new URL(opened[i]!).searchParams.get("state")!
function deliver(state: string, token: string) {
  const key = rollupKey(`obsidion-google-callback:${state}`)
  localStorage.setItem(key, JSON.stringify({ state, idToken: token, createdAt: Date.now() }))
  window.dispatchEvent(new StorageEvent("storage", { key }))
}

it("isolates concurrent attempts, including errors and cleanup", async () => {
  const first = signInWithGoogleIdToken("1", "client")
  const second = signInWithGoogleIdToken("2", "client")
  deliver(stateAt(1), "second-token")
  await expect(second).resolves.toBe("second-token")
  deliver(stateAt(0), "first-token")
  await expect(first).resolves.toBe("first-token")
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
})
