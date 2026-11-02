import { afterEach, describe, expect, it, vi } from "vitest"

const shown = vi.fn()
class FakeNotification {
  static permission = "granted"
  static requestPermission = vi.fn(async () => "granted")
  constructor(title: string, opts: { body: string }) {
    shown(title, opts.body)
  }
}
vi.stubGlobal("Notification", FakeNotification)

const { armNotify, notifyIfArmed, notifySupported } = await import(
  "../../../src/features/cutover/notify"
)

const userAgent = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua)

afterEach(() => {
  vi.restoreAllMocks()
  shown.mockClear()
})

describe("notify me when ready", () => {
  it("shows the notice once after the user asks", () => {
    userAgent("Mozilla/5.0 (Macintosh)")
    notifyIfArmed("Upgrade complete", "Done")
    expect(shown).not.toHaveBeenCalled()
    armNotify()
    notifyIfArmed("Upgrade complete", "Done")
    notifyIfArmed("Upgrade complete", "Done")
    expect(shown).toHaveBeenCalledOnce()
  })

  it("shows a notice whose run ended while the permission prompt was open", async () => {
    userAgent("Mozilla/5.0 (Macintosh)")
    let grant!: (p: string) => void
    FakeNotification.permission = "default"
    FakeNotification.requestPermission.mockImplementationOnce(
      () => new Promise((resolve) => (grant = resolve)),
    )
    armNotify()
    notifyIfArmed("Upgrade complete", "Done")
    expect(shown).not.toHaveBeenCalled()
    FakeNotification.permission = "granted"
    grant("granted")
    await Promise.resolve()
    await Promise.resolve()
    expect(shown).toHaveBeenCalledWith("Upgrade complete", "Done")
  })

  it("is not offered where a page cannot show a notification", () => {
    userAgent("Mozilla/5.0 (Linux; Android 14)")
    expect(notifySupported()).toBe(false)
    armNotify()
    notifyIfArmed("Upgrade complete", "Done")
    expect(shown).not.toHaveBeenCalled()
  })
})
