import { describe, expect, it, vi, beforeEach } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { RegistryTagResolution, RequestInlinePacket } from "@obsidion/front-core"
import type { PublicClient } from "viem"
import { SipaNameUndepositableError } from "@obsidion/sdk"
import {
  linkDeployment,
  RequestDecimalsMismatchError,
  RequesterNotUpgradedError,
  resolveAccountlessRequest,
} from "../../../src/features/requests/accountlessRequest"
import {
  buildErc20TransferUri,
  buildErc20TransferUriWithoutAmount,
} from "../../../src/features/requests/eip681"

const SIPA = `0x${"aa".repeat(20)}`
const CCIP_SIPA = `0x${"bb".repeat(20)}`
const L2 = `0x${"cc".repeat(32)}`
const TOKEN = `0x${"22".repeat(20)}` as const
const IMPLEMENTATION = `0x${"77".repeat(20)}`
const PORTAL = `0x${"88".repeat(20)}`
const FEE = 250_000n

const resolveSipaAddressMock = vi.fn(async (..._args: unknown[]) => CCIP_SIPA)
const readDepositFeeMock = vi.fn(async (..._args: unknown[]) => FEE)

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  resolveSipaAddress: (...args: unknown[]) => resolveSipaAddressMock(...args),
  readDepositFee: (...args: unknown[]) => readDepositFeeMock(...args),
  readDepositSIPAImplementation: async () => IMPLEMENTATION,
}))

const tuple = {
  token: TOKEN,
  l2Token: `0x${"33".repeat(32)}`,
  registry: `0x${"44".repeat(20)}`,
  sipaResolver: `0x${"66".repeat(20)}`,
  ensDomain: "sandbox.oxide",
  sipaFactory: `0x${"55".repeat(20)}`,
  forwardingTable: `0x${"99".repeat(20)}`,
  portal: PORTAL,
  rollupVersion: "4127419662",
} as OxideEnvTuple

const resolved: RegistryTagResolution = {
  status: "resolved",
  account: "0x00000000000000000000000000000000000000aa",
  l2Address: L2,
  rollupId: "1",
  sipaStealthPublicKey: { x: 1n, y: 2n },
  xmtpAddress: "0x00000000000000000000000000000000000000b0",
}

function packet(over: Partial<RequestInlinePacket> = {}): RequestInlinePacket {
  return {
    requestId: `0x${"0a".repeat(32)}`,
    requesterTag: "alice",
    requesterAddress: L2,
    amountAtomic: 1_000_000n,
    networkId: "0xrollup",
    tokenAddress: `0x${"1b".repeat(32)}`,
    tokenDecimals: 6,
    tokenSymbol: "DAI",
    ...over,
  }
}

/** An L1 where the token has `decimals` and each address holds what `chain` says. */
function l1(
  decimals = 6,
  chain: Record<string, { balance?: bigint; code?: string; tokens?: Record<string, bigint> }> = {},
  predict: (address: string, args: unknown[]) => string = () => SIPA,
): PublicClient {
  return {
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string
      functionName: string
      args?: string[]
    }) =>
      functionName === "decimals"
        ? decimals
        : functionName === "predictSIPA"
        ? predict(address, args!)
        : chain[args![0]]?.tokens?.[address] ??
          (address === TOKEN ? chain[args![0]]?.balance : 0n) ??
          0n,
    getCode: async ({ address }: { address: string }) => chain[address]?.code,
  } as unknown as PublicClient
}

function deps(resolveRequester: () => Promise<RegistryTagResolution> = async () => resolved) {
  return {
    tuple,
    // The token contract reports the decimals the packets below declare.
    publicClient: l1(),
    resolveRequester,
    chainId: 11155111,
    acceptedTokens: [TOKEN],
  }
}

describe("resolveAccountlessRequest", () => {
  beforeEach(() => {
    resolveSipaAddressMock.mockClear()
    readDepositFeeMock.mockClear()
  })
  it("uses the embedded SIPA and never CCIP-resolves", async () => {
    const result = await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), deps())
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.grossAtomic).toBe(1_000_000n + FEE)
    // Exact shape: a wallet needs the token, the chain and the amount, not just the address.
    expect(result.paymentUri).toBe(
      `ethereum:${TOKEN}@11155111/transfer?address=${SIPA}&uint256=${1_000_000n + FEE}`,
    )
    expect(result.tagWarning).toBeUndefined()
  })

  it("returns the token and the decimals its contract reports", async () => {
    const result = await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), deps())
    expect(result.token).toBe(TOKEN)
    expect(result.decimals).toBe(6)
  })

  it("refuses a link that declares other decimals than the token has", async () => {
    await expect(
      resolveAccountlessRequest(packet({ sipaAddress: SIPA, tokenDecimals: 18 }), deps()),
    ).rejects.toBeInstanceOf(RequestDecimalsMismatchError)
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
  })

  it("reads a link without decimals as 6, as the codec defines", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, tokenDecimals: undefined }),
      deps(),
    )
    expect(result.decimals).toBe(6)
  })

  it("refuses a link without decimals when the token does not have 6", async () => {
    await expect(
      resolveAccountlessRequest(packet({ sipaAddress: SIPA, tokenDecimals: undefined }), {
        ...deps(),
        publicClient: l1(18),
      }),
    ).rejects.toBeInstanceOf(RequestDecimalsMismatchError)
  })

  it("ignores decimals on an any-amount request, whose URI carries no amount", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, amountAtomic: 0n, tokenDecimals: undefined }),
      { ...deps(), publicClient: l1(18) },
    )
    expect(result.decimals).toBe(18)
  })

  it.each([
    ["holds funds", { balance: 1n }],
    ["was swept", { code: "0x60" }],
  ])("asks the resolver when the embedded SIPA %s", async (_case, state) => {
    const result = await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), {
      ...deps(),
      publicClient: l1(6, { [SIPA]: state }),
    })
    expect(resolveSipaAddressMock).toHaveBeenCalledOnce()
    expect(result.sipaAddress).toBe(CCIP_SIPA)
  })

  it("asks the resolver when the embedded SIPA holds another accepted token", async () => {
    const usdc = `0x${"c0".repeat(20)}` as const
    const result = await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), {
      ...deps(),
      acceptedTokens: [TOKEN, usdc],
      publicClient: l1(6, { [SIPA]: { tokens: { [usdc]: 1n } } }),
    })
    expect(result.sipaAddress).toBe(CCIP_SIPA)
  })

  it("omits uint256 for an any-amount request", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, amountAtomic: 0n }),
      deps(),
    )
    expect(result.grossAtomic).toBe(0n)
    expect(result.paymentUri).toBe(`ethereum:${TOKEN}@11155111/transfer?address=${SIPA}`)
  })

  it("keeps the QR when the @tag no longer matches — the SIPA is the payee", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA }),
      deps(async () => ({ status: "notFound" })),
    )
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.tagWarning).toMatch(/no longer registered/)
  })

  it("warns when the @tag resolves to a different account than the link pinned", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA }),
      deps(async () => ({ ...resolved, l2Address: `0x${"dd".repeat(32)}` })),
    )
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.tagWarning).toMatch(/no longer matches/)
  })

  it("times out a CCIP resolve that never settles", async () => {
    resolveSipaAddressMock.mockImplementationOnce(() => new Promise(() => {}))
    await expect(resolveAccountlessRequest(packet(), { ...deps(), timeoutMs: 10 })).rejects.toThrow(
      /timed out/,
    )
  })

  it("CCIP-resolves a legacy packet without a SIPA", async () => {
    const result = await resolveAccountlessRequest(packet(), deps())
    expect(resolveSipaAddressMock).toHaveBeenCalledOnce()
    expect(result.sipaAddress).toBe(CCIP_SIPA)
    expect(result.tagWarning).toBeUndefined()
  })

  it("fails closed on a legacy packet whose @tag is gone", async () => {
    await expect(
      resolveAccountlessRequest(
        packet(),
        deps(async () => ({ status: "notFound" })),
      ),
    ).rejects.toThrow(/no longer registered/)
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
  })

  it("names a requester who hasn't upgraded, and never asks the resolver", async () => {
    await expect(
      resolveAccountlessRequest(
        packet(),
        deps(async () => ({ status: "staleRollup" })),
      ),
    ).rejects.toBeInstanceOf(RequesterNotUpgradedError)
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
  })

  it("names a requester the resolver refuses as not upgraded", async () => {
    resolveSipaAddressMock.mockRejectedValueOnce(
      new SipaNameUndepositableError("alice.sandbox.oxide"),
    )
    await expect(resolveAccountlessRequest(packet(), deps())).rejects.toBeInstanceOf(
      RequesterNotUpgradedError,
    )
  })

  it("keeps the QR for a requester who hasn't upgraded, and says so", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA }),
      deps(async () => ({ status: "staleRollup" })),
    )
    expect(result.sipaAddress).toBe(SIPA)
    expect(result.tagWarning).toBe("@alice hasn't upgraded yet")
  })
})

const PREIMAGE = { intentHash: `0x${"4e".repeat(32)}`, recovery: `0x${"5f".repeat(32)}` }

describe("linkDeployment", () => {
  it.each([
    [
      "the preimage predicts the address",
      { sipaAddress: SIPA, sipaPreimage: PREIMAGE },
      SIPA.toUpperCase().replace("0X", "0x"),
      "active",
    ],
    [
      "the preimage predicts another address",
      { sipaAddress: SIPA, sipaPreimage: PREIMAGE },
      CCIP_SIPA,
      "expired",
    ],
    ["the link has no preimage", { sipaAddress: SIPA }, SIPA, "unproven"],
    [
      "a code's deployment tag is the active one",
      { sipaAddress: SIPA, sipaDeployment: "0x0a0b0c0d" },
      SIPA,
      "active",
    ],
    [
      "a code's deployment tag is another",
      { sipaAddress: SIPA, sipaDeployment: "0x01020304" },
      SIPA,
      "expired",
    ],
  ] as const)("%s", async (_, link, predicted, verdict) => {
    expect(await linkDeployment(link, async () => predicted as never, "0x0a0b0c0d")).toBe(verdict)
  })
})

describe("resolveAccountlessRequest deployment", () => {
  beforeEach(() => resolveSipaAddressMock.mockClear())

  it("re-predicts the link's address from the active factory, implementation, rollup and table", async () => {
    const calls: unknown[][] = []
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, sipaPreimage: PREIMAGE }),
      {
        ...deps(),
        publicClient: l1(6, {}, (factory, args) => {
          calls.push([factory, ...args])
          return SIPA
        }),
      },
    )
    expect(calls).toEqual([
      [
        tuple.sipaFactory,
        IMPLEMENTATION,
        PREIMAGE.intentHash,
        PREIMAGE.recovery,
        4127419662n,
        true,
        tuple.forwardingTable,
      ],
    ])
    expect(result.deployment).toBe("active")
  })

  it("keeps an expired link's address, even once paid, and never resolves another", async () => {
    const result = await resolveAccountlessRequest(
      packet({ sipaAddress: SIPA, sipaPreimage: PREIMAGE }),
      {
        ...deps(),
        publicClient: l1(6, { [SIPA]: { balance: 1n } }, () => CCIP_SIPA),
      },
    )
    expect(result).toMatchObject({ deployment: "expired", sipaAddress: SIPA })
    expect(resolveSipaAddressMock).not.toHaveBeenCalled()
  })

  it("leaves a link without a preimage unproven, and an address resolved now active", async () => {
    expect(
      (await resolveAccountlessRequest(packet({ sipaAddress: SIPA }), deps())).deployment,
    ).toBe("unproven")
    expect((await resolveAccountlessRequest(packet(), deps())).deployment).toBe("active")
  })
})

describe("eip681", () => {
  it("formats transfer URIs", () => {
    expect(
      buildErc20TransferUri({
        token: TOKEN as never,
        chainId: 1,
        to: SIPA as never,
        rawAmount: 42n,
      }),
    ).toBe(`ethereum:${TOKEN}@1/transfer?address=${SIPA}&uint256=42`)
    expect(
      buildErc20TransferUriWithoutAmount({ token: TOKEN as never, chainId: 1, to: SIPA as never }),
    ).toBe(`ethereum:${TOKEN}@1/transfer?address=${SIPA}`)
  })
})
