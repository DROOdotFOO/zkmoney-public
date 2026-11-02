import { afterEach, describe, expect, it, vi } from "vitest"
import { CameraSession, type CameraState } from "../../../src/features/scan/cameraSession"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
  const events = new EventTarget()
  const track = {
    readyState: "live",
    stop: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    getCapabilities: vi.fn(() => ({ torch: true })),
    getSettings: vi.fn(() => ({ deviceId: "rear" })),
    applyConstraints: vi.fn(async () => {}),
  }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream
  const video = document.createElement("video")
  video.play = vi.fn(async () => {})
  video.pause = vi.fn()
  const mediaDevices = {
    getUserMedia: vi.fn(async () => stream),
    enumerateDevices: vi.fn(async (): Promise<MediaDeviceInfo[]> => []),
  }
  const decoder = { decode: vi.fn(async (): Promise<string | null> => null), destroy: vi.fn() }
  const onState = vi.fn<(state: CameraState) => void>()
  const onPayload = vi.fn()
  const createDecoder = vi.fn(() => decoder)
  const options = {
    video,
    mediaDevices,
    onState,
    onPayload,
    createDecoder,
    readFrame: () => ({} as ImageData),
  }
  return {
    options,
    track,
    stream,
    video,
    mediaDevices,
    decoder,
    onState,
    onPayload,
    createDecoder,
    events,
  }
}

afterEach(() => vi.useRealTimers())

describe("CameraSession", () => {
  it("stops a stream returned after unanswered permission was dismissed", async () => {
    const f = fixture()
    const permission = deferred<MediaStream>()
    f.mediaDevices.getUserMedia.mockReturnValue(permission.promise)
    const camera = new CameraSession(f.options)
    const starting = camera.start()
    expect(f.onState).toHaveBeenLastCalledWith({ kind: "requesting" })
    camera.stop()
    permission.resolve(f.stream)
    await starting
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.video.play).not.toHaveBeenCalled()
    expect(f.createDecoder).not.toHaveBeenCalled()
    expect(f.onState).toHaveBeenCalledOnce()
  })

  it("releases capture while video.play is pending and ignores its later completion", async () => {
    const f = fixture()
    const play = deferred<void>()
    f.video.play = vi.fn(() => play.promise)
    const camera = new CameraSession(f.options)
    const starting = camera.start()
    await Promise.resolve()
    expect(f.video.srcObject).toBe(f.stream)
    camera.stop()
    play.resolve()
    await starting
    expect(f.video.srcObject).toBeNull()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.createDecoder).not.toHaveBeenCalled()
  })

  it.each(["NotAllowedError", "SecurityError", "NotReadableError", "NotFoundError"])(
    "handles %s without creating a decoder",
    async (name) => {
      const f = fixture()
      f.mediaDevices.getUserMedia.mockRejectedValue(new DOMException("camera failure", name))
      await new CameraSession(f.options).start()
      expect(f.onState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: ["NotAllowedError", "SecurityError"].includes(name) ? "denied" : "unavailable",
        }),
      )
      expect(f.createDecoder).not.toHaveBeenCalled()
    },
  )

  it("prefers rear video, never requests audio, and emits one stopped-stream handoff", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.decoder.decode.mockResolvedValue("@alice")
    let stoppedAtHandoff = 0
    f.onPayload.mockImplementation(() => { stoppedAtHandoff = f.track.stop.mock.calls.length })
    const camera = new CameraSession(f.options)
    await camera.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({ facingMode: { ideal: "environment" } }),
      }),
    )
    expect(stoppedAtHandoff).toBe(1)
    expect(f.onPayload).toHaveBeenCalledOnce()
    expect(f.onPayload).toHaveBeenCalledWith("@alice")
    expect(f.decoder.decode).toHaveBeenCalledOnce()
    expect(f.video.srcObject).toBeNull()
    camera.stop()
    expect(f.track.stop).toHaveBeenCalledOnce()
  })

  it("sets inline muted playback before playing the camera", async () => {
    const f = fixture()
    let playback: object | undefined
    f.video.play = vi.fn(async () => {
      playback = { muted: f.video.muted, playsInline: f.video.playsInline, inlineAttribute: f.video.hasAttribute("playsinline") }
    })
    const camera = new CameraSession(f.options)
    await camera.start()
    expect(playback).toEqual({ muted: true, playsInline: true, inlineAttribute: true })
    camera.stop()
  })
  it("does not misreport a playback rejection as camera permission denied", async () => {
    const f = fixture()
    f.video.play = vi.fn(async () => { throw new DOMException("Playback refused", "NotAllowedError") })
    await new CameraSession(f.options).start()
    expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "unavailable" }))
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.createDecoder).not.toHaveBeenCalled()
  })

  it("has one frame in flight and discards a decoded result after stop", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const frame = deferred<string | null>()
    f.decoder.decode.mockReturnValue(frame.promise)
    const camera = new CameraSession(f.options)
    await camera.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.decoder.decode).toHaveBeenCalledOnce()
    camera.stop()
    frame.resolve("@alice")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(f.onPayload).not.toHaveBeenCalled()
    expect(f.decoder.destroy).toHaveBeenCalled()
  })

  it("continues after an empty frame and releases the stream on a decoder failure", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.decoder.decode.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("worker failed"))
    await new CameraSession(f.options).start()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.decoder.decode).toHaveBeenCalledTimes(2)
    expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "decode-error" }))
    expect(f.track.stop).toHaveBeenCalledOnce()
  })

  it("surfaces an ended track and does not keep decoding", async () => {
    vi.useFakeTimers()
    const f = fixture()
    await new CameraSession(f.options).start()
    f.events.dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(500)
    expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "unavailable" }))
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.decoder.decode).toHaveBeenCalledOnce()
  })

  it("offers only distinct labeled alternative cameras and uses exact device selection", async () => {
    const f = fixture()
    f.mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: "videoinput", deviceId: "rear", label: "Rear" },
      { kind: "videoinput", deviceId: "front", label: "Front" },
      { kind: "videoinput", deviceId: "front", label: "Front duplicate" },
      { kind: "videoinput", deviceId: "unknown", label: "" },
      { kind: "audioinput", deviceId: "mic", label: "Microphone" },
    ] as MediaDeviceInfo[])
    const camera = new CameraSession({ ...f.options, deviceId: "rear" })
    await camera.start()
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ deviceId: { exact: "rear" } }) }),
    )
    expect(f.onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ alternatives: [expect.objectContaining({ deviceId: "front" })] }),
    )
    camera.stop()
  })

  it("does not show a failed torch control as active", async () => {
    const f = fixture()
    const camera = new CameraSession(f.options)
    await camera.start()
    expect(await camera.setTorch(true)).toBe(true)
    expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ torchOn: true }))
    camera.stop()
    expect(await camera.setTorch(false)).toBe(false)
    expect(f.track.applyConstraints).toHaveBeenCalledOnce()
  })
  it("keeps decoding and hides the torch when turning it on fails", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const camera = new CameraSession(f.options)
    await camera.start()
    f.track.applyConstraints.mockRejectedValueOnce(new Error("unsupported"))
    expect(await camera.setTorch(true)).toBe(false)
    expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "active", torch: false, torchOn: false }))
    expect(f.track.stop).not.toHaveBeenCalled()
    expect(f.video.srcObject).toBe(f.stream)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.decoder.decode.mock.calls.length).toBeGreaterThan(1)
    camera.stop()
  })
  it("releases an enabled torch if the camera rejects turning it off", async () => {
    const f = fixture()
    const camera = new CameraSession(f.options)
    await camera.start()
    expect(await camera.setTorch(true)).toBe(true)
    f.track.applyConstraints.mockRejectedValueOnce(new Error("unsupported"))
    expect(await camera.setTorch(false)).toBe(false)
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "unavailable" }))
  })
})
