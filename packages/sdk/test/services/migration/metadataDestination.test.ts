import { expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, PublicClient } from "viem"
import { readBridgeDestination } from "../../../src/services/migration/metadataMigration.js"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address

const tuple = {
  chainId: 1,
  rollupVersion: 7,
  registry: addr(1),
  accountMetadataRegistry: addr(2),
  registrationController: addr(3),
  sipaFactory: addr(4),
  forwardingTable: addr(5),
  portal: addr(6),
  namePortal: addr(8),
  token: addr(9),
  depositSubsidy: addr(10),
  operationExecutor: addr(11),
} as unknown as OxideEnvTuple

it("reads the settlement token from the portal's asset", async () => {
  const susds = addr(20)
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "UNDERLYING") return susds
    return 10n ** 24n
  })
  const client = { readContract } as unknown as PublicClient
  const destination = await readBridgeDestination(client, tuple)
  expect(destination.token.toLowerCase()).toBe(susds.toLowerCase())
})

it("does not use the manifest token when the portal asset read fails", async () => {
  const client = {
    readContract: async () => {
      throw new Error("RPC unavailable")
    },
  } as unknown as PublicClient
  await expect(readBridgeDestination(client, tuple)).rejects.toThrow("RPC unavailable")
})
