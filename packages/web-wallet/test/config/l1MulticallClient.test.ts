// @vitest-environment node
/**
 * The registration discovery derives every fee under both salts at once; through
 * `l1MulticallClient` the deriver's reads leave as one implementation read and one predictSIPA batch.
 */
import { describe, expect, it, vi } from "vitest"
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem"
import { foundry } from "viem/chains"
import { Fr } from "@aztec-labs/foundation/curves/bn254"

const h = vi.hoisted(() => ({ batches: [] as { to: string; calls: number }[] }))

vi.mock("../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/env")>()),
  l1Transport: () =>
    custom({
      async request({ method, params }: { method: string; params: [{ to: string; data: Hex }] }) {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`)
        const { to, data } = params[0]
        const { args } = decodeFunctionData({ abi: multicall3Abi, data }) as unknown as {
          args: [readonly unknown[]]
        }
        h.batches.push({ to, calls: args[0].length })
        const address = encodeAbiParameters(
          [{ type: "address" }],
          ["0x00000000000000000000000000000000000000b2"],
        )
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: args[0].map(() => ({ success: true, returnData: address })),
        })
      },
    }),
}))

import {
  createRegistrationSipaDeriver,
  NO_NAME_PORTAL_RECIPIENT,
  oxideEnvFromTuple,
} from "@obsidion/front-core"
import { MULTICALL3_ADDRESS } from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { l1MulticallClient } from "../../src/config/oxideTuple"
import type { WebWalletConfig } from "../../src/config/env"

const TUPLE = {
  rollupVersion: "3",
  registry: "0x0000000000000000000000000000000000000001",
  ensDomain: "zk.money",
  token: "0x0000000000000000000000000000000000000004",
  portal: "0x0000000000000000000000000000000000000012",
  sipaFactory: "0x0000000000000000000000000000000000000013",
  forwardingTable: "0x0000000000000000000000000000000000000014",
} as unknown as OxideEnvTuple

describe("l1MulticallClient", () => {
  it("sends a discovery's fourteen address predictions as one call", async () => {
    const client = l1MulticallClient({ l1Chain: foundry } as unknown as WebWalletConfig)
    const env = oxideEnvFromTuple(TUPLE, {
      resolverOperator: "0x00000000000000000000000000000000000000e6",
      l1ChainId: foundry.id,
      accountFactory: "0x0000000000000000000000000000000000000002",
      namePortalRecipient: NO_NAME_PORTAL_RECIPIENT,
    })
    const derive = createRegistrationSipaDeriver({ publicClient: client, env, tuple: TUPLE })
    const salts = [undefined, `0x${"05".repeat(31)}` as Hex]
    await Promise.all(
      salts.flatMap((sharedSecretSalt) =>
        [0n, 1n, 2n, 3n, 4n, 5n, 6n].map((fee) =>
          derive({
            owner: "0x00000000000000000000000000000000000000c3",
            nameHash: `0x${"0d".repeat(32)}`,
            l2Address: `0x${"0e".repeat(32)}`,
            fee,
            beneficiary: "0x00000000000000000000000000000000000000f4",
            masterSecret: new Fr(7n),
            sharedSecretSalt,
          }),
        ),
      ),
    )
    expect(h.batches).toEqual([
      { to: MULTICALL3_ADDRESS, calls: 1 },
      { to: MULTICALL3_ADDRESS, calls: 14 },
    ])
  })
})
