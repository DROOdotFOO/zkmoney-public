import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@obsidion/web-ds", () => ({
  GradientInitialAvatar: () => null,
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  avatarColors: () => ["#000", "#fff"],
}))

const { ChatBubble } = await import("../../../src/features/contacts/ChatBubble/ChatBubble")

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

const outgoingRequest = {
  id: "req-1",
  role: "request-out" as const,
  amount: "-$45.00",
  timeLabel: "8:51",
}

describe("ChatBubble", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("styles the last action as primary unless it is marked secondary", async () => {
    const render = (actions: { label: string; onClick: () => void; secondary?: boolean }[]) =>
      act(async () => {
        root.render(
          <ChatBubble
            message={outgoingRequest as never}
            leftName="cyphergirl"
            rightName="me"
            actions={actions}
            onOpen={() => {}}
          />,
        )
      })
    const primary = () =>
      [...container.querySelectorAll<HTMLButtonElement>("[data-primary]")].map((b) => b.textContent)

    await render([
      { label: "Decline", onClick: () => {}, secondary: true },
      { label: "Send", onClick: () => {} },
    ])
    expect(primary()).toEqual(["Send"])
    await render([{ label: "Decline", onClick: () => {}, secondary: true }])
    expect(primary()).toEqual([])
  })

  it("keeps inline Cancel / Remind separate from the open-detail click", async () => {
    const onOpen = vi.fn()
    const onCancel = vi.fn()
    const onRemind = vi.fn()
    await act(async () => {
      root.render(
        <ChatBubble
          message={outgoingRequest as never}
          leftName="cyphergirl"
          rightName="me"
          actions={[
            { label: "Cancel", onClick: onCancel },
            { label: "Remind", onClick: onRemind },
          ]}
          onOpen={onOpen}
        />,
      )
    })
    const bubble = container.querySelector<HTMLElement>('[role="button"]')!
    // The detail control has no interactive descendants: the actions are its siblings.
    expect(bubble.querySelectorAll("button, a, [role='button'], [tabindex]")).toHaveLength(0)
    expect(bubble.textContent).toContain("Owes you")
    expect(bubble.textContent).toContain("$45.00")

    const [cancel, remind] = [...container.querySelectorAll("button")]
    await act(async () => cancel.click())
    await act(async () => remind.click())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onRemind).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()

    await act(async () => bubble.click())
    expect(onOpen).toHaveBeenCalledOnce()
    for (const key of ["Enter", " "]) {
      await act(async () => {
        bubble.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      })
    }
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it("shows the memo on transfers and the note on requests, nothing when absent", async () => {
    const render = (message: object) =>
      act(async () => {
        root.render(
          <ChatBubble
            message={message as never}
            leftName="cyphergirl"
            rightName="me"
            onOpen={() => {}}
          />,
        )
      })
    await render({
      id: "0x1",
      role: "received-confirmed",
      amount: "+$5.00",
      timeLabel: "8:51",
      memo: "for pizza",
    })
    expect(container.querySelector(".ww-bubble__memo")?.textContent).toBe("for pizza")
    await render({ ...outgoingRequest, memo: "dinner" })
    expect(container.querySelector(".ww-bubble__memo")?.textContent).toBe("dinner")
    await render(outgoingRequest)
    expect(container.querySelector(".ww-bubble__memo")).toBeNull()
  })

  it("opens a settled transfer's sheet instead of linking out to the explorer", async () => {
    const onOpen = vi.fn()
    await act(async () => {
      root.render(
        <ChatBubble
          message={
            {
              id: "0xfeed",
              role: "received-confirmed",
              amount: "+$45.00",
              timeLabel: "8:51",
              explorerUrl: "https://l2.example/tx/0xfeed",
            } as never
          }
          leftName="cyphergirl"
          rightName="me"
          onOpen={onOpen}
        />,
      )
    })
    expect(container.querySelector("a")).toBeNull()
    const bubble = container.querySelector<HTMLElement>('[aria-label="Transaction details"]')!
    await act(async () => bubble.click())
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
