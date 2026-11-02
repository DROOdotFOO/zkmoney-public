/**
 * The note typed on the pay form must reach its carriers — for a request the XMTP announce +
 * the requests store, for a send the on-chain `Transfer.meta` (via sendTokenSponsored's memo option)
 * and the activity row the rail writes before proving and advances in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import type { Activity } from "@obsidion/front-core"
import type { WalletSendOptions } from "../../support/submitBoundary"

const h = vi.hoisted(() => ({
  announce: vi.fn(async (_input: object) => ({ status: "sent", messageId: "m1" })),
  requestAdd: undefined as unknown as MockInstance,
  activity: undefined as unknown as Activity,
  sendTokenSponsored: vi.fn(async (..._args: unknown[]) => ({ txHash: "0xhash", amount: 5n })),
  addEntry: vi.fn(async (_entry: object) => {}),
  addOrMergeContact: vi.fn(async (entry: object) => entry),
  approveAutoAdded: vi.fn(async (_address: string) => undefined),
  removeEntry: vi.fn(async (_identity: object) => {}),
  /** Set to a hash to stand for a send the node has already been handed. */
  survivingHash: undefined as string | undefined,
  TxInFlightError: class TxInFlightError extends Error {
    constructor(readonly txHash: string, cause: unknown) {
      super(cause instanceof Error ? cause.message : String(cause))
    }
  },
}))

// The operation record has its own tests; here it only has to run the flow.
vi.mock("../../../src/features/operations/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/operations/operations")>()),
  isFlowCancelled: (await import("@obsidion/passkey-web")).isPasskeyCancelled,
  runOperation: (input: { operationId: string }, run: (op: unknown) => Promise<unknown>) =>
    run({ operationId: input.operationId, leaveToChain() {} }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  RequestBroadcaster: class {
    announce = h.announce
  },
  ContactStorage: {
    get: () => ({
      addEntry: h.addEntry,
      addOrMergeContact: h.addOrMergeContact,
      approveAutoAdded: h.approveAutoAdded,
      removeEntry: h.removeEntry,
    }),
  },
  resolveAssetConstants: () => ({ DAI: { logo: "", price: 1 } }),
  trackSubmission: () => ({
    get txHash() {
      return h.survivingHash
    },
    survived: async () => h.survivingHash ?? null,
    stop: () => {},
  }),
  TxInFlightError: h.TxInFlightError,
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  nextOperationId: () => "op",
}))
vi.mock("@obsidion/core/constants", async (original) => ({
  ...(await original<object>()),
  QueueStatus: {
    MINING: "mining",
    SUCCESS: "success",
    FAILED: "failed",
    PENDING: "pending",
    CANCELLED: "cancelled",
  },
}))
vi.mock("@obsidion/proving-progress", () => ({
  ProvingStage: { Mining: "mining" },
  provingProgress: { on: () => {}, off: () => {} },
}))
vi.mock("@aztec-labs/stdlib/aztec-address", () => ({
  AztecAddress: { fromStringUnsafe: (s: string) => s },
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../../../src/platform/xmtp/xmtpLifecycle", () => ({
  getXmtpSender: () => ({}),
  getXmtpUiState: () => ({}),
  xmtpUnavailableCode: () => "messaging.starting",
}))
vi.mock("../../../src/features/fees/fpcRefuel", () => ({ maybeRefuelFpc: () => {} }))
vi.mock("../../../src/features/onboarding/claimSponsorship", () => ({
  claimSponsorContext: async () => ({ subscribe: false }),
  noteSubscribed: () => {},
}))
vi.mock("../../../src/features/contacts/registryResolution", () => ({
  resolveTagForCommit: async (tag: string) =>
    tag === "stale"
      ? { status: "staleRollup" }
      : { status: "resolved", l2Address: "0xabc", xmtpAddress: "0xxmtp" },
  resolveTagViaRegistry: async () => ({ status: "resolved" }),
}))
const { runContactPay, RecipientNotUpgradedError } = await import(
  "../../../src/features/contacts/contactPay"
)
const { activeNamespace, closeSession, switchSession } = await import(
  "../../../src/platform/session"
)
const { walletStorage } = await import("../../../src/platform/storage/walletStorage")

beforeEach(() => {
  const opened = switchSession(activeNamespace())
  h.activity = opened.activity
  vi.spyOn(h.activity, "insertPending")
  h.requestAdd = vi.spyOn(opened.requests, "add")
})
afterEach(() => {
  vi.restoreAllMocks()
  closeSession()
})
const inserted = () => vi.mocked(h.activity.insertPending).mock.calls[0]?.[0]

const token = {
  fetchTokenInformation: async () => ({
    address: "0xtoken",
    name: "DAI",
    symbol: "DAI",
    decimals: 18,
  }),
  sendTokenSponsored: h.sendTokenSponsored,
}

describe("recipient upgrade check", () => {
  it("refuses a send to a tag still on a retired rollup before anything is written or proven", async () => {
    vi.clearAllMocks()
    await expect(
      runContactPay(
        {
          mode: "send",
          deps: {
            tokenService: token as never,
            account: { makeSpendMetadataResolver: async () => () => {} } as never,
            wallet: { networkId: "0xnet" } as never,
            contractService: {} as never,
          },
          tag: "stale",
          senderTag: "bob",
          amountDisplay: "5",
        },
        () => {},
      ),
    ).rejects.toBeInstanceOf(RecipientNotUpgradedError)
    expect(h.activity.insertPending).not.toHaveBeenCalled()
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
  })
})

describe("contact pay note", () => {
  it("carries a request note onto the announce and the stored row", async () => {
    await runContactPay(
      {
        mode: "request",
        deps: { tokenService: token as never, wallet: { networkId: "0xrollup" } as never },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        note: "dinner",
      },
      () => {},
    )
    expect(h.announce.mock.calls[0][0]).toMatchObject({ note: "dinner" })
    expect(h.requestAdd.mock.calls[0][0]).toMatchObject({ note: "dinner" })
  })

  it("persists a send note in the same write as the transaction row", async () => {
    await runContactPay(
      {
        mode: "send",
        deps: {
          tokenService: token as never,
          account: { makeSpendMetadataResolver: async () => () => {} } as never,
          wallet: { networkId: "0xnet" } as never,
          contractService: {} as never,
        },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        note: "dinner",
      },
      () => {},
    )
    // The tag rides the same write, so a send to someone unsaved still reads as them. Written
    // pending, before the proof — the chat needs a bubble to advance while it runs.
    expect(inserted()).toMatchObject({ memo: "dinner", toTag: "alice", status: "pending" })
    // The note also rides the on-chain meta, with the sender tag.
    expect(h.sendTokenSponsored.mock.calls[0][3]).toMatchObject({
      memo: "dinner",
      senderTag: "bob",
    })
  })

  it("a send fulfilling a request threads its id into the send and flips the local row", async () => {
    vi.clearAllMocks()
    const REQ = "0x" + "0c".repeat(32)
    const sendTokenSponsored = vi.fn(async (..._args: unknown[]) => ({
      txHash: "0xhash",
      amount: 5n,
    }))
    await runContactPay(
      {
        mode: "send",
        deps: {
          tokenService: { ...token, sendTokenSponsored } as never,
          account: { makeSpendMetadataResolver: async () => () => {} } as never,
          wallet: { networkId: "0xnet" } as never,
          contractService: {} as never,
        },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: REQ } as never,
      },
      () => {},
    )
    expect(sendTokenSponsored.mock.calls[0][3]).toMatchObject({ requestId: REQ })
    // The pending row carries the request id so the feed hides the request it pays.
    expect(inserted()).toMatchObject({ requestId: REQ })
  })

  it("saves an unsaved requester before the send row is written, and approves them once it lands", async () => {
    vi.clearAllMocks()
    const order: string[] = []
    h.addOrMergeContact.mockImplementationOnce(async (entry) => {
      order.push("contact")
      return entry
    })
    vi.mocked(h.activity.insertPending).mockImplementationOnce(async () => {
      order.push("row")
    })
    h.sendTokenSponsored.mockImplementationOnce(async () => {
      order.push("send")
      return { txHash: "0xhash", amount: 5n }
    })
    h.addEntry.mockImplementationOnce(async () => {
      order.push("approval")
    })
    await runContactPay(
      {
        mode: "send",
        deps: {
          tokenService: token as never,
          account: { makeSpendMetadataResolver: async () => () => {} } as never,
          wallet: { networkId: "0xnet" } as never,
          contractService: {} as never,
        },
        tag: "alice",
        senderTag: "bob",
        amountDisplay: "5",
        request: { id: "0x01" } as never,
        saveUnsavedRequester: true,
      },
      () => {},
    )
    const contact = { name: "alice", address: "0xabc", verified: true, tag: "alice" }
    expect(h.addOrMergeContact).toHaveBeenCalledWith({ ...contact, autoAdded: true })
    expect(h.addEntry).toHaveBeenCalledWith(contact)
    expect(order).toEqual(["contact", "row", "send", "approval"])
  })
})

it("makes a payee the wallet added a contact once the send lands", async () => {
  vi.clearAllMocks()
  await runContactPay(
    {
      mode: "send",
      deps: {
        tokenService: token as never,
        account: { makeSpendMetadataResolver: async () => () => {} } as never,
        wallet: { networkId: "0xnet" } as never,
        contractService: {} as never,
      },
      tag: "alice",
      senderTag: "bob",
      amountDisplay: "5",
    },
    () => {},
  )
  expect(h.approveAutoAdded).toHaveBeenCalledWith("0xabc")
  expect(h.addEntry).not.toHaveBeenCalled()
})

describe("approving an unsaved requester", () => {
  const send = {
    mode: "send" as const,
    deps: {
      tokenService: token as never,
      account: { makeSpendMetadataResolver: async () => () => {} } as never,
      wallet: { networkId: "0xnet" } as never,
      contractService: {} as never,
    },
    tag: "alice",
    senderTag: "bob",
    amountDisplay: "5",
    request: { id: "req-1" },
    saveUnsavedRequester: true,
  }

  it("does not approve them when the send is cancelled before proving", async () => {
    vi.clearAllMocks()
    const cancelled = new Error("Cancelled")
    await expect(
      runContactPay(send, (stage) => {
        if (stage === "proving") throw cancelled
      }),
    ).rejects.toBe(cancelled)
    expect(h.addOrMergeContact).toHaveBeenCalledWith(expect.objectContaining({ autoAdded: true }))
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
    expect(h.addEntry).not.toHaveBeenCalled()
  })

  it("does not approve them when the send fails", async () => {
    vi.clearAllMocks()
    const rejection = new Error("rejected")
    h.sendTokenSponsored.mockRejectedValueOnce(rejection)
    await expect(runContactPay(send, () => {})).rejects.toBe(rejection)
    expect(h.addEntry).not.toHaveBeenCalled()
  })

  it("does not approve them while the send is unconfirmed", async () => {
    vi.clearAllMocks()
    h.survivingHash = "0xsubmitted"
    try {
      h.sendTokenSponsored.mockRejectedValueOnce(new Error("socket closed"))
      await expect(runContactPay(send, () => {})).rejects.toBeInstanceOf(h.TxInFlightError)
      expect(h.addEntry).not.toHaveBeenCalled()
    } finally {
      h.survivingHash = undefined
    }
  })

  it("still sends when saving the contact fails", async () => {
    vi.clearAllMocks()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      h.addOrMergeContact.mockRejectedValueOnce(new Error("contacts unavailable"))
      h.addEntry.mockRejectedValueOnce(new Error("contacts unavailable"))
      await expect(runContactPay(send, () => {})).resolves.toEqual({ txHash: "0xhash" })
      expect(h.addEntry).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("the row a failed send added", () => {
  const send = {
    mode: "send" as const,
    deps: {
      tokenService: token as never,
      account: { makeSpendMetadataResolver: async () => () => {} } as never,
      wallet: { networkId: "0xnet" } as never,
      contractService: {} as never,
    },
    tag: "alice",
    senderTag: "bob",
    amountDisplay: "5",
    request: { id: "req-1" },
    saveUnsavedRequester: true,
  }

  it.each([
    [
      "the send fails",
      () => h.sendTokenSponsored.mockRejectedValueOnce(new Error("rejected")),
      true,
    ],
    [
      "the send may still land",
      () => {
        h.survivingHash = "0xsubmitted"
        h.sendTokenSponsored.mockRejectedValueOnce(new Error("socket closed"))
      },
      false,
    ],
    [
      "the row was there before the send",
      () => {
        h.addOrMergeContact.mockImplementationOnce(async (entry) => ({ ...entry }))
        h.sendTokenSponsored.mockRejectedValueOnce(new Error("rejected"))
      },
      false,
    ],
  ])("is removed when %s: %s", async (_case, arrange, removed) => {
    vi.clearAllMocks()
    arrange()
    try {
      await expect(runContactPay(send, () => {})).rejects.toBeDefined()
    } finally {
      h.survivingHash = undefined
    }
    if (removed) expect(h.removeEntry).toHaveBeenCalledWith({ address: "0xabc" })
    else expect(h.removeEntry).not.toHaveBeenCalled()
  })

  it("is removed when the passkey prompt is closed before proving", async () => {
    vi.clearAllMocks()
    await expect(
      runContactPay(send, (stage) => {
        if (stage === "proving") throw new Error("Cancelled")
      }),
    ).rejects.toThrow("Cancelled")
    expect(h.removeEntry).toHaveBeenCalledWith({ address: "0xabc" })
  })
})

describe("contact send cancellation and failure identity", () => {
  const send = {
    mode: "send" as const,
    deps: {
      tokenService: token as never,
      account: { makeSpendMetadataResolver: async () => () => {} } as never,
      wallet: { networkId: "0xnet" } as never,
      contractService: {} as never,
    },
    tag: "alice",
    senderTag: "bob",
    amountDisplay: "5",
  }

  it("an early Cancel exits before allocating or failing a transaction row", async () => {
    vi.clearAllMocks()
    const cancelled = new Error("cancelled at the stage boundary")
    await expect(
      runContactPay(send, (stage) => {
        if (stage === "proving") throw cancelled
      }),
    ).rejects.toBe(cancelled)
    expect(await h.activity.all()).toEqual([])
    expect(h.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("a later service rejection fails only the row keyed by its operation id", async () => {
    vi.clearAllMocks()
    const rejection = new Error("passkey rejected")
    h.sendTokenSponsored.mockRejectedValueOnce(rejection)
    await expect(runContactPay(send, () => {})).rejects.toBe(rejection)
    const operationId = inserted()!.id
    expect(inserted()).toMatchObject({ status: "pending", operationId })
    expect(h.sendTokenSponsored.mock.calls[0][3]).toMatchObject({ operationId })
    expect(await h.activity.all()).toEqual([
      expect.objectContaining({
        id: operationId,
        status: "failed",
        detailedStatus: "failed",
        failure: { code: "tx.failed", detail: rejection.message },
      }),
    ])
  })

  it("holds the send's hash on its row when the node takes it", async () => {
    vi.clearAllMocks()
    let heldAtNode: string | undefined
    h.sendTokenSponsored.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[3] as WalletSendOptions).onTxHash?.("0xhash", { expiresAtMs: 0 })
      heldAtNode = (await h.activity.all())[0]?.txHash
      return { txHash: "0xhash", amount: 5n }
    })
    await runContactPay(send, () => {})
    expect(heldAtNode).toBe("0xhash")
  })

  it("sends nothing, and fails the row, when the hash cannot be saved", async () => {
    vi.clearAllMocks()
    vi.spyOn(h.activity, "setHash").mockRejectedValueOnce(new Error("quota exceeded"))
    const node = vi.fn()
    h.sendTokenSponsored.mockImplementationOnce(async (...args: unknown[]) => {
      await (args[3] as WalletSendOptions).onTxHash?.("0xhash", { expiresAtMs: 0 })
      node()
      return { txHash: "0xhash", amount: 5n }
    })
    const err = await runContactPay(send, () => {}).catch((e: unknown) => e)
    expect(err).toMatchObject({ message: "quota exceeded" })
    expect(err).not.toBeInstanceOf(h.TxInFlightError)
    expect(node).not.toHaveBeenCalled()
    // The failure saves in the background; the rows show it once saved.
    await walletStorage.flush()
    expect(await h.activity.all()).toEqual([expect.objectContaining({ status: "failed" })])
  })

  // ULT-876: the wallet emits the submit boundary before handing the tx to the node, so a
  // rejection after it — a throttled timer, a dropped socket — is not evidence the send failed.
  // Failing the row here is what told a user to pay twice.
  it("a rejection after the tx reached the node leaves the row alone", async () => {
    vi.clearAllMocks()
    h.survivingHash = "0xsubmitted"
    try {
      const rejection = new Error("socket closed while waiting for the mine")
      h.sendTokenSponsored.mockRejectedValueOnce(rejection)
      const thrown = await runContactPay(send, () => {}).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(h.TxInFlightError)
      expect(thrown).toMatchObject({ txHash: "0xsubmitted", message: rejection.message })
      // Neither failed nor dropped: the chain settles it.
      expect(await h.activity.all()).toEqual([expect.objectContaining({ status: "pending" })])
    } finally {
      h.survivingHash = undefined
    }
  })

  it("a closed passkey prompt drops the pending row instead of failing it", async () => {
    vi.clearAllMocks()
    const closed = new DOMException(
      "The operation either timed out or was not allowed.",
      "NotAllowedError",
    )
    h.sendTokenSponsored.mockRejectedValueOnce(closed)
    await expect(runContactPay(send, () => {})).rejects.toBe(closed)
    expect(inserted()).toBeDefined()
    expect(await h.activity.all()).toEqual([])
  })
})
