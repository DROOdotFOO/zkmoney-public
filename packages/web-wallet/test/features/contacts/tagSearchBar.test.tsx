import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  phone: false,
  navigate: vi.fn(),
  save: vi.fn(),
  addOffer: false,
  notUpgraded: false,
  cancel: vi.fn(),
  location: {
    pathname: "/",
    search: "",
    hash: "",
    key: "initial",
    state: null as Record<string, unknown> | null,
  },
}))
vi.mock("../../../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => state.phone }))
vi.mock("react-router-dom", () => ({
  useNavigate: () => state.navigate,
  useLocation: () => state.location,
}))
vi.mock("@obsidion/front-core", async (original) => ({
  ...(await original<typeof import("@obsidion/front-core")>()),
  useContactsDirectory: () => ({
    contacts: [{ id: "ada", tag: "ada", name: "Ada", addressKind: "aztec-l2" }],
    refresh: vi.fn(),
  }),
}))
vi.mock("@obsidion/web-ds", () => ({
  ContactRow: ({ tag, onClick }: { tag: string; onClick: () => void }) => (
    <button onClick={onClick}>{tag}</button>
  ),
  ListRow: ({ title, trailing }: { title: string; trailing?: ReactNode }) => (
    <span>
      {title}
      {trailing}
    </span>
  ),
  GradientSpinner: () => null,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  avatarColors: () => [],
}))
vi.mock("../../../src/features/contacts/useInlineContactSearch", () => ({
  useInlineContactSearch: () => ({
    panel: state.notUpgraded
      ? { kind: "not-upgraded", tag: "grace" }
      : state.addOffer
      ? { kind: "add-offer", tag: "grace" }
      : { kind: "none" },
    save: state.save,
    cancel: state.cancel,
  }),
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
import { TagSearchBar } from "../../../src/features/contacts/TagSearchBar"

describe.each([false, true])("TagSearchBar phone=%s", (phone) => {
  let host: HTMLDivElement
  let root: Root
  const results = () => host.querySelector(".ww-search__results")
  const input = () => host.querySelector("input")!
  const fill = (value: string) =>
    act(() => {
      input().focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input(),
        value,
      )
      input().dispatchEvent(new Event("input", { bubbles: true }))
    })

  beforeEach(() => {
    vi.clearAllMocks()
    state.phone = phone
    state.addOffer = false
    state.notUpgraded = false
    state.location = { pathname: "/", search: "", hash: "", key: "initial", state: null }
    state.save.mockResolvedValue({ tag: "grace" })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() =>
      root.render(
        <>
          <TagSearchBar />
          <button id="outside">Outside</button>
        </>,
      ),
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  describe("search result focus", () => {
    it("keeps a result available through a null-target blur before its click", () => {
      fill("ada")
      expect(results()).not.toBeNull()
      act(() => input().blur())
      expect(results()).not.toBeNull()
      act(() => results()!.querySelector("button")!.click())
      expect(state.navigate).toHaveBeenCalledWith("/contacts/ada")
    })
    it("opens an unsaved tag without saving it, through a null-target blur", async () => {
      state.addOffer = true
      fill("grace")
      act(() => input().blur())
      expect(results()).not.toBeNull()
      await act(async () => results()!.querySelector("button")!.click())
      expect(state.navigate).toHaveBeenCalledWith("/contacts/grace")
      expect(state.save).not.toHaveBeenCalled()
    })
    it("opens the chat of a tag that hasn't upgraded, so its history shows", async () => {
      state.notUpgraded = true
      fill("grace")
      const row = results()!.querySelector("button")!
      expect(row.textContent).toContain("@grace hasn't upgraded yet")
      await act(async () => row.click())
      expect(state.navigate).toHaveBeenCalledWith("/contacts/grace")
    })
    it("ends the results with See all contacts, only while results show", () => {
      act(() => input().focus())
      expect(results()).toBeNull()
      fill("ada")
      const rows = [...results()!.querySelectorAll("button")]
      expect(rows.at(-1)!.textContent).toContain("See all contacts")
      act(() => rows.at(-1)!.click())
      expect(state.navigate).toHaveBeenCalledWith("/contacts")
    })
    it("dismisses results when keyboard focus moves outside", () => {
      fill("ada")
      act(() => host.querySelector<HTMLButtonElement>("#outside")!.focus())
      expect(results()).toBeNull()
    })
    it("dismisses results on an outside pointer interaction", () => {
      fill("ada")
      act(() =>
        host
          .querySelector("#outside")!
          .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
      )
      expect(results()).toBeNull()
    })
  })

  describe("shared Contacts route seed", () => {
    it("consumes a seed once, focuses the field, preserves other state and requires explicit Add", () => {
      state.location = {
        pathname: "/contacts",
        search: "?view=all",
        hash: "#list",
        key: "seed",
        state: { searchTag: "@NewFriend.zk.money", keep: "origin" },
      }
      act(() => root.render(<TagSearchBar />))
      expect(input().value).toBe("newfriend")
      expect(document.activeElement).toBe(input())
      expect(state.navigate).toHaveBeenCalledWith(
        { pathname: "/contacts", search: "?view=all", hash: "#list" },
        { replace: true, state: { keep: "origin" } },
      )
      expect(state.save).not.toHaveBeenCalled()
      state.location = { ...state.location, key: "consumed", state: { keep: "origin" } }
      act(() => root.render(<TagSearchBar />))
      fill("edited")
      act(() => root.render(<TagSearchBar />))
      expect(input().value).toBe("edited")
      state.location = {
        ...state.location,
        key: "second-seed",
        state: { searchTag: "secondfriend" },
      }
      act(() => root.render(<TagSearchBar />))
      expect(input().value).toBe("secondfriend")
      expect(state.save).not.toHaveBeenCalled()
    })
    it("focuses an empty field on the Add contact signal and clears it from history", () => {
      state.location = {
        pathname: "/contacts",
        search: "",
        hash: "",
        key: "add",
        state: { searchFocus: true },
      }
      act(() => root.render(<TagSearchBar />))
      expect(document.activeElement).toBe(input())
      expect(input().value).toBe("")
      expect(state.navigate).toHaveBeenCalledWith(
        { pathname: "/contacts", search: "", hash: "" },
        { replace: true, state: null },
      )
    })
    it("does not consume a route seed outside Contacts", () => {
      state.location = { ...state.location, key: "other", state: { searchTag: "friend" } }
      act(() => root.render(<TagSearchBar />))
      expect(input().value).toBe("")
      expect(state.navigate).not.toHaveBeenCalled()
    })
  })
})
