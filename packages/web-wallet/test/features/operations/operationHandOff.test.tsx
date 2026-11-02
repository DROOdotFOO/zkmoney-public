/**
 * A flow's working phase, wired once: the working beat until the user's part is over, then one
 * leave: at the end of the passkey ceremony, when the operation starts proving, or when it leaves
 * the page. A failed flow or a failed ceremony stays.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provingProgress } from "@obsidion/proving-progress"
import { getOperationStore, type OperationFlow } from "../../../src/features/operations/operations"
import {
  OperationHandOff,
  type OperationHandOffHandle,
} from "../../../src/features/operations/OperationHandOff"

const hash = `0x${"ab".repeat(32)}`

let container: HTMLDivElement
let root: Root
let onLeave: ReturnType<typeof vi.fn>
let ids: string[]

beforeEach(() => {
  container = document.createElement("div")
  root = createRoot(container)
  onLeave = vi.fn()
  ids = []
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const id of ids) await getOperationStore().remove(id)
})

async function begin(operationId: string, flow: OperationFlow = "send", parent?: string) {
  ids.push(operationId)
  await act(async () => {
    await getOperationStore().begin({ operationId, flow, summary: "$25", scope: null, parent })
  })
}
const store = () => getOperationStore()
const render = () => act(async () => root.render(<OperationHandOff onLeave={onLeave} />))

describe("OperationHandOff", () => {
  it("holds the working beat through the ceremony, then leaves as it ends", async () => {
    await begin("op-a")
    await render()
    expect(container.textContent).toContain("Preparing transaction")
    expect(container.textContent).toContain("Keep this tab open")
    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey")
    expect(onLeave).not.toHaveBeenCalled()
    await act(async () => provingProgress.emitSigningEnd())
    expect(onLeave).toHaveBeenCalledOnce()
    // Its record now reports a failure before proving, since the screen is gone.
    expect(store().get("op-a")?.handedOffAt).toBeDefined()
    await act(async () => store().markSent("op-a", hash))
    await act(async () => store().settle("op-a", hash))
    expect(onLeave).toHaveBeenCalledOnce()
  })

  it("holds a flow with several ceremonies and proofs until it says it is prepared", async () => {
    await begin("op-prepared")
    const prepared = (done: boolean) =>
      act(async () =>
        root.render(<OperationHandOff onLeave={onLeave} until="prepared" prepared={done} />),
      )
    await prepared(false)
    await act(async () => provingProgress.emitSigningStart())
    await act(async () => provingProgress.emitSigningEnd())
    expect(container.textContent).toContain("Proving privately")
    await act(async () => provingProgress.emitStageStart("proving", "op-prepared"))
    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey")
    expect(onLeave).not.toHaveBeenCalled()
    await prepared(true)
    expect(onLeave).toHaveBeenCalledOnce()
    expect(store().get("op-prepared")?.handedOffAt).toBeDefined()
  })

  it("leaves when a flow with no ceremony starts proving", async () => {
    await begin("op-no-ceremony")
    await render()
    await act(async () => provingProgress.emitStageStart("proving", "op-no-ceremony"))
    expect(onLeave).toHaveBeenCalledOnce()
  })

  it("leaves when the operation settles or is left to the chain first", async () => {
    await begin("op-fast")
    await render()
    await act(async () => store().settle("op-fast", hash))
    expect(onLeave).toHaveBeenCalledOnce()

    onLeave = vi.fn()
    await act(async () => root.render(<OperationHandOff key="b" onLeave={onLeave} />))
    await begin("op-node")
    await act(async () => store().markSent("op-node", hash))
    expect(onLeave).not.toHaveBeenCalled()
    await act(async () => store().release("op-node"))
    expect(onLeave).toHaveBeenCalledOnce()
  })

  it("with until=sent, holds the beat through the ceremony and the proof, and leaves once sent", async () => {
    await begin("op-held")
    await act(async () => root.render(<OperationHandOff onLeave={onLeave} until="sent" />))
    await act(async () => provingProgress.emitSigningStart())
    await act(async () => provingProgress.emitSigningEnd())
    expect(onLeave).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Proving privately")
    await act(async () => provingProgress.emitStageStart("proving", "op-held"))
    expect(onLeave).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Keep this tab open")
    await act(async () => store().markSent("op-held", hash))
    expect(onLeave).toHaveBeenCalledOnce()
  })

  it("leaves the same way, once, when its surface is closed while the flow runs", async () => {
    await begin("op-closed")
    const handle = createRef<OperationHandOffHandle>()
    await act(async () =>
      root.render(<OperationHandOff ref={handle} onLeave={onLeave} until="sent" />),
    )
    await act(async () => handle.current!.leave())
    expect(onLeave).toHaveBeenCalledOnce()
    // The bell, not the closed screen, reports a failure before proving.
    expect(store().get("op-closed")?.handedOffAt).toBeDefined()
    await act(async () => store().markSent("op-closed", hash))
    expect(onLeave).toHaveBeenCalledOnce()
  })

  it("stays for a flow that failed, so its screen can say why", async () => {
    await begin("op-fail")
    await render()
    await act(async () => store().fail("op-fail", "boom"))
    expect(onLeave).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Preparing transaction")
  })

  it("stays on the beat when the ceremony failed", async () => {
    await begin("op-cancel")
    await render()
    await act(async () => provingProgress.emitSigningEnd(undefined, true))
    await act(async () => store().remove("op-cancel"))
    expect(onLeave).not.toHaveBeenCalled()
  })

  it("follows an operation that starts after it mounts", async () => {
    await render()
    await begin("op-late")
    await act(async () => provingProgress.emitStageStart("proving", "op-late"))
    expect(onLeave).toHaveBeenCalledOnce()
  })

  it("keeps the Cancel button's space once the flow withdraws it, so the card holds still", async () => {
    await begin("op-a")
    const cancel = () => container.querySelector<HTMLButtonElement>(".ww-pay__cancel")
    await act(async () => root.render(<OperationHandOff onLeave={onLeave} onCancel={() => {}} />))
    expect(cancel()?.disabled).toBe(false)
    expect(cancel()?.style.visibility).toBe("")
    await act(async () => root.render(<OperationHandOff onLeave={onLeave} />))
    expect(cancel()?.disabled).toBe(true)
    expect(cancel()?.style.visibility).toBe("hidden")
    await act(async () => provingProgress.emitSigningStart())
    expect(container.textContent).toContain("Confirm with passkey")
    expect(cancel()?.style.visibility).toBe("hidden")
  })

  it("leaves no Cancel space on a card that never offered it", async () => {
    await begin("op-a")
    await render()
    expect(container.querySelector(".ww-pay__cancel")).toBeNull()
  })

  it("names a running child operation in place of the preparing text", async () => {
    await begin("op-root", "migration")
    await render()
    await begin("op-child", "paylink-claim", "op-root")
    expect(container.textContent).toContain("Receiving")
    expect(container.textContent).not.toContain("Preparing transaction")
    await act(async () => store().remove("op-child"))
    expect(container.textContent).toContain("Preparing transaction")
    expect(onLeave).not.toHaveBeenCalled()
  })
})

// The hand-off lives in the component alone: a screen renders it and says where to leave to.
it("leaves no screen its own hand-off state", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
    )
  const handOffState =
    /useBackgroundHandOff|handOff\.(reset|leave|handedOff|proving)|provingProgress\.on\("signing-end"/
  const offenders = files(join(__dirname, "../../../src")).filter((f) =>
    handOffState.test(readFileSync(f, "utf8")),
  )
  expect(offenders.map((f) => f.slice(f.indexOf("src/")))).toEqual([
    "src/features/operations/OperationHandOff.tsx",
  ])
})
