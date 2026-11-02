/** The non-contact inbox lists a request, and so offers to pay it, only once its payments are read. */
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import {
  ConfigProvider,
  ContactStorage,
  LocalConfigStore,
  type StoredRequest,
} from "@obsidion/front-core"
import { useNonContactRequests } from "../../../src/features/requests/useNonContactRequests"
import {
  activeNamespace,
  closeSession,
  switchSession,
  session,
} from "../../../src/platform/session"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { WebStorageAdapter, webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { testWalletDbs } from "../../support/fakeWalletDb"

afterEach(closeSession)

const pending: StoredRequest = {
  id: "r1",
  contactTag: "mina",
  amount: 42,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: Date.now() - 60_000,
  kind: "contact",
}

let listed: string[] = []
function Inbox() {
  listed = useNonContactRequests().requests.map((r) => r.id)
  return null
}

describe("useNonContactRequests", () => {
  it("lists nothing to pay until the requests and their payments load", async () => {
    switchSession(activeNamespace())
    await session().requests.add(pending)
    // A reload whose requests load before the activity rows that would pay them.
    closeSession()
    await walletStorage.batch(() =>
      walletStorage.removeItem(`${activeNamespace().prefix}acct/meta/activity`),
    )
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    testWalletDbs().onApply = async (_version, ops) => {
      if (ops.some(([key]) => key.endsWith("acct/meta/activity"))) await landed
    }
    switchSession(activeNamespace())
    ContactStorage.get(webStorage)
    const config = new LocalConfigStore(new WebStorageAdapter())
    const root = createRoot(document.createElement("div"))
    await act(async () =>
      root.render(
        <ConfigProvider service={config}>
          <Inbox />
        </ConfigProvider>,
      ),
    )
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(listed).toEqual([])
    await act(async () => land())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(listed).toEqual(["r1"])
    act(() => root.unmount())
  })
})
