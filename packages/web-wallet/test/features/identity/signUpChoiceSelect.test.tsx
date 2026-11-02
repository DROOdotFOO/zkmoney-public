import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SignUpChoiceSelect,
  type SignUpChoiceOption,
} from "../../../src/features/identity/SignUpChoiceSelect"

const OPTIONS: SignUpChoiceOption[] = [
  {
    id: "1password",
    icon: "lock",
    label: "1Password",
    description: "Saved by the 1Password extension in this browser",
  },
  {
    id: "computer",
    icon: "fingerprint",
    label: "This Mac",
    description: "Saved in iCloud Keychain or Google Password Manager",
  },
  {
    id: "phone",
    icon: "qr-code",
    label: "Your phone",
    description: "Scan a QR code to save it on your phone",
  },
  {
    id: "key",
    icon: "key",
    label: "Security key",
    description: "A YubiKey 5, Trezor or Ledger you plug in or tap",
  },
]
const LABEL = "Where should your passkey live?"

describe("SignUpChoiceSelect", () => {
  let container: HTMLDivElement
  let root: Root
  let outside: HTMLButtonElement
  const onChange = vi.fn()
  const onSheetKey = vi.fn()

  beforeEach(() => {
    onChange.mockReset()
    onSheetKey.mockReset()
    outside = document.createElement("button")
    document.body.appendChild(outside)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    outside.remove()
  })

  function Sheet({
    options,
    initial,
    disabled,
    testId,
  }: {
    options: SignUpChoiceOption[]
    initial: string
    disabled?: boolean
    testId?: string
  }) {
    const [selected, setSelected] = useState(initial)
    return (
      <div onKeyDown={() => onSheetKey()}>
        <p id="picker-label">{LABEL}</p>
        <SignUpChoiceSelect
          options={options}
          selected={selected}
          onChange={(id) => {
            onChange(id)
            setSelected(id)
          }}
          labelledBy="picker-label"
          disabled={disabled}
          testId={testId}
        />
      </div>
    )
  }

  const render = (props: Partial<Parameters<typeof Sheet>[0]> = {}) =>
    act(() => root.render(<Sheet options={OPTIONS} initial="1password" {...props} />))

  const trigger = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="phone-steps-choice"]')!
  const listbox = () => container.querySelector<HTMLElement>('[role="listbox"]')
  const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
  const option = (id: string) =>
    container.querySelector<HTMLElement>(`[data-testid="phone-steps-option-${id}"]`)!
  const textOf = (ids: string | null) =>
    (ids ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ")
  const nameOf = (el: Element) => textOf(el.getAttribute("aria-labelledby"))
  const descriptionOf = (el: Element) => textOf(el.getAttribute("aria-describedby"))
  const active = () => document.getElementById(listbox()!.getAttribute("aria-activedescendant")!)

  const press = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  const key = (name: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...init,
    })
    act(() => void document.activeElement?.dispatchEvent(event))
    return event
  }
  const openByKey = () => {
    trigger().focus()
    key("ArrowDown")
  }

  it("shows the selected option's label and description, closed", () => {
    render({ initial: "computer" })
    expect(nameOf(trigger())).toBe(`${LABEL} This Mac`)
    expect(descriptionOf(trigger())).toBe(OPTIONS[1].description)
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox")
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(listbox()).toBeNull()
  })

  it("opens on a press with every option, each named by its label, the chosen one checked", () => {
    render()
    press(trigger())
    const list = listbox()!
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(trigger().getAttribute("aria-controls")).toBe(list.id)
    expect(nameOf(list)).toBe(LABEL)
    expect(list.getAttribute("tabindex")).toBe("-1")
    expect(document.activeElement).toBe(list)
    // usePickerDismiss scrolls the anchor's last child into view.
    expect(list.parentElement!.lastElementChild).toBe(list)
    expect(options().map(nameOf)).toEqual(OPTIONS.map((o) => o.label))
    expect(options().map(descriptionOf)).toEqual(OPTIONS.map((o) => o.description))
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ])
    // Its own icon on every row, and a check on the chosen one.
    expect(options().map((o) => o.querySelectorAll("svg").length)).toEqual([2, 1, 1, 1])
    expect(active()).toBe(option("1password"))
  })

  it("chooses on a press, closes, and returns focus to the trigger describing the new option", () => {
    render()
    press(trigger())
    press(option("phone"))
    expect(onChange.mock.calls).toEqual([["phone"]])
    expect(listbox()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger())
    expect(nameOf(trigger())).toBe(`${LABEL} Your phone`)
    expect(descriptionOf(trigger())).toBe(OPTIONS[2].description)
  })

  it.each(["ArrowDown", "ArrowUp"])(
    "%s on the trigger opens the list on the selected row",
    (name) => {
      render({ initial: "phone" })
      trigger().focus()
      expect(key(name).defaultPrevented).toBe(true)
      expect(listbox()).not.toBeNull()
      expect(document.activeElement).toBe(listbox())
      expect(active()).toBe(option("phone"))
    },
  )

  it("moves the active row with the arrows, Home and End, wrapping at the ends", () => {
    render()
    openByKey()
    key("ArrowDown")
    expect(active()).toBe(option("computer"))
    key("ArrowDown")
    expect(active()).toBe(option("phone"))
    key("ArrowUp")
    expect(active()).toBe(option("computer"))
    key("End")
    expect(active()).toBe(option("key"))
    key("ArrowDown")
    expect(active()).toBe(option("1password"))
    key("ArrowUp")
    expect(active()).toBe(option("key"))
    key("Home")
    expect(active()).toBe(option("1password"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("moves the active row on hover", () => {
    render()
    press(trigger())
    act(() => void option("key").dispatchEvent(new MouseEvent("mousemove", { bubbles: true })))
    expect(active()).toBe(option("key"))
  })

  it.each(["Enter", " "])("%j chooses the active row and returns focus to the trigger", (name) => {
    render()
    openByKey()
    key("End")
    key(name)
    expect(onChange.mock.calls).toEqual([["key"]])
    expect(listbox()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(descriptionOf(trigger())).toBe(OPTIONS[3].description)
  })

  it("closes on Escape, refocuses the trigger, and the sheet around it never sees the key", () => {
    render()
    openByKey()
    onSheetKey.mockReset()
    key("ArrowDown")
    expect(onSheetKey).toHaveBeenCalledOnce()
    onSheetKey.mockReset()
    expect(key("Escape").defaultPrevented).toBe(true)
    expect(listbox()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger())
    expect(onSheetKey).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("closes on Tab without choosing and leaves the move to the browser", () => {
    render()
    openByKey()
    key("ArrowDown")
    expect(key("Tab").defaultPrevented).toBe(false)
    expect(listbox()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(nameOf(trigger())).toBe(`${LABEL} 1Password`)
  })

  it("keeps Shift+Tab on the trigger inside a sheet, whose focus wrap would move it", async () => {
    const { ModalFrame } = await import("../../../src/ui/Modal")
    act(() =>
      root.render(
        <ModalFrame label={LABEL}>
          <div className="ww-modal" tabIndex={-1}>
            <Sheet options={OPTIONS} initial="1password" />
            <a href="#terms">Terms</a>
          </div>
        </ModalFrame>,
      ),
    )
    openByKey()
    key("Tab", { shiftKey: true })
    expect(listbox()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it("closes on a press outside without changing the choice", () => {
    render()
    press(trigger())
    press(outside)
    expect(listbox()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(onChange).not.toHaveBeenCalled()
    expect(nameOf(trigger())).toBe(`${LABEL} 1Password`)
  })

  it("closes on a second press of the trigger", () => {
    render()
    press(trigger())
    press(trigger())
    expect(listbox()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it("draws one option as a plain card: no button, no listbox, nothing to focus", () => {
    render({ options: [OPTIONS[2]], initial: "phone" })
    expect(container.querySelector("button")).toBeNull()
    expect(container.querySelector("[role]")).toBeNull()
    expect(container.querySelector("[tabindex]")).toBeNull()
    const card = container.querySelector(".ww-choice__card")!
    expect(card.textContent).toBe(`Your phone${OPTIONS[2].description}`)
    // The option's icon, and no chevron.
    expect(container.querySelectorAll("svg")).toHaveLength(1)
  })

  it("opens nothing while disabled", () => {
    render({ disabled: true })
    expect(trigger().disabled).toBe(true)
    press(trigger())
    act(
      () =>
        void trigger().dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        ),
    )
    expect(listbox()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
  })

  it("closes when disabled while open", () => {
    render()
    press(trigger())
    render({ disabled: true })
    expect(listbox()).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
  })
})
