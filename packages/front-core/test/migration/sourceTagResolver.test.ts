import { describe, expect, it } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PublicClient } from "viem"
import { sourceTagResolver } from "../../src/core/migration/sourceTagResolver"

const tuple = {
  portal: `0x${"01".repeat(20)}`,
  registry: `0x${"02".repeat(20)}`,
  accountMetadataRegistry: `0x${"03".repeat(20)}`,
  ensDomain: "zk.money",
  rollupVersion: "4248422647",
  deployedAt: "2026-09-25T00:00:00.000Z",
  deployedAtBlock: "100",
} as unknown as OxideEnvTuple

describe("sourceTagResolver", () => {
  it("keeps the address when the tag cannot be read, and reads the freeze once", async () => {
    let reads = 0
    const client = {
      getContractEvents: async () => {
        reads++
        throw new Error("RPC unavailable")
      },
    } as unknown as PublicClient
    const resolve = sourceTagResolver(client, tuple, 200n)!

    expect(await resolve("alice")).toBeNull()
    const afterFirst = reads
    expect(await resolve("bob")).toBeNull()
    expect(reads).toBe(afterFirst)
  })
})
