/**
 * SIPA claim primitives — unit tests over stub clients. The sweep calldata builder is decoded back
 * with viem and compared against the vendored encoders directly.
 */

import { describe, expect, it, vi } from "vitest"
import {
  decodeFunctionData,
  multicall3Abi,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { GrumpkinScalar } from "@aztec-labs/foundation/curves/grumpkin"
import {
  SipaIntent,
  encodeDeploySIPA,
  encodeRegistrationProofs,
  encodeSweep,
  type SipaDeployArgs,
  type SweepArgs,
} from "@oxide/l1-contracts"
import {
  buildRegistrationSweepCall,
  buildSipaRecoverCall,
  buildSipaSweepCall,
  EMPTY_SIGNED_TERMS,
  encodeRecoverCall,
  fetchSipaEvents,
  readSipaDepositsConsumed,
  MULTICALL3_ADDRESS,
  readDepositFee,
  readFundingTransfers,
  readSipaBalancesMany,
  readSipaDeployedMany,
  readSipaHoldingsAtHead,
  readSipaFundingStatus,
} from "../../../src/services/sipa/sipaClaim.js"
import { OxideTokenContract } from "@obsidion/contracts"

const SIPA = "0x1234567890abcdef1234567890abcdef12345678" as Address
const TX_HASH = `0x${"ab".repeat(32)}` as Hex
const TX_AMOUNT_CAP = 5166n * 10n ** 18n

describe("readSipaDepositsConsumed", () => {
  const scope = {
    l2Token: AztecAddress.fromBigIntUnsafe(0x1234n),
    masterNullifierHidingKey: GrumpkinScalar.random(),
  }

  it("looks every nullifier up in batches of the node's limit, all at once, in order", async () => {
    const hashes = Array.from({ length: 250 }, (_, i) => new Fr(BigInt(i + 1)).toString() as Hex)
    let inFlight = 0
    let peak = 0
    const findLeavesIndexes = vi.fn(async (_block: string, _tree: unknown, leaves: unknown[]) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return leaves.map((_, i) => (i % 3 === 0 ? { data: 1n } : undefined))
    })

    const consumed = await readSipaDepositsConsumed({ findLeavesIndexes } as never, scope, hashes)

    expect(findLeavesIndexes.mock.calls.map((c) => c[2].length)).toEqual([100, 100, 50])
    expect(peak).toBe(3)
    expect(consumed.filter(Boolean)).toHaveLength(34 + 34 + 17)
    expect(consumed.slice(0, 4)).toEqual([true, false, false, true])
  })
})

describe("readSipaBalancesMany", () => {
  const TOKEN = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address

  it("reads each token balance and the ETH balance in one Multicall3 call, dropping failures", async () => {
    const multicall = vi.fn<(request: object) => Promise<unknown[]>>(async () => [
      { status: "success", result: 7n },
      { status: "failure", error: new Error("reverted") },
    ])
    const client = { multicall } as unknown as PublicClient

    const balances = await readSipaBalancesMany(client, [SIPA], [TOKEN])

    expect(multicall).toHaveBeenCalledOnce()
    expect(multicall.mock.calls[0]![0]).toMatchObject({
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      contracts: [
        { address: TOKEN, functionName: "balanceOf", args: [SIPA] },
        { address: MULTICALL3_ADDRESS, functionName: "getEthBalance", args: [SIPA] },
      ],
    })
    expect(balances.get(SIPA.toLowerCase())).toEqual(new Map([[TOKEN.toLowerCase(), 7n]]))
  })
})

describe("readSipaDeployedMany", () => {
  const OTHER = "0x00000000000000000000000000000000000000b2" as Address
  const THIRD = "0x00000000000000000000000000000000000000b3" as Address

  it("counts every address that answers or reverts as deployed, in one Multicall3 call", async () => {
    const readContract = vi.fn<(request: object) => Promise<unknown[]>>(async () => [
      { success: true, returnData: `0x${"11".repeat(32)}` },
      { success: true, returnData: "0x" },
      { success: false, returnData: "0x" },
    ])
    const client = { readContract } as unknown as PublicClient

    const deployed = await readSipaDeployedMany(client, [SIPA, OTHER, THIRD])

    expect(readContract).toHaveBeenCalledOnce()
    expect(readContract.mock.calls[0]![0]).toMatchObject({
      address: MULTICALL3_ADDRESS,
      functionName: "aggregate3",
    })
    expect(deployed).toEqual(new Set([SIPA.toLowerCase(), THIRD.toLowerCase()]))
  })
})

describe("readSipaHoldingsAtHead", () => {
  const DAI = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
  const SUSDS = "0x5a1e0c2f3b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f" as Address
  const SIPA_2 = "0x9999999999999999999999999999999999999999" as Address

  it("reads the block timestamp and each SIPA's own tokens plus ETH in one unchunked call", async () => {
    const multicall = vi.fn<(request: object) => Promise<unknown[]>>(async () => [
      { status: "success", result: 1_700_000_000n },
      { status: "success", result: 7n },
      { status: "success", result: 0n },
      { status: "success", result: 9n },
      { status: "failure", error: new Error("reverted") },
    ])
    const client = { multicall } as unknown as PublicClient

    const { timestamp, balances } = await readSipaHoldingsAtHead(client, [
      { sipa: SIPA, tokens: [DAI] },
      { sipa: SIPA_2, tokens: [SUSDS] },
    ])

    expect(multicall).toHaveBeenCalledOnce()
    expect(multicall.mock.calls[0]![0]).toMatchObject({
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      batchSize: 0,
      contracts: [
        { address: MULTICALL3_ADDRESS, functionName: "getCurrentBlockTimestamp" },
        { address: DAI, functionName: "balanceOf", args: [SIPA] },
        { address: MULTICALL3_ADDRESS, functionName: "getEthBalance", args: [SIPA] },
        { address: SUSDS, functionName: "balanceOf", args: [SIPA_2] },
        { address: MULTICALL3_ADDRESS, functionName: "getEthBalance", args: [SIPA_2] },
      ],
    })
    expect(timestamp).toBe(1_700_000_000n)
    expect(balances.get(SIPA.toLowerCase())).toEqual(
      new Map([
        [DAI.toLowerCase(), 7n],
        ["0x0000000000000000000000000000000000000000", 0n],
      ]),
    )
    expect(balances.get(SIPA_2.toLowerCase())).toEqual(new Map([[SUSDS.toLowerCase(), 9n]]))
  })

  it("throws when the call itself failed, so a caller never reads zero balances off an outage", async () => {
    const failure = new Error("rpc down")
    const client = {
      multicall: vi.fn(async () => [
        { status: "failure", error: failure },
        { status: "failure", error: failure },
        { status: "failure", error: failure },
      ]),
    } as unknown as PublicClient

    await expect(readSipaHoldingsAtHead(client, [{ sipa: SIPA, tokens: [DAI] }])).rejects.toBe(
      failure,
    )
  })

  it("refuses more reads than one call carries instead of splitting them", async () => {
    const multicall = vi.fn()
    const client = { multicall } as unknown as PublicClient
    const holdings = Array.from({ length: 500 }, () => ({ sipa: SIPA, tokens: [DAI] }))

    await expect(readSipaHoldingsAtHead(client, holdings)).rejects.toThrow(/one Multicall3 call/)
    expect(multicall).not.toHaveBeenCalled()
  })
})

describe("readFundingTransfers", () => {
  const TOKEN = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
  const FUNDER = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address

  it("maps Transfer logs to funding transfers and filters on the token + to=sipa", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => 100n),
      getContractEvents: vi.fn(async () => [
        { args: { from: FUNDER, value: 1_000_000n }, blockNumber: 42n, transactionHash: TX_HASH },
      ]),
    } as unknown as PublicClient

    const transfers = await readFundingTransfers(client, TOKEN, SIPA)

    expect(transfers).toEqual([
      { from: FUNDER, amount: 1_000_000n, blockNumber: 42n, txHash: TX_HASH },
    ])
    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        eventName: "Transfer",
        args: { to: SIPA },
      }),
    )
  })

  it("honours explicit window bounds without reading the head (shared scan shape)", async () => {
    const client = {
      getBlockNumber: vi.fn(async () => {
        throw new Error("must not read the head")
      }),
      getContractEvents: vi.fn(async () => []),
    } as unknown as PublicClient

    await readFundingTransfers(client, TOKEN, SIPA, 1_000n, 1_500n)

    expect(client.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 1_000n, toBlock: 1_500n }),
    )
  })
})

describe("readSipaFundingStatus", () => {
  // The fee is the route row's sweep tip; the row names a portal whose cap the read also takes.
  function client(balance: bigint, fee: bigint): PublicClient {
    return {
      readContract: async (params: { functionName: string }) => {
        if (params.functionName === "balanceOf") return balance
        if (params.functionName === "rowFor") return [SIPA, SIPA, 0n, fee]
        if (params.functionName === "TX_AMOUNT_CAP") return TX_AMOUNT_CAP
        throw new Error(`unexpected read: ${params.functionName}`)
      },
    } as unknown as PublicClient
  }
  const token = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
  const params = {
    sipa: SIPA,
    token,
    route: {
      forwardingTable: "0x6f94c6c6014199ae899e086ec75b6a2245371ce3" as Address,
      token,
      intent: SipaIntent.Deposit,
    },
    txAmountCap: TX_AMOUNT_CAP,
  }

  it("classifies a balance the caller already read without reading it again", async () => {
    const status = await readSipaFundingStatus(client(0n, 100n), { ...params, balance: 101n })
    expect(status).toMatchObject({ balance: 101n, sweepable: true })
  })

  it("balance must strictly exceed the fee to be sweepable", async () => {
    expect((await readSipaFundingStatus(client(100n, 100n), params)).sweepable).toBe(false)
    expect((await readSipaFundingStatus(client(101n, 100n), params)).sweepable).toBe(true)
    expect((await readSipaFundingStatus(client(0n, 100n), params)).sweepable).toBe(false)
  })

  it("measures the cap against the amount credited on L2, not the whole balance", async () => {
    // The sweep pays the fee, so the window's top sits the fee above the cap.
    const at = await readSipaFundingStatus(client(TX_AMOUNT_CAP + 100n, 100n), params)
    const over = await readSipaFundingStatus(client(TX_AMOUNT_CAP + 101n, 100n), params)
    expect([at.sweepable, over.sweepable]).toEqual([true, false])
    // A zero floor collapses that top back onto the cap itself.
    expect((await readSipaFundingStatus(client(TX_AMOUNT_CAP, 0n), params)).sweepable).toBe(true)
    expect((await readSipaFundingStatus(client(TX_AMOUNT_CAP + 1n, 0n), params)).sweepable).toBe(
      false,
    )
  })

  it("reports the balance and the fee it read alongside the verdict", async () => {
    expect(await readSipaFundingStatus(client(141n, 100n), params)).toEqual({
      balance: 141n,
      scaledBalance: 141n,
      fee: 100n,
      sweepable: true,
    })
  })

  it("scales a 6-decimal balance into the fee's denomination", async () => {
    // 50,000 USDC against an 18-dec fee: raw units read as dust below the floor, scaled they are
    // far over the cap.
    const usdc = { ...params, balanceScale: 10n ** 12n }
    const status = await readSipaFundingStatus(client(50_000_000_000n, parseEther("0.25")), usdc)
    expect(status.balance).toBe(50_000_000_000n)
    expect(status.scaledBalance).toBe(parseEther("50000"))
    expect(status.sweepable).toBe(false)
    expect(status.scaledBalance - status.fee > TX_AMOUNT_CAP).toBe(true)
  })
})

describe("encodeRecoverCall", () => {
  it("targets the SIPA with recoverERC20(signature, target, token, nonce) calldata", async () => {
    const { decodeFunctionData: decode, parseAbi } = await import("viem")
    const SIPAAbi = parseAbi([
      "function recoverERC20(bytes signature, address target, address token, bytes32 nonce)",
    ])
    const signature = `0x${"cd".repeat(65)}` as Hex
    const call = encodeRecoverCall({
      protocol: "legacy-eoa",
      sipa: SIPA,
      signature,
      target: "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b",
      token: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b",
      nonce: `0x${"ab".repeat(32)}`,
    })
    expect(call.to).toBe(SIPA)
    const decoded = decode({ abi: SIPAAbi, data: call.data }) as {
      functionName: string
      args: readonly unknown[]
    }
    expect(decoded.functionName).toBe("recoverERC20")
    expect(decoded.args[0]).toBe(signature)
    expect(String(decoded.args[1]).toLowerCase()).toBe("0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b")
  })

  it("encodes recoverETH for the zero-address token and refuses it on a legacy SIPA", async () => {
    const { decodeFunctionData: decode, parseAbi, zeroAddress } = await import("viem")
    const abi = parseAbi([
      "function recoverETH(bytes32 sharedSecretSalt, address account, bytes signature, address target, bytes32 nonce)",
    ])
    const common = {
      sipa: SIPA,
      signature: `0x${"cd".repeat(65)}` as Hex,
      target: "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b" as const,
      token: zeroAddress,
      nonce: `0x${"ab".repeat(32)}` as Hex,
    }
    const call = encodeRecoverCall({
      ...common,
      protocol: "account",
      account: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b",
      sharedSecretSalt: `0x${"01".repeat(32)}`,
    })
    const decoded = decode({ abi, data: call.data })
    expect(call.to).toBe(SIPA)
    expect(decoded.functionName).toBe("recoverETH")
    expect(String(decoded.args[3]).toLowerCase()).toBe(common.target)
    expect(() => encodeRecoverCall({ ...common, protocol: "legacy-eoa" })).toThrow(
      /account-protocol/,
    )
  })
})

describe("buildSipaRecoverCall", () => {
  const recovery = (token: Address, nonce: Hex) => ({
    protocol: "account" as const,
    sipa: SIPA,
    signature: `0x${"cd".repeat(65)}` as Hex,
    target: "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b" as Address,
    token,
    nonce,
    account: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address,
    sharedSecretSalt: `0x${"01".repeat(32)}` as Hex,
  })
  const eth = recovery("0x0000000000000000000000000000000000000000", `0x${"01".repeat(32)}`)
  const usdc = recovery("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", `0x${"02".repeat(32)}`)

  it("sends one recovery to the SIPA directly", () => {
    expect(buildSipaRecoverCall({ deployed: true, recoveries: [usdc] })).toEqual(
      encodeRecoverCall(usdc),
    )
  })

  it("recovers several tokens after the deploy in one aggregate3", () => {
    const sipaFactory = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
    const args: SipaDeployArgs = {
      implementation: "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4",
      intentHash: `0x${"22".repeat(32)}`,
      recoveryCommitment: `0x${"44".repeat(32)}`,
      rollupVersion: 1n,
      resweepable: false,
      forwardingTable: "0x5a7b1e0000000000000000000000000000005a7b",
    }
    const call = buildSipaRecoverCall({
      deployed: false,
      deployment: { protocol: "account", sipaFactory, args },
      recoveries: [eth, usdc],
    })
    expect(call.to).toBe(MULTICALL3_ADDRESS)
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data: call.data }).args as [
      { target: Address; allowFailure: boolean; callData: Hex }[],
    ]
    expect(calls.map((c) => [c.target.toLowerCase(), c.allowFailure, c.callData])).toEqual([
      [sipaFactory, false, encodeDeploySIPA(args)],
      [SIPA, false, encodeRecoverCall(eth).data],
      [SIPA, false, encodeRecoverCall(usdc).data],
    ])
  })

  it("refuses recoveries of two protocols in one transaction", () => {
    const legacy = { ...usdc, protocol: "legacy-eoa" as const }
    expect(() => buildSipaRecoverCall({ deployed: true, recoveries: [usdc, legacy] })).toThrow(
      /one protocol/,
    )
  })
})

describe("readDepositFee", () => {
  it("adds the route row's sweep tip and beneficiary fee, read off the table, not a clone", async () => {
    const forwardingTable = "0x6f94c6c6014199ae899e086ec75b6a2245371ce3"
    const portal = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b"
    const token = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b"
    const client = {
      readContract: async (params: { functionName: string; address: string; args?: unknown[] }) => {
        if (params.functionName === "TX_AMOUNT_CAP") return TX_AMOUNT_CAP
        expect(params.functionName).toBe("rowFor")
        expect(params.address).toBe(forwardingTable)
        expect(params.args).toEqual([token, SipaIntent.Registration])
        return [portal, portal, 50_000n, 250_000n]
      },
    } as unknown as PublicClient
    expect(
      await readDepositFee(client, { forwardingTable, token, intent: SipaIntent.Registration }),
    ).toBe(300_000n)
  })
})

describe("buildSipaSweepCall", () => {
  const recipientCommitment = `0x${"11".repeat(32)}` as const
  const deployArgs: SipaDeployArgs = {
    implementation: "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4",
    intentHash: `0x${"22".repeat(32)}`,
    recoveryCommitment: `0x${"44".repeat(32)}`,
    rollupVersion: 4127419662n,
    resweepable: false,
    forwardingTable: "0x5a7b1e0000000000000000000000000000005a7b",
  }
  const sweepArgs: SweepArgs = {
    token: "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b",
    relayer: "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b",
    intentData: recipientCommitment,
    proofs: "0x",
  }

  it("deploys and sweeps an undeployed SIPA atomically through Multicall3 aggregate3", () => {
    const sipaFactory = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
    const call = buildSipaSweepCall({
      deployed: false,
      sipaFactory,
      sipa: SIPA,
      deployArgs,
      sweepArgs,
    })
    expect(call.to).toBe(MULTICALL3_ADDRESS)

    const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data })
    expect(decoded.functionName).toBe("aggregate3")
    const [calls] = decoded.args as [{ target: Address; allowFailure: boolean; callData: Hex }[]]
    expect(calls.map((c) => [c.target.toLowerCase(), c.allowFailure, c.callData])).toEqual([
      [sipaFactory, false, encodeDeploySIPA(deployArgs)],
      [SIPA, false, encodeSweep(sweepArgs)],
    ])
  })
})

describe("buildRegistrationSweepCall", () => {
  const registrationData = `0x${"ab".repeat(96)}` as Hex
  const deployArgs: SipaDeployArgs = {
    implementation: "0x9a1e3c2f5d7b8046a1c2e3f4d5b6a7089c0d1e2f",
    intentHash: `0x${"33".repeat(32)}`,
    recoveryCommitment: `0x${"44".repeat(32)}`,
    rollupVersion: 4127419662n,
    resweepable: false,
    forwardingTable: "0x5a7b1e0000000000000000000000000000005a7b",
  }
  const sipaFactory = "0x0b903b955dbc0c97252f1ce9e43f8c26e8f5635f" as Address
  const token = "0x163a94b604dfcee8fac53ea6d24db032e8f5cd6b" as Address
  const relayer = "0x2e45a4e5d9100a4e8cb94f81257b5a1eba05a29b" as Address
  const consentSig = `0x${"cd".repeat(65)}` as Hex
  const domainAuth = { nonce: 7n, deadline: 1893456000n, signature: `0x${"ee".repeat(65)}` as Hex }
  const r1Install = {
    qx: `0x${"a1".repeat(32)}` as Hex,
    qy: `0x${"a2".repeat(32)}` as Hex,
    metadata: `0x${"cc".repeat(20)}` as Hex,
    signature: `0x${"dd".repeat(65)}` as Hex,
  }
  const args = {
    sipaFactory,
    sipa: SIPA,
    deployArgs,
    registrationData,
    consentSig,
    bootstrap: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a" as Address,
    domainAuth,
    signedTerms: EMPTY_SIGNED_TERMS,
    r1Install,
    token,
    relayer,
  }
  // The registration intent is the revealed intentData; the consent/domain/terms pack as proofs.
  const expectedSweep = (): SweepArgs => ({
    token,
    relayer,
    intentData: registrationData,
    proofs: encodeRegistrationProofs({
      consentSig,
      bootstrap: args.bootstrap,
      domainAuth,
      signedTerms: EMPTY_SIGNED_TERMS,
      r1Install,
    }),
  })

  it("sweeps a deployed registration SIPA directly, revealing the intent and its proofs", () => {
    const call = buildRegistrationSweepCall({ deployed: true, ...args })
    expect(call.to).toBe(SIPA)
    expect(call.data).toBe(encodeSweep(expectedSweep()))
  })
})

describe("fetchSipaEvents", () => {
  it("reads the token's SIPA events in the recipient's scope and joins the intent-hash limbs", async () => {
    const token = AztecAddress.fromBigIntUnsafe(0x70c3n)
    const recipient = AztecAddress.fromBigIntUnsafe(0xbee0n)
    const intentHash = `0x${"12".repeat(16)}${"34".repeat(16)}` as Hex
    const getPrivateEvents = vi.fn(async () => [
      {
        event: {
          shared_secret_salt: 7n,
          resweepable: true,
          intent_hash_hi: BigInt(`0x${"12".repeat(16)}`),
          intent_hash_lo: BigInt(`0x${"34".repeat(16)}`),
        },
      },
    ])
    const filter = { fromBlock: 3, toBlock: 9 } as never

    const events = await fetchSipaEvents({ getPrivateEvents } as never, token, recipient, filter)

    expect(events).toEqual([{ sharedSecretSalt: new Fr(7n), resweepable: true, intentHash }])
    expect(getPrivateEvents).toHaveBeenCalledWith(OxideTokenContract.events.SIPA, {
      fromBlock: 3,
      toBlock: 9,
      contractAddress: token,
      scopes: [recipient],
    })
  })
})
