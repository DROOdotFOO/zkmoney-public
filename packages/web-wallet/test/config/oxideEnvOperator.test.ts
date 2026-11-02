/**
 * Selecting the signup's resolver operator scans the deployment's whole operator log history, so
 * `oxideEnvFor` reuses one selection for a few minutes: the tag step starts it and the claim after
 * the passkey finds it. A failed scan is never kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const TUPLE = {
  registry: "0x0000000000000000000000000000000000000001",
  accountFactory: "0x0000000000000000000000000000000000000002",
  ensDomain: "zk.money",
  token: "0x0000000000000000000000000000000000000004",
  rollupVersion: "3",
  registrationController: "0x0000000000000000000000000000000000000005",
}
const OPERATOR = "0x00000000000000000000000000000000000000e6"
const h = vi.hoisted(() => ({ fetchOperator: vi.fn() }))
vi.mock("@obsidion/core/oxide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/core/oxide")>()),
  loadOxideDeployment: async () => ({ pinned: { tuple: TUPLE } }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  fetchSignupResolverRecord: h.fetchOperator,
}))

import { Network } from "@obsidion/core/constants"
import { oxideEnvFor, RESOLVER_OPERATOR_REUSE_MS } from "../../src/config/oxideTuple"
import type { WebWalletConfig } from "../../src/config/env"

const CONFIG = {
  oxideProfile: { manifestUrl: "https://oxide.example/manifest.json", portal: "0xabc" },
  network: Network.TESTNET,
  l1ChainId: 11155111,
  l1RpcUrl: "http://127.0.0.1:8545",
  claimFpcAddress: `0x${"0f".repeat(32)}`,
} as unknown as WebWalletConfig

describe("oxideEnvFor's resolver operator", () => {
  // Each test starts past the previous one's reuse window, so none inherits a selection.
  let clock = Date.now()
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    clock += 10 * RESOLVER_OPERATOR_REUSE_MS
    vi.setSystemTime(clock)
    h.fetchOperator.mockReset().mockResolvedValue({ owner: OPERATOR })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("scans once for a claim that follows the tag step's read", async () => {
    const early = await oxideEnvFor(CONFIG)
    const claim = await oxideEnvFor(CONFIG)
    expect(early.env.resolverOperator).toBe(OPERATOR)
    expect(claim.env.resolverOperator).toBe(OPERATOR)
    expect(h.fetchOperator).toHaveBeenCalledTimes(1)
  })

  it("scans again once the selection is older than the reuse window", async () => {
    await oxideEnvFor(CONFIG)
    vi.setSystemTime(Date.now() + RESOLVER_OPERATOR_REUSE_MS + 1)
    await oxideEnvFor(CONFIG)
    expect(h.fetchOperator).toHaveBeenCalledTimes(2)
  })

  it("keeps no failed scan", async () => {
    h.fetchOperator.mockRejectedValueOnce(new Error("rpc down"))
    await expect(oxideEnvFor(CONFIG)).rejects.toThrow("rpc down")
    await expect(oxideEnvFor(CONFIG)).resolves.toMatchObject({
      env: { resolverOperator: OPERATOR },
    })
    expect(h.fetchOperator).toHaveBeenCalledTimes(2)
  })
})
