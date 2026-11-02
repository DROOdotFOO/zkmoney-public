/**
 * The boot's identity check: L1 is the identity source and the node must agree. The default node
 * alone may boot on its own answers when L1 yields no identity. Every refusal renders on the boot
 * error screen with the exits the endpoint's provenance allows.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { AztecSQLiteOPFSStore } from "@aztec-labs/kv-store/sqlite-opfs"
import type { ChainIdentity } from "@obsidion/core/types"
import type { PortalIdentityCall } from "@obsidion/sdk"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { BootError, BootErrorKind } from "../../../src/ui/PxeBoot"
import type { EndpointProvenance } from "../../../src/config/env"
import { resetModulesAsActiveTab } from "../../support/activeTab"

vi.setConfig({ testTimeout: 30_000 })

const h = vi.hoisted(() => ({
  createWallet: vi.fn(),
  readPortal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getNodeInfo: vi.fn<() => Promise<unknown>>(),
  fireEvent: vi.fn(),
  showReportableError: vi.fn(),
  reload: vi.fn(),
  retry: vi.fn(),
  config: {} as Record<string, unknown>,
}))

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useContractServiceContext: () => ({ contractService: undefined }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readPortalChainIdentity: (...args: unknown[]) => h.readPortal(...args),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => h.config,
}))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => "l1-client" }))
vi.mock("../../../src/platform/bbWasmPath", () => ({
  barretenbergWasm: () => ({ wasmPath: "/assets/bb-threads.wasm.gz" }),
}))
vi.mock("../../../src/dev/demoFlag", () => ({ isDemoMode: () => false }))
vi.mock("../../../src/errors/errorModal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/errors/errorModal")>()),
  showReportableError: h.showReportableError,
}))
vi.mock("../../../src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/analytics")>()),
  fireEvent: h.fireEvent,
}))

const NODE_URL = "https://node.default.test"
const RPC_HOST = "rpc.default.test"
const RPC_KEY = "provider-key"
/** The default RPC carries its provider key in the path, as the hosted profile's does. */
const RPC_URL = `https://${RPC_HOST}/v2/${RPC_KEY}`
const PORTAL = "0x" + "c".repeat(40)
const L1 = {
  l1ChainId: 11155111,
  rollupVersion: "1821665230",
  rollupAddress: "0x" + "a".repeat(40),
  inboxAddress: "0x" + "b".repeat(40),
}
const DEFAULT: EndpointProvenance = { source: "default", isDefault: true }
const SETTINGS: EndpointProvenance = { source: "settings", isDefault: false }
const DIGEST = "0123456789abcdef0123456789abcdef"

type NodeAnswer = {
  l1ChainId: number
  rollupVersion: number
  rollupAddress: string
  inboxAddress: string
}

/** A `getNodeInfo()` answer, addresses as the EthAddress-like objects the node client returns. */
const nodeAnswer = (over: Partial<NodeAnswer> = {}) => {
  const a = {
    l1ChainId: L1.l1ChainId,
    rollupVersion: Number(L1.rollupVersion),
    // Case differs from L1's lower-cased form on purpose: the compare is case-insensitive.
    rollupAddress: L1.rollupAddress.toUpperCase().replace("0X", "0x"),
    inboxAddress: L1.inboxAddress,
    ...over,
  }
  return {
    l1ChainId: a.l1ChainId,
    rollupVersion: a.rollupVersion,
    l1ContractAddresses: {
      rollupAddress: { toString: () => a.rollupAddress },
      inboxAddress: { toString: () => a.inboxAddress },
    },
  }
}

const baseConfig = () => ({
  nodeUrl: NODE_URL,
  l1RpcUrl: RPC_URL,
  l1ChainId: L1.l1ChainId,
  proverEnabled: false,
  profileRollupVersion: L1.rollupVersion,
  nodeEndpointDigest: undefined as string | undefined,
  oxideProfile: { portal: PORTAL },
  endpoints: { node: DEFAULT, l1Rpc: DEFAULT, enclave: DEFAULT },
})

const customNode = () => {
  h.config.endpoints = { node: SETTINGS, l1Rpc: DEFAULT, enclave: DEFAULT }
  h.config.nodeEndpointDigest = DIGEST
}

const node = { getNodeInfo: () => h.getNodeInfo() } as unknown as AztecNode

let container: HTMLDivElement
let root: Root
let consoleError: ReturnType<typeof vi.spyOn>

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

const identityErrors = () => import("@obsidion/front-core")
const wrongChain = async () => {
  const { PortalIdentityMismatchError } = await identityErrors()
  return new PortalIdentityMismatchError({ field: "l1RpcChainId", expected: L1.l1ChainId, got: 1 })
}
const l1Unavailable = async (call: PortalIdentityCall, cause: unknown) => {
  const { L1IdentityUnavailableError } = await identityErrors()
  return new L1IdentityUnavailableError({ call, cause })
}

/** Runs the identity check as the gate does: the identity, or the refusal and its description. */
async function check(): Promise<{ identity?: ChainIdentity; thrown?: unknown; error?: BootError }> {
  const { describeBootError, verifiedIdentity } = await import("../../../src/ui/PxeBoot")
  try {
    return { identity: await verifiedIdentity(h.config as never, node) }
  } catch (thrown) {
    return { thrown, error: describeBootError(thrown) }
  }
}

beforeEach(() => {
  h.createWallet.mockReset().mockResolvedValue({ node: {} })
  h.readPortal.mockReset().mockResolvedValue(L1)
  h.getNodeInfo.mockReset().mockResolvedValue(nodeAnswer())
  h.fireEvent.mockClear()
  h.showReportableError.mockClear()
  h.reload.mockClear()
  h.retry.mockClear()
  h.config = baseConfig()
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

describe("verifiedIdentity", () => {
  it("all agree: the wallet boots on the L1 identity", async () => {
    const { identity } = await check()
    expect(identity).toEqual(L1)
    expect(h.readPortal).toHaveBeenCalledWith("l1-client", PORTAL, L1.l1ChainId)
    expect(h.fireEvent).not.toHaveBeenCalledWith("node_identity_unverified", expect.anything())
    expect(h.fireEvent).not.toHaveBeenCalledWith("profile_rollup_skew", expect.anything())
  })

  it("a node that disagrees on a field is refused, naming the node", async () => {
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ rollupVersion: 999 }))
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "rollupVersion" })
    expect(error?.title).toContain(NODE_URL)
    expect(error?.message).toContain("999")
  })

  it("a wrong-chain L1 RPC refuses even the default node, naming the RPC", async () => {
    h.readPortal.mockRejectedValue(await wrongChain())
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "l1RpcChainId" })
    expect(error?.title).toContain(RPC_HOST)
    expect(error?.title).not.toContain(RPC_KEY)
    expect(error?.title).not.toContain(NODE_URL)
  })

  it.each([
    ["a transport failure", () => new TypeError("Failed to fetch")],
    [
      "a revert",
      () =>
        Object.assign(new Error("execution reverted"), { name: "ContractFunctionExecutionError" }),
    ],
  ])(
    "L1 unavailable on %s: the default node boots on its own answers and says so",
    async (_label, makeCause) => {
      const cause = makeCause()
      h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", cause))
      // The node's Inbox differs from L1's fixture, so what reaches the wallet is provably theirs.
      // Its version matches the profile's, the one check left when L1 is silent.
      const theirs = { rollupVersion: 7, inboxAddress: "0x" + "d".repeat(40) }
      h.config.profileRollupVersion = "7"
      h.getNodeInfo.mockResolvedValue(nodeAnswer(theirs))
      const { identity } = await check()
      expect(identity).toEqual({
        l1ChainId: L1.l1ChainId,
        rollupVersion: "7",
        rollupAddress: L1.rollupAddress,
        inboxAddress: theirs.inboxAddress,
      })
      expect(h.fireEvent).toHaveBeenCalledWith("node_identity_unverified", { call: "ROLLUP" })
      expect(consoleError).toHaveBeenCalledWith(expect.any(String), cause)
    },
  )

  it("L1 unavailable with a default node on another chain is refused", async () => {
    h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", new TypeError("Failed to fetch")))
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ l1ChainId: 1 }))
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "l1ChainId" })
    expect(error?.message).toContain(`this network is chain ${L1.l1ChainId}`)
    expect(error?.message).not.toContain("L1 says")
    expect(h.fireEvent).not.toHaveBeenCalledWith("node_identity_unverified", expect.anything())
  })

  it("L1 unavailable with a custom node is refused", async () => {
    customNode()
    h.readPortal.mockRejectedValue(await l1Unavailable("eth_chainId", new TypeError("timeout")))
    const { error } = await check()
    expect(error?.kind).toBe("l1-unavailable")
    expect(error?.title).toContain(RPC_HOST)
    expect(error?.title).not.toContain(RPC_KEY)
    expect(error?.message).toContain("eth_chainId")
    expect(error?.message).toContain(NODE_URL)
    expect(h.fireEvent).not.toHaveBeenCalledWith("node_identity_unverified", expect.anything())
  })

  it("a node that does not answer is unreachable", async () => {
    h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
    const { error } = await check()
    expect(error?.kind).toBe("unreachable")
    expect(error?.title).toBe("zk.money cannot reach the network")
  })

  it("a node that accepts the connection but never answers is unreachable once the deadline passes", async () => {
    vi.useFakeTimers()
    try {
      const { verifiedIdentity } = await import("../../../src/ui/PxeBoot")
      h.getNodeInfo.mockReturnValue(new Promise(() => {}))
      let outcome: string | undefined
      void verifiedIdentity(h.config as never, node).then(
        () => (outcome = "resolved"),
        (e: Error) => (outcome = e.name),
      )
      await vi.advanceTimersByTimeAsync(29_000)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(outcome).toBe("NodeUnreachableError")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a node that does not answer beside a wrong-chain RPC reports the mismatch", async () => {
    h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
    h.readPortal.mockRejectedValue(await wrongChain())
    const { error } = await check()
    expect(error).toMatchObject({ kind: "mismatch", field: "l1RpcChainId" })
  })

  it("a node that does not answer beside an unavailable L1 reports the node", async () => {
    h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
    h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", new TypeError("timeout")))
    const { error } = await check()
    expect(error?.kind).toBe("unreachable")
  })

  it("a profile whose rollup version differs from L1's refuses and reports the skew", async () => {
    h.config.profileRollupVersion = "4"
    const { error } = await check()
    expect(error).toMatchObject({ kind: "profile-skew", field: "rollupVersion" })
    expect(error?.message).toContain("rollup version 4")
    expect(error?.message).toContain("operator")
    expect(h.fireEvent).toHaveBeenCalledWith("profile_rollup_skew", {
      profile_version: 4,
      l1_version: Number(L1.rollupVersion),
    })
  })

  it("L1 unavailable with a default node on another rollup version than the profile refuses", async () => {
    h.readPortal.mockRejectedValue(await l1Unavailable("ROLLUP", new TypeError("Failed to fetch")))
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ rollupVersion: 9 }))
    const { error } = await check()
    expect(error).toMatchObject({ kind: "profile-skew" })
  })
})

describe("assertCustomL1RpcSimulates", () => {
  const CUSTOM_RPC = "https://my-node.example/rpc"
  const rpcAnswers = (body: unknown) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)))
    vi.stubGlobal("fetch", fetchImpl)
    return fetchImpl
  }
  const customRpc = (network = "mainnet") => {
    h.config.network = network
    h.config.l1RpcUrl = CUSTOM_RPC
    h.config.endpoints = { node: DEFAULT, l1Rpc: SETTINGS, enclave: DEFAULT }
  }
  async function probe(): Promise<{ thrown?: unknown; error?: BootError }> {
    const { assertCustomL1RpcSimulates, describeBootError } = await import(
      "../../../src/ui/PxeBoot"
    )
    try {
      await assertCustomL1RpcSimulates(h.config as never)
      return {}
    } catch (thrown) {
      return { thrown, error: describeBootError(thrown) }
    }
  }
  const UNSUPPORTED = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not available" } }

  it("a custom RPC without eth_simulateV1 refuses the boot, naming the RPC", async () => {
    customRpc()
    rpcAnswers(UNSUPPORTED)
    const { error } = await probe()
    expect(error?.kind).toBe("l1-rpc-no-simulate")
    expect(error?.title).toContain(CUSTOM_RPC)
    expect(error?.message).toContain("eth_simulateV1")
  })

  it("a custom RPC that simulates boots", async () => {
    customRpc()
    const fetchImpl = rpcAnswers({ jsonrpc: "2.0", id: 1, result: [{ calls: [] }] })
    expect(await probe()).toEqual({})
    expect(fetchImpl).toHaveBeenCalledWith(CUSTOM_RPC, expect.anything())
  })

  it("a custom RPC that cannot be probed refuses the boot", async () => {
    customRpc()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    const { thrown } = await probe()
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("eth_simulateV1 probe failed: Failed to fetch")
  })

  it.each([
    ["the default RPC", () => (h.config.network = "mainnet")],
    ["a custom RPC on a network without swaps", () => customRpc("testnet")],
  ])("%s is not probed", async (_label, setup) => {
    setup()
    const fetchImpl = rpcAnswers(UNSUPPORTED)
    expect(await probe()).toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("reportBootFailure", () => {
  const report = async (e: unknown) => {
    const { reportBootFailure } = await import("../../../src/ui/PxeBoot")
    reportBootFailure(e, { bootStartedAt: undefined, attempts: 0 })
  }
  const bootFailedCode = () =>
    h.fireEvent.mock.calls.find(([event]) => event === "pxe_boot_failed")?.[1]?.code

  it("a refusal reports its kind and leaves the explaining to the screen", async () => {
    h.getNodeInfo.mockResolvedValue(nodeAnswer({ l1ChainId: 1 }))
    await report((await check()).thrown)
    expect(bootFailedCode()).toBe("mismatch")
    expect(h.showReportableError).not.toHaveBeenCalled()
  })

  it("an unreachable node's transport error reaches the console", async () => {
    const cause = new TypeError("Failed to fetch")
    h.getNodeInfo.mockRejectedValue(cause)
    await report((await check()).thrown)
    expect(bootFailedCode()).toBe("unreachable")
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), cause)
  })

  it("any other failure is reportable", async () => {
    const boom = new Error("boom")
    await report(boom)
    expect(bootFailedCode()).toBe("other")
    expect(h.showReportableError).toHaveBeenCalledWith(boom, "pxe:boot", {
      title: "zk.money failed to start",
      retry: { label: "Reload page", run: expect.any(Function) },
    })
  })
})

describe("BootErrorScreen", () => {
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const retryButton = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")

  beforeAll(() => {
    Object.defineProperty(window, "location", { value: { reload: h.reload }, writable: true })
  })

  // The liquid-glass secondary button measures itself.
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  /** The screen a boot that failed before the wallet opened shows for `thrown`. */
  async function showFailure(thrown: unknown) {
    const { describeBootError } = await import("../../../src/ui/PxeBoot")
    const { BootErrorScreen } = await import("../../../src/ui/BootErrorScreen")
    const error = describeBootError(thrown)
    await act(async () => {
      root.render(<BootErrorScreen error={error} onRetry={h.retry} walletOpen={false} />)
    })
    return { panel: byTestId("boot-error")!, error }
  }

  type Failure = "node-mismatch" | "wrong-chain" | "l1-unavailable" | "unreachable" | "other"
  const KIND: Record<Failure, BootErrorKind> = {
    "node-mismatch": "mismatch",
    "wrong-chain": "mismatch",
    "l1-unavailable": "l1-unavailable",
    "unreachable": "unreachable",
    "other": "other",
  }
  const NAMES: Record<Failure, string> = {
    "node-mismatch": NODE_URL,
    "wrong-chain": RPC_HOST,
    "l1-unavailable": RPC_HOST,
    "unreachable": "zk.money cannot reach the network",
    "other": "zk.money failed to start",
  }

  async function failWith(failure: Failure): Promise<unknown> {
    switch (failure) {
      case "node-mismatch":
        h.getNodeInfo.mockResolvedValue(nodeAnswer({ l1ChainId: 1 }))
        break
      case "wrong-chain":
        h.readPortal.mockRejectedValue(await wrongChain())
        break
      case "l1-unavailable":
        h.readPortal.mockRejectedValue(await l1Unavailable("INBOX", new TypeError("timeout")))
        break
      case "unreachable":
        h.getNodeInfo.mockRejectedValue(new TypeError("Failed to fetch"))
        break
      case "other":
        return new Error("boom")
    }
    return (await check()).thrown
  }

  // "desktop" is a Settings-saved node under the desktop launcher.
  type Source = "default" | "settings" | "desktop"
  function nodeFrom(source: Source) {
    if (source === "default") return
    h.config.endpoints = { node: SETTINGS, l1Rpc: DEFAULT, enclave: DEFAULT }
    h.config.nodeEndpointDigest = DIGEST
    if (source === "desktop")
      vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", { l1SubmitPath: "/desktop/l1-submit" })
  }

  const failures: Failure[] = ["node-mismatch", "wrong-chain", "unreachable", "other"]
  const matrix: [Source, Failure][] = [
    ...(["default", "settings", "desktop"] as Source[]).flatMap((s) =>
      failures.map((f) => [s, f] as [Source, Failure]),
    ),
    // L1 unavailable refuses only a custom node.
    ["settings", "l1-unavailable"],
    ["desktop", "l1-unavailable"],
  ]

  it.each(matrix)(
    "a %s node failing with %s renders the error and its exits",
    async (source, failure) => {
      nodeFrom(source)
      const { panel, error } = await showFailure(await failWith(failure))
      expect(panel.dataset.kind).toBe(KIND[failure])
      expect(panel.textContent).toContain(NAMES[failure])
      expect(panel.textContent).toContain(error.title)
      expect(panel.textContent).toContain(error.message)
      expect(retryButton()).toBeDefined()
      expect(byTestId("boot-use-default-endpoints") !== null).toBe(source !== "default")
      // The editor opens whatever is saved, on every platform.
      expect(byTestId("boot-change-endpoints")).not.toBeNull()
      expect(byTestId("boot-contact-operator")).not.toBeNull()
    },
  )

  it("Retry is the caller's", async () => {
    await showFailure(await failWith("unreachable"))
    await act(async () => retryButton()!.click())
    expect(h.retry).toHaveBeenCalledTimes(1)
  })

  it("a custom RPC that cannot price swaps offers the defaults and the editor", async () => {
    h.config.endpoints = { node: DEFAULT, l1Rpc: SETTINGS, enclave: DEFAULT }
    const { L1RpcSimulationUnsupportedError } = await import("@obsidion/core/oxide")
    const { panel } = await showFailure(
      new L1RpcSimulationUnsupportedError("my-node.example", "not available"),
    )
    expect(panel.dataset.kind).toBe("l1-rpc-no-simulate")
    expect(byTestId("boot-use-default-endpoints")).not.toBeNull()
    expect(byTestId("boot-change-endpoints")).not.toBeNull()
  })

  it("under the desktop bridge a dead default node opens the endpoint editor from the error", async () => {
    vi.stubGlobal("__ZKMONEY_DESKTOP_BRIDGE__", { l1SubmitPath: "/desktop/l1-submit" })
    await showFailure(await failWith("unreachable"))
    expect(container.querySelector('a[href="/desktop-settings"]')).toBeNull()
    await act(async () => byTestId("boot-change-endpoints")!.click())
    expect(container.querySelector('dialog[aria-label="Endpoints"]')).not.toBeNull()
  })

  it("a dead default node with nothing saved opens the endpoint editor, without the wallet", async () => {
    await showFailure(await failWith("unreachable"))
    expect(byTestId("boot-use-default-endpoints")).toBeNull()
    expect(container.querySelector('dialog[aria-label="Endpoints"]')).toBeNull()
    // The wallet database is closed: the editor opens without asking it about transactions.
    const { closeWalletStore } = await import("../../../src/platform/storage/walletStorage")
    await closeWalletStore()
    await act(async () => byTestId("boot-change-endpoints")!.click())
    expect(container.querySelector('dialog[aria-label="Endpoints"]')).not.toBeNull()
    expect(h.reload).not.toHaveBeenCalled()
  })

  it("a Settings-set L1 RPC beside the default node offers the default endpoints on a wrong chain", async () => {
    h.config.endpoints = { node: DEFAULT, l1Rpc: SETTINGS, enclave: DEFAULT }
    await showFailure(await failWith("wrong-chain"))
    expect(byTestId("boot-use-default-endpoints")).not.toBeNull()
  })

  it("a profile mismatch under a Settings-set RPC points back to the defaults", async () => {
    h.config.endpoints = { node: DEFAULT, l1Rpc: SETTINGS, enclave: DEFAULT }
    h.config.profileRollupVersion = "4"
    const { panel } = await showFailure((await check()).thrown)
    expect(panel.dataset.kind).toBe("profile-skew")
    expect(panel.textContent).toContain("custom node or Ethereum RPC")
    expect(panel.textContent).not.toContain("operator needs")
    expect(byTestId("boot-use-default-endpoints")).not.toBeNull()
  })

  it("a profile mismatch with only a custom enclave still points at the operator", async () => {
    h.config.endpoints = { node: DEFAULT, l1Rpc: DEFAULT, enclave: SETTINGS }
    h.config.profileRollupVersion = "4"
    const { panel } = await showFailure((await check()).thrown)
    expect(panel.textContent).toContain("operator needs")
    expect(panel.textContent).not.toContain("custom node or Ethereum RPC")
    expect(byTestId("boot-use-default-endpoints")).toBeNull()
    expect(byTestId("boot-change-endpoints")).not.toBeNull()
  })

  it("Use default endpoints clears the saved overrides, then reloads", async () => {
    localStorage.setItem(
      "webwallet.endpoints",
      JSON.stringify({ node: "https://n.example", l1Rpc: "https://l1.example" }),
    )
    nodeFrom("settings")
    await showFailure(await failWith("node-mismatch"))
    await act(async () => byTestId("boot-use-default-endpoints")!.click())
    await flush()
    expect(localStorage.getItem("webwallet.endpoints")).toBeNull()
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(byTestId("boot-clear-error")).toBeNull()
  })

  it("a clear the storage refuses shows an inline error and does not reload", async () => {
    nodeFrom("settings")
    await showFailure(await failWith("node-mismatch"))
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied")
    })
    try {
      await act(async () => byTestId("boot-use-default-endpoints")!.click())
      await flush()
    } finally {
      removeItem.mockRestore()
    }
    expect(byTestId("boot-clear-error")?.textContent).toContain("could not be cleared")
    expect(h.reload).not.toHaveBeenCalled()
    expect(byTestId("boot-error")).not.toBeNull()
  })
})

describe("BootHold", () => {
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  // The splash's fade timer must not outlive the jsdom environment.
  afterEach(async () => {
    await vi.waitFor(() => expect(document.body.dataset.booting).toBeUndefined())
  })

  /** Each mount is a new page: the boot runs once per page. */
  async function mountBoot(bootNode: AztecNode): Promise<HTMLElement> {
    await resetModulesAsActiveTab()
    container.id = "root"
    const { PxeBootProvider } = await import("../../../src/ui/PxeBoot")
    const { BootHold } = await import("../../../src/App")
    const { startPageWallet } = await import("../../../src/platform/wallet")
    const pxeBoot = {
      kind: "pxe" as const,
      store: {} as AztecSQLiteOPFSStore,
      identity: L1,
      bootStartedAt: 0,
      attempts: 1,
    }
    startPageWallet(bootNode, pxeBoot, h.createWallet)
    await act(async () => {
      root.render(
        <PxeBootProvider pxeBoot={pxeBoot}>
          <BootHold />
        </PxeBootProvider>,
      )
    })
    for (let i = 0; i < 40 && !byTestId("boot-error"); i++) await flush()
    return byTestId("boot-error")!
  }

  async function bootWithNodeFetch(fetch: typeof globalThis.fetch): Promise<HTMLElement> {
    vi.stubGlobal("fetch", vi.fn(fetch))
    const { createNode } = await import("@obsidion/sdk")
    const realNode = createNode(NODE_URL, "node-key")
    h.createWallet.mockImplementation(() => realNode.getBlockNumber())
    return mountBoot(realNode)
  }

  const bootFailedCode = () =>
    h.fireEvent.mock.calls.find(([event]) => event === "pxe_boot_failed")?.[1]?.code

  it("a wallet build that fails shows the error screen, and its editor, in the wallet", async () => {
    h.createWallet.mockRejectedValue(new Error("boom"))
    const panel = await mountBoot(node)
    expect(panel.dataset.kind).toBe("other")
    expect(panel.textContent).toContain("zk.money failed to start")
    expect(panel.textContent).toContain("boom")
    expect(h.createWallet).toHaveBeenCalledWith(node, expect.objectContaining({ identity: L1 }), {
      wasmPath: "/assets/bb-threads.wasm.gz",
    })
    await act(async () => byTestId("boot-change-endpoints")!.click())
    expect(container.querySelector('dialog[aria-label="Endpoints"]')).not.toBeNull()
  })

  it.each(["alone", "in an AggregateError"])(
    "a damaged database %s offers only the reset page, with no report",
    async (shape) => {
      const replace = vi.fn()
      Object.defineProperty(window, "location", { value: { replace }, writable: true })
      const { SqliteCorruptionError } = await import("@aztec-labs/kv-store/sqlite-opfs")
      const corrupt = new SqliteCorruptionError(
        "SQLITE_CORRUPT: sqlite3 result code 11: database disk image is malformed",
      )
      h.createWallet.mockRejectedValue(
        shape === "alone" ? corrupt : new AggregateError([corrupt, new Error("boom")]),
      )
      expect((await mountBoot(node)).dataset.kind).toBe("corrupt")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
        "Retry",
      )
      expect(byTestId("boot-change-endpoints")).toBeNull()
      await act(async () => byTestId("boot-clear-data")!.click())
      await flush()
      expect(replace).toHaveBeenCalledWith("/reset")
    },
  )

  it.each<[string, typeof globalThis.fetch]>([
    ["a rejected fetch", () => Promise.reject(new TypeError("qwerty"))],
    ["an HTTP error", async () => new Response("", { status: 503, statusText: "qwerty" })],
    ["a body that is not JSON", async () => new Response("<html>qwerty</html>")],
  ])("%s while the wallet builds is an unreachable node, with no report", async (_, fetch) => {
    const panel = await bootWithNodeFetch(fetch)
    expect(panel.dataset.kind).toBe("unreachable")
    expect(panel.textContent).toContain("zk.money cannot reach the network")
    expect(panel.textContent).toContain("Check your internet connection, then retry.")
    expect(panel.textContent).not.toContain(NODE_URL)
    expect(bootFailedCode()).toBe("unreachable")
    expect(h.showReportableError).not.toHaveBeenCalled()
  })

  it("an error the node answers while the wallet builds is reportable", async () => {
    const panel = await bootWithNodeFetch(async (_, init) => {
      const calls = JSON.parse(String(init?.body)) as { id: number }[]
      const body = calls.map(({ id }) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "boom" },
      }))
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    })
    expect(panel.dataset.kind).toBe("other")
    expect(bootFailedCode()).toBe("other")
    expect(h.showReportableError).toHaveBeenCalled()
  })
})
