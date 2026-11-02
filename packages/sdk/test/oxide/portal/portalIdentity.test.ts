/**
 * The identity reader over a fake client (call routing) and over a real viem client whose transport
 * is a scripted `fetchFn`, so every failure shape viem produces — and the ABI selection and decoding
 * on the happy path — is the real one.
 */
import { OxidePortalAbi } from "@oxide/l1-contracts"
import {
  BaseError,
  HttpRequestError,
  type Hex,
  type PublicClient,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  numberToHex,
} from "viem"
import { describe, expect, it, vi } from "vitest"

import {
  L1IdentityUnavailableError,
  PortalIdentityMismatchError,
  readPortalChainIdentity,
} from "../../../src/oxide/portal/portalIdentity.js"

const PORTAL = ("0x" + "1a".repeat(20)) as Hex
// Checksummed (mixed-case), so the reader's lower-casing is observable.
const ROLLUP = getAddress("0x" + "ab".repeat(20))
const INBOX = getAddress("0x" + "cd".repeat(20))
const ROLLUP_VERSION = 1821665230n
const CHAIN_ID = 11155111

const GETTERS = ["ROLLUP_VERSION", "ROLLUP", "INBOX"] as const
type Getter = (typeof GETTERS)[number]

const selector = (functionName: Getter) => encodeFunctionData({ abi: OxidePortalAbi, functionName })
const getterBySelector = new Map<Hex, Getter>(GETTERS.map((name) => [selector(name), name]))

const ENCODED: Record<Getter, Hex> = {
  ROLLUP_VERSION: encodeAbiParameters([{ type: "uint256" }], [ROLLUP_VERSION]),
  ROLLUP: encodeAbiParameters([{ type: "address" }], [ROLLUP]),
  INBOX: encodeAbiParameters([{ type: "address" }], [INBOX]),
}

describe("readPortalChainIdentity over a fake client", () => {
  function fakeClient(chainId = CHAIN_ID) {
    const readContract = vi.fn(
      async ({ address, functionName }: { address: Hex; functionName: Getter }) => {
        expect(address).toBe(PORTAL)
        if (functionName === "ROLLUP_VERSION") return ROLLUP_VERSION
        if (functionName === "ROLLUP") return ROLLUP
        if (functionName === "INBOX") return INBOX
        throw new Error(`unexpected ${functionName}`)
      },
    )
    const getChainId = vi.fn(async () => chainId)
    return {
      client: { readContract, getChainId } as unknown as PublicClient,
      readContract,
      getChainId,
    }
  }

  it("reads the three getters on the portal: decimal version, lower-cased addresses", async () => {
    const { client, readContract } = fakeClient()
    await expect(readPortalChainIdentity(client, PORTAL, CHAIN_ID)).resolves.toEqual({
      l1ChainId: CHAIN_ID,
      rollupVersion: "1821665230",
      rollupAddress: ROLLUP.toLowerCase(),
      inboxAddress: INBOX.toLowerCase(),
    })
    expect(readContract.mock.calls.map(([{ functionName }]) => functionName).sort()).toEqual(
      [...GETTERS].sort(),
    )
  })

  it("a wrong chain id is a mismatch, and the getters are never invoked", async () => {
    const { client, readContract } = fakeClient(1)
    const err = await readPortalChainIdentity(client, PORTAL, CHAIN_ID).catch((e) => e)
    expect(err).toBeInstanceOf(PortalIdentityMismatchError)
    expect(err).toMatchObject({ field: "l1RpcChainId", expected: CHAIN_ID, got: 1 })
    expect(readContract).not.toHaveBeenCalled()
  })
})

// ── Real viem client over a scripted fetch ───────────────────────────

type RpcRequest = { id: number; method: string; params?: unknown[] }

/** What the transport gets back for one JSON-RPC request: a per-item body, or a whole-response failure. */
type ItemAnswer = { result: Hex } | { rpcError: { code: number; message: string; data?: Hex } }
type WholeAnswer =
  | { httpStatus: number }
  | { malformedJson: true }
  | { throws: Error }
  | { hang: true }
type Answer = ItemAnswer | WholeAnswer

const isWhole = (answer: Answer): answer is WholeAnswer =>
  !("result" in answer) && !("rpcError" in answer)

interface Script {
  /** Answer for `eth_chainId`. */
  chainId: Answer
  /** Answer for one getter's `eth_call`; the other getters decode. */
  getter?: { name: Getter; answer: Answer }
}

const abortRejection = (signal: AbortSignal | null | undefined) =>
  new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  })

/** Answers each request from the script; a whole-response failure (status, JSON, throw, hang) applies to the request carrying it. */
function scriptedFetch(script: Script) {
  const answerFor = (request: RpcRequest): Answer => {
    if (request.method === "eth_chainId") return script.chainId
    if (request.method !== "eth_call") throw new Error(`unexpected ${request.method}`)
    const [{ to, data }] = request.params as [{ to: Hex; data: Hex }]
    expect(to.toLowerCase()).toBe(PORTAL.toLowerCase())
    const name = getterBySelector.get(data)
    if (!name) throw new Error(`unexpected selector ${data}`)
    if (script.getter?.name === name) return script.getter.answer
    return { result: ENCODED[name] }
  }

  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[]
    const requests = Array.isArray(parsed) ? parsed : [parsed]
    const answers = requests.map((request) => [request, answerFor(request)] as const)

    const whole = answers.map(([, answer]) => answer).find(isWhole)
    if (whole) {
      if ("throws" in whole) throw whole.throws
      if ("hang" in whole) return abortRejection(init?.signal)
      if ("malformedJson" in whole) {
        return new Response("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("upstream failure", { status: whole.httpStatus })
    }

    const body = answers.map(([request, answer]) => ({
      jsonrpc: "2.0",
      id: request.id,
      ...(isWhole(answer)
        ? {}
        : "result" in answer
        ? { result: answer.result }
        : { error: answer.rpcError }),
    }))
    return new Response(JSON.stringify(Array.isArray(parsed) ? body : body[0]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
}

let urlCounter = 0
function realClient(script: Script, { batch = false, timeout = 5_000 } = {}) {
  const fetchFn = scriptedFetch(script)
  const client = createPublicClient({
    transport: http(`http://127.0.0.1:1/rpc-${urlCounter++}`, {
      fetchFn: fetchFn as unknown as typeof fetch,
      retryCount: 0,
      timeout,
      batch,
    }),
  }) as PublicClient
  return { client, fetchFn }
}

const chainIdOk: Answer = { result: numberToHex(CHAIN_ID) }

const failures: [name: string, answer: Answer, timeout?: number][] = [
  ["a 0x result (no code)", { result: "0x" }],
  ["a revert body", { rpcError: { code: 3, message: "execution reverted", data: "0x" } }],
  ["an HTTP 200 with malformed JSON", { malformedJson: true }],
  ["an ABI-invalid 0x1234 result", { result: "0x1234" }],
  ["an HTTP 503", { httpStatus: 503 }],
  ["an HTTP 401", { httpStatus: 401 }],
  ["fetch throwing a TypeError", { throws: new TypeError("Failed to fetch") }],
  ["a fetch that never resolves", { hang: true }, 20],
]

describe.each([
  ["single requests", false],
  ["batched requests", true],
])("readPortalChainIdentity over a real client (%s)", (_label, batch) => {
  it("decodes the ABI answers: decimal version, lower-cased addresses", async () => {
    const { client } = realClient({ chainId: chainIdOk }, { batch })
    await expect(readPortalChainIdentity(client, PORTAL, CHAIN_ID)).resolves.toEqual({
      l1ChainId: CHAIN_ID,
      rollupVersion: "1821665230",
      rollupAddress: ROLLUP.toLowerCase(),
      inboxAddress: INBOX.toLowerCase(),
    })
  })

  it("0x1234 from eth_chainId is the quantity 4660, a mismatch", async () => {
    const { client, fetchFn } = realClient({ chainId: { result: "0x1234" } }, { batch })
    const err = await readPortalChainIdentity(client, PORTAL, CHAIN_ID).catch((e) => e)
    expect(err).toBeInstanceOf(PortalIdentityMismatchError)
    expect(err).toMatchObject({ field: "l1RpcChainId", expected: CHAIN_ID, got: 4660 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  describe.each(failures)("with %s", (_name, answer, timeout) => {
    it("from eth_chainId → unavailable, naming the call, the original error as cause", async () => {
      const { client } = realClient({ chainId: answer }, { batch, timeout })
      const err = await readPortalChainIdentity(client, PORTAL, CHAIN_ID).catch((e) => e)
      // A well-formed quantity is an answer, not a failure: the mismatch case above.
      if ("result" in answer && answer.result === "0x1234") {
        expect(err).toBeInstanceOf(PortalIdentityMismatchError)
        return
      }
      expect(err).toBeInstanceOf(L1IdentityUnavailableError)
      expect(err.call).toBe("eth_chainId")
      // An empty quantity fails inside viem's hex parsing (a SyntaxError); every other shape is viem's own error.
      expect(err.cause).toBeInstanceOf("result" in answer ? SyntaxError : BaseError)
    })

    it("from a getter → unavailable, naming the call, viem's error as cause", async () => {
      const { client } = realClient(
        { chainId: chainIdOk, getter: { name: "ROLLUP", answer } },
        { batch, timeout },
      )
      const err = await readPortalChainIdentity(client, PORTAL, CHAIN_ID).catch((e) => e)
      expect(err).toBeInstanceOf(L1IdentityUnavailableError)
      // A whole-response failure takes the batch the three getters share down together.
      expect(batch && isWhole(answer) ? GETTERS : ["ROLLUP"]).toContain(err.call)
      expect(err.cause).toBeInstanceOf(BaseError)
    })
  })

  it("keeps the HTTP status on the cause chain", async () => {
    const { client } = realClient(
      { chainId: chainIdOk, getter: { name: "INBOX", answer: { httpStatus: 503 } } },
      { batch },
    )
    const err = await readPortalChainIdentity(client, PORTAL, CHAIN_ID).catch((e) => e)
    let cause: unknown = err.cause
    while (cause instanceof Error && !(cause instanceof HttpRequestError)) cause = cause.cause
    expect(cause).toBeInstanceOf(HttpRequestError)
    expect((cause as HttpRequestError).status).toBe(503)
  })
})
