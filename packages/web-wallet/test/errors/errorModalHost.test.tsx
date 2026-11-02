import { APPLE_ICLOUD_AAGUID, ONEPASSWORD_AAGUID } from "@obsidion/core/constants"
import { buildPasskeyEnvironment, parseUserAgent } from "@obsidion/passkey-web"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ErrorModalHost } from "../../src/errors/ErrorModalHost"
import { showErrorModal } from "../../src/errors/errorModal"
import { PASSKEY_ENVIRONMENT_KEY } from "../../src/platform/auth/passkeyEnvironmentKey"
import { useAsyncAction } from "../../src/ui/hooks"
import { FakePasskeyCeremony } from "../support/fakePasskeyCeremony"

const DISCLOSURE = "The report includes your device type, OS, browser and passkey provider."

vi.mock("../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
// Pin the API URL and session id; keep fireEvent/failureCode real (consent-gated off in tests).
vi.mock("../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/analytics")>()),
  analyticsUrl: "http://api.test",
  reportId: () => "test-report-id",
  appVersion: "test",
}))
// The DS button drags in liquid-glass optics that jsdom can't render; the test is about behavior.
vi.mock("@obsidion/web-ds", () => ({
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
  }: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
  }) => (
    <button disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ ariaLabel, onClick }: { ariaLabel: string; onClick?: () => void }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      {ariaLabel}
    </button>
  ),
}))

describe("ErrorModalHost", () => {
  let container: HTMLDivElement
  let root: Root
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  const fetchMock = vi.fn(async () => ({ ok: true } as Response))

  beforeEach(() => {
    // jsdom has no navigator.clipboard.
    Object.assign(navigator, { clipboard: { writeText } })
    vi.stubGlobal("fetch", fetchMock)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<ErrorModalHost />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    writeText.mockClear()
    fetchMock.mockClear()
    vi.unstubAllGlobals()
  })

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)

  it("shows a thrown error's stack; Copy writes the report, Report POSTs it to the API", async () => {
    // A flow throws; the catch block surfaces it with the stack as detail.
    try {
      throw new Error("Balance too low")
    } catch (e) {
      const err = e as Error
      act(() =>
        showErrorModal({
          title: "Transaction error",
          message: err.message,
          detail: err.stack,
          showReport: true,
          context: "test:throw",
        }),
      )
    }

    expect(container.textContent).toContain("Transaction error")
    expect(container.textContent).toContain("Balance too low")
    expect(container.textContent).toContain("errorModalHost.test") // a stack frame is visible
    expect(button("Copy")).toBeDefined()
    expect(button("Report")).toBeDefined()
    expect(container.textContent).toContain(DISCLOSURE)

    // Report POSTs the full payload to /error-reports — no clipboard involved, no consent gate.
    await act(async () => button("Report")!.click())
    expect(writeText).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://api.test/error-reports")
    const body = JSON.parse(init.body as string)
    expect(body.title).toBe("Transaction error")
    expect(body.message).toBe("Balance too low")
    expect(body.detail).toContain("errorModalHost.test") // the stack made it to the API
    expect(body.context).toBe("test:throw")
    expect(body.session_id).toBe("test-report-id")
    expect(body.platform).toBe("web")
    expect(body.env).toMatchObject({ provider: "unknown" })
    expect(button("Sent")).toBeDefined()

    await act(async () => button("Copy")!.click())

    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain("Message: Balance too low")
    expect(copied).toContain("Detail: Error: Balance too low")
    expect(copied).toContain("errorModalHost.test") // the stack made it into the report
    expect(copied).toContain("Context: test:throw")
    expect(button("Copied")).toBeDefined()

    // Corner close dismisses.
    act(() => button("Close")!.click())
    expect(container.textContent).toBe("")
  })

  it("offers a caller's retry, which closes the modal and runs once tapped", () => {
    const run = vi.fn()
    act(() =>
      showErrorModal({
        title: "Could not save",
        message: "disk",
        context: "test:retry",
        retry: { label: "Retry entering wallet", run },
      }),
    )
    expect(container.textContent).toContain("Could not save")
    act(() => button("Retry entering wallet")!.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe("")
  })

  it("auto-surfaces an uncaught flow rejection — no showErrorModal call at the site", async () => {
    // A flow with no try/catch and no .catch — e.g. paylink creation kicked off fire-and-forget.
    const createPaylink = async () => {
      throw new Error("Paylink creation failed: sponsor unreachable")
    }

    // jsdom never fires unhandledrejection itself (and vitest would fail the test on a truly
    // unhandled promise), so capture the reason and dispatch the browser event by hand.
    const reason = await createPaylink().catch((e: unknown) => e)
    const event = new Event("unhandledrejection") as Event & { reason: unknown }
    event.reason = reason
    act(() => {
      window.dispatchEvent(event)
    })

    // The modal appeared on its own, with the stack and Copy / Report.
    expect(container.textContent).toContain("Unexpected error")
    expect(container.textContent).toContain("Paylink creation failed: sponsor unreachable")
    expect(container.textContent).toContain("errorModalHost.test")

    await act(async () => button("Copy")!.click())
    const copied = writeText.mock.calls[0][0]
    expect(copied).toContain("Detail: Error: Paylink creation failed: sponsor unreachable")
    expect(copied).toContain("Context: unhandled")

    act(() => button("Close")!.click())
    expect(container.textContent).toBe("")
  })

  it("reports a plain-object rejection by its message", async () => {
    const event = new Event("unhandledrejection") as Event & { reason: unknown }
    event.reason = { code: 4001, message: "User rejected the request." }
    act(() => {
      window.dispatchEvent(event)
    })

    expect(container.textContent).toContain("User rejected the request. (code 4001)")
    expect(container.textContent).not.toContain("[object Object]")

    await act(async () => button("Report")!.click())
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).message).toBe("User rejected the request. (code 4001)")
  })

  it("ignores an uncaught error thrown by a browser extension script", () => {
    const err = new Error("The source https://wallet.zk.money/ has not been authorized yet")
    err.stack = `Error: ${err.message}\n    at m (chrome-extension://onhogfjeacnfoofkfgppdlbmlmnplgbn/page.js:2:155931)`
    const event = new Event("error") as Event & { error: unknown; filename: string }
    event.error = err
    event.filename = "chrome-extension://onhogfjeacnfoofkfgppdlbmlmnplgbn/page.js"
    act(() => {
      window.dispatchEvent(event)
    })
    expect(container.textContent).toBe("")
  })

  it("ignores an uncaught rejection whose stack comes from a browser extension script", () => {
    const reason = new Error("The source https://wallet.zk.money/ has not been authorized yet")
    reason.stack = `Error: ${reason.message}\n    at m (chrome-extension://onhogfjeacnfoofkfgppdlbmlmnplgbn/page.js:2:155931)`
    const event = new Event("unhandledrejection") as Event & { reason: unknown }
    event.reason = reason
    act(() => {
      window.dispatchEvent(event)
    })
    expect(container.textContent).toBe("")
  })

  it("ignores the TypeError that a WalletConnect chain change throws under switchEthereumChain", () => {
    const reason = new TypeError("Cannot read properties of undefined (reading 'request')")
    reason.stack = `TypeError: ${reason.message}\n    at e.request (https://wallet.zk.money/assets/dist-abc.js:11:159174)\n    at e.switchEthereumChain (https://wallet.zk.money/assets/dist-abc.js:11:173625)`
    const event = new Event("unhandledrejection", { cancelable: true }) as Event & {
      reason: unknown
    }
    event.reason = reason
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(container.textContent).toBe("")
  })

  it("surfaces the same TypeError when no switchEthereumChain frame threw it", () => {
    const reason = new TypeError("Cannot read properties of undefined (reading 'request')")
    reason.stack = `TypeError: ${reason.message}\n    at sendDeposit (https://wallet.zk.money/assets/index-abc.js:3:100)`
    const event = new Event("unhandledrejection") as Event & { reason: unknown }
    event.reason = reason
    act(() => {
      window.dispatchEvent(event)
    })
    expect(container.textContent).toContain("sendDeposit")
  })

  it("ignores an uncaught expired WalletConnect proposal", () => {
    const reason = new Error("Proposal expired")
    reason.stack = `Error: ${reason.message}\n    at https://wallet.zk.money/assets/index.es-abc.js:2:4111`
    const event = new Event("unhandledrejection", { cancelable: true }) as Event & {
      reason: unknown
    }
    event.reason = reason
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(container.textContent).toBe("")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("ignores the muted error of a cross-origin script, which carries no error object", () => {
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }))
    })
    expect(container.textContent).toBe("")
  })

  it("surfaces a thrown error whose message is Script error.", () => {
    const error = new Error("Script error.")
    act(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: error.message, error }))
    })
    expect(container.textContent).toContain("errorModalHost.test")
  })

  it("ignores the browser's ResizeObserver loop notice, which carries no error object", () => {
    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "ResizeObserver loop completed with undelivered notifications.",
        }),
      )
    })
    expect(container.textContent).toBe("")
  })

  it("surfaces an uncaught error event that has a message and no error object", () => {
    act(() => {
      window.dispatchEvent(
        new ErrorEvent("error", { message: "Uncaught ReferenceError: x is not defined" }),
      )
    })
    expect(container.textContent).toContain("Uncaught ReferenceError: x is not defined")
  })

  it("surfaces an error caught by a screen action instead of swallowing it into toast state", async () => {
    function CaughtAction() {
      const { run } = useAsyncAction()
      return (
        <button
          onClick={() =>
            void run(async () => {
              throw new Error("caught action failed")
            }, "caught_action")
          }
        >
          Run caught action
        </button>
      )
    }

    act(() =>
      root.render(
        <>
          <ErrorModalHost />
          <CaughtAction />
        </>,
      ),
    )
    await act(async () => {
      button("Run caught action")!.click()
    })

    expect(container.textContent).toContain("Unexpected error")
    expect(container.textContent).toContain("caught action failed")
    expect(container.textContent).toContain("errorModalHost.test")
    expect(button("Copy")).toBeDefined()
    expect(button("Report")).toBeDefined()
    expect(button("Close")).toBeDefined()
  })
})

describe("the device a report says it came from", () => {
  const CREATE = {
    rpId: "localhost",
    rpName: "test",
    userName: "@alice",
    prfFirstSalt: new Uint8Array(32),
  }
  const ASSERT = { rpId: "localhost", challenge: new Uint8Array(32) }

  let container: HTMLDivElement
  let root: Root
  let raise: (title: string) => void
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true } as Response))

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    fetchMock.mockClear()
    vi.unstubAllGlobals()
    localStorage.removeItem(PASSKEY_ENVIRONMENT_KEY)
  })

  /** A fresh page load: its own tracker and modal, over an iCloud Keychain authenticator. */
  async function load() {
    vi.resetModules()
    const { passkeyTelemetry } = await import("../../src/lib/passkeyTelemetry")
    const errors = await import("../../src/errors/errorModal")
    const { ErrorModalHost: Host } = await import("../../src/errors/ErrorModalHost")
    act(() => root.render(<Host />))
    raise = (title) =>
      act(() => errors.showErrorModal({ title, message: "failed", showReport: true }))
    const fake = new FakePasskeyCeremony({
      aaguid: APPLE_ICLOUD_AAGUID,
      onRequest: passkeyTelemetry.requestHook,
    })
    return { fake, ceremony: passkeyTelemetry.wrap(fake), passkeyTelemetry }
  }

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)

  /** Reports the modal on screen, then closes it; the device its report sent. */
  async function reportedEnv(): Promise<Record<string, unknown>> {
    await act(async () => button("Report")!.click())
    const [, init] = fetchMock.mock.calls.filter(([url]) => url.endsWith("/error-reports")).at(-1)!
    act(() => button("Close")!.click())
    return JSON.parse(String(init!.body)).env
  }

  const reportedProvider = async () => (await reportedEnv()).provider

  const recordEarlierVisit = (aaguid: string | undefined) =>
    localStorage.setItem(
      PASSKEY_ENVIRONMENT_KEY,
      JSON.stringify(
        buildPasskeyEnvironment({
          aaguid,
          posture: "laptop",
          userAgent: parseUserAgent({ userAgent: "" }),
        }),
      ),
    )

  it("keeps on a queued report the AAGUID of the other provider current when it was raised", async () => {
    const unnamed = "0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f"
    const { fake, ceremony } = await load()
    fake.opts.aaguid = unnamed
    await ceremony.create(CREATE)
    raise("First")
    fake.opts.aaguid = ONEPASSWORD_AAGUID
    await ceremony.create(CREATE)
    raise("Second")

    expect(await reportedEnv()).toMatchObject({ provider: "other", aaguid: unnamed })
    const second = await reportedEnv()
    expect(second.provider).toBe("1password")
    expect(second).not.toHaveProperty("aaguid")
  })

  it("names no provider after a request for a passkey this page did not create, rejected before an answer", async () => {
    const { ceremony } = await load()
    await ceremony.create(CREATE)
    raise("Created")
    expect(await reportedProvider()).toBe("icloud_keychain")

    const assertion = ceremony.assert({ ...ASSERT, credentialIds: ["not-on-this-authenticator"] })
    await expect(assertion).rejects.toThrow("unknown credential")
    raise("Asserted")
    expect(await reportedProvider()).toBe("unknown")
  })

  it("names the passkey just created over the one an earlier visit recorded", async () => {
    recordEarlierVisit(ONEPASSWORD_AAGUID)
    const { ceremony } = await load()
    raise("Before")
    expect(await reportedProvider()).toBe("1password")

    await ceremony.create(CREATE)
    raise("After")
    expect(await reportedProvider()).toBe("icloud_keychain")
  })

  it("still shows and reports the error, with no device, when the device cannot be read", async () => {
    const { passkeyTelemetry } = await load()
    vi.spyOn(passkeyTelemetry, "snapshot").mockImplementation(() => {
      throw new Error("no environment")
    })
    raise("Unreadable")
    expect(container.textContent).toContain("Unreadable")

    await act(async () => button("Report")!.click())
    const reports = fetchMock.mock.calls.filter(([url]) => url.endsWith("/error-reports"))
    expect(reports).toHaveLength(1)
    const body = JSON.parse(String(reports[0]![1]!.body))
    expect(body).toMatchObject({ title: "Unreadable", message: "failed", platform: "web" })
    expect(body).not.toHaveProperty("env")
    expect(button("Sent")).toBeDefined()
  })
})
