import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CameraState } from "../../../src/features/scan/cameraSession"
import type { ScanResult } from "../../../src/features/scan/scanPayload"
import { ScannerModal, type ScannerModalProps } from "../../../src/features/scan/ScannerModal"

const fixture = vi.hoisted(() => ({
  state: { kind: "requesting" } as CameraState,
  onPayload: (_text: string) => {},
  stop: vi.fn(),
  restart: vi.fn(),
  setTorch: vi.fn(async () => true),
  videoRef: vi.fn(),
}))
vi.mock("../../../src/features/scan/useQrCamera", () => ({
  useQrCamera: (_enabled: boolean, onPayload: (text: string) => void) => {
    fixture.onPayload = onPayload
    return fixture
  },
}))
vi.mock("@obsidion/web-ds", () => ({
  Icon: () => <span />,
  GradientText: () => <span />,
  TopNavIconButton: () => <span />,
}))

let root: Root
let host: HTMLDivElement
let props: ScannerModalProps
function render() {
  act(() => root.render(<ScannerModal {...props} />))
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text || node.getAttribute("aria-label") === text,
  )!
}
function fill(value: string) {
  const input = host.querySelector("input")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function submit() {
  act(() =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  )
}
const valid: ScanResult = {
  kind: "destination",
  destination: { to: "/contacts", state: { searchTag: "alice" } },
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.state = { kind: "requesting" }
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  props = {
    onClose: vi.fn(),
    onShare: vi.fn(),
    resolvePayload: vi.fn(async () => valid),
    onDestination: vi.fn(),
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("isolated ScannerModal", () => {
  it("keeps paste and exit available while permission is unanswered", async () => {
    render()
    expect(host.querySelector("video")).not.toBeNull()
    expect(button("Close scanner")).toBeDefined()
    fill("@alice")
    expect(button("Continue").disabled).toBe(false)
    await act(async () => submit())
    expect(props.resolvePayload).toHaveBeenCalledWith("@alice")
    expect(props.onDestination).toHaveBeenCalledWith(
      valid.kind === "destination" ? valid.destination : null,
    )
  })
  it("uses one resolver and one handoff for simultaneous camera and manual input", async () => {
    let resolve!: (result: ScanResult) => void
    props.resolvePayload = vi.fn(
      () =>
        new Promise<ScanResult>((done) => {
          resolve = done
        }),
    )
    render()
    fill("@bob")
    act(() => fixture.onPayload("@alice"))
    submit()
    expect(props.resolvePayload).toHaveBeenCalledOnce()
    expect(props.resolvePayload).toHaveBeenCalledWith("@alice")
    expect(button("Continue").disabled).toBe(true)
    await act(async () => resolve(valid))
    act(() => fixture.onPayload("@bob"))
    expect(props.onDestination).toHaveBeenCalledOnce()
  })
  it.each(["Close scanner", "Show my QR code"])(
    "stops capture before %s and ignores pending classification",
    async (action) => {
      let resolve!: (result: ScanResult) => void
      props.resolvePayload = vi.fn(
        () =>
          new Promise<ScanResult>((done) => {
            resolve = done
          }),
      )
      let stopsAtExit = 0
      const leaving = vi.fn(() => {
        stopsAtExit = fixture.stop.mock.calls.length
      })
      if (action === "Close scanner") props.onClose = leaving
      else props.onShare = leaving
      render()
      act(() => fixture.onPayload("@alice"))
      const before = fixture.stop.mock.calls.length
      act(() => button(action).click())
      expect(stopsAtExit).toBeGreaterThan(before)
      await act(async () => resolve(valid))
      expect(props.onDestination).not.toHaveBeenCalled()
      expect(leaving).toHaveBeenCalledOnce()
    },
  )
  it("keeps the same video on invalid payload and retries through a new camera session", async () => {
    props.resolvePayload = vi.fn(
      async (): Promise<ScanResult> => ({ kind: "error", message: "This code is invalid." }),
    )
    render()
    const video = host.querySelector("video")
    await act(async () => fixture.onPayload("bad code"))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This code is invalid.")
    expect(host.querySelector("video")).toBe(video)
    act(() => button("Try camera again").click())
    expect(fixture.restart).toHaveBeenCalledWith(undefined)
    expect(host.querySelector("video")).toBe(video)
  })
  it.each(["denied", "unavailable", "decode-error"] as const)(
    "shows %s recovery while keeping paste and video mounted",
    (kind) => {
      fixture.state = { kind, message: `Specific ${kind} instructions` }
      render()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(`Specific ${kind}`)
      expect(host.querySelector("video")).not.toBeNull()
      expect(host.querySelector("input")?.disabled).toBe(false)
      expect(button("Try camera again")).toBeDefined()
    },
  )
  it("offers explicit resume after backgrounding", () => {
    fixture.state = { kind: "paused" }
    render()
    act(() => button("Resume camera").click())
    expect(fixture.restart).toHaveBeenCalledOnce()
  })
  it("hides unsupported controls and absent Share, then uses actual camera capabilities", async () => {
    props.onShare = undefined
    fixture.state = { kind: "active", torch: false, torchOn: false, alternatives: [] }
    render()
    expect(button("Show my QR code")).toBeUndefined()
    expect(button("Turn flashlight on")).toBeUndefined()
    expect(host.querySelector("select")).toBeNull()
    fixture.state = {
      kind: "active",
      torch: true,
      torchOn: false,
      deviceId: "rear",
      alternatives: [{ deviceId: "front", label: "Front camera" } as MediaDeviceInfo],
    }
    render()
    await act(async () => button("Turn flashlight on").click())
    expect(fixture.setTorch).toHaveBeenCalledWith(true)
    act(() => {
      const select = host.querySelector("select")!
      select.value = "front"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(fixture.restart).toHaveBeenCalledWith("front")
  })
  it.each(["manual", "camera"] as const)(
    "attributes an error to the accepted %s submission during a race",
    async (source) => {
      let resolve!: (result: ScanResult) => void
      props.resolvePayload = vi.fn(
        () =>
          new Promise<ScanResult>((done) => {
            resolve = done
          }),
      )
      render()
      fill("manual code")
      if (source === "manual") {
        submit()
        act(() => fixture.onPayload("camera code"))
      } else {
        act(() => fixture.onPayload("camera code"))
        submit()
      }
      await act(async () => resolve({ kind: "error", message: "Invalid code" }))
      const input = host.querySelector("input")!
      expect(props.resolvePayload).toHaveBeenCalledOnce()
      expect(input.getAttribute("aria-invalid")).toBe(String(source === "manual"))
      expect(input.hasAttribute("aria-describedby")).toBe(source === "manual")
    },
  )
  it.each(["retry", "resume", "torch", "camera"] as const)(
    "keeps focus in the dialog when the %s control disappears",
    (control) => {
      fixture.state =
        control === "retry"
          ? { kind: "denied", message: "Allow access" }
          : control === "resume"
          ? { kind: "paused" }
          : {
              kind: "active",
              torch: true,
              torchOn: false,
              alternatives: [{ deviceId: "front", label: "Front" } as MediaDeviceInfo],
            }
      render()
      const element =
        control === "camera"
          ? host.querySelector("select")!
          : button(
              control === "retry"
                ? "Try camera again"
                : control === "resume"
                ? "Resume camera"
                : "Turn flashlight on",
            )
      element.focus()
      expect(document.activeElement).toBe(element)
      fixture.state =
        control === "camera"
          ? { kind: "requesting" }
          : { kind: "active", torch: false, torchOn: false, alternatives: [] }
      render()
      expect([button("Close scanner"), host.querySelector(".ww-scan")]).toContain(
        document.activeElement,
      )
    },
  )
  it("allows one close after a destination if parent unmount is delayed without stealing destination focus", async () => {
    const destination = document.createElement("button")
    document.body.append(destination)
    props.onDestination = vi.fn(() => destination.focus())
    try {
      render()
      fill("@alice")
      await act(async () => submit())
      expect(document.activeElement).toBe(destination)
      act(() => button("Close scanner").click())
      act(() => button("Close scanner").click())
      act(() => fixture.onPayload("@bob"))
      expect(props.onClose).toHaveBeenCalledOnce()
      expect(props.onDestination).toHaveBeenCalledOnce()
      expect(props.resolvePayload).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(destination)
    } finally {
      destination.remove()
    }
  })
  it("ignores an asynchronous handoff after the surface unmounts", async () => {
    let resolve!: (result: ScanResult) => void
    props.resolvePayload = vi.fn(
      () =>
        new Promise<ScanResult>((done) => {
          resolve = done
        }),
    )
    render()
    act(() => fixture.onPayload("@alice"))
    act(() => root.render(null))
    await act(async () => resolve(valid))
    expect(props.onDestination).not.toHaveBeenCalled()
    expect(fixture.stop).toHaveBeenCalled()
  })
})
