import { vi } from "vitest"
import type { Address } from "viem"
import { SIPADepositStore, type SipaDepositSyncResult } from "@obsidion/front-core"
import { observeDeposits, resetDepositPassesForTests } from "../../src/features/deposit/depositPasses"
import { getSipaDepositGateway } from "../../src/features/deposit/sipaGateway"
import { webStorage } from "../../src/platform/storage/WebStorageAdapter"

/**
 * Stands in for the rail's observe-only pass, behind the real scheduler: each pass writes what
 * `held` answers, in fee-token units, onto the record of each address `addresses` names. A pass
 * that sees nothing new writes nothing, as the rail's does.
 */
export function provideFakeDepositRail(opts: {
  addresses: () => readonly (string | undefined)[]
  held: (address: Address) => bigint | Promise<bigint>
  token?: (address: Address) => Address | undefined
}) {
  resetDepositPassesForTests()
  const observe = vi.spyOn(getSipaDepositGateway(), "observe").mockImplementation(async () => {
    const store = SIPADepositStore.get(webStorage)
    await store.load()
    for (const address of opts.addresses()) {
      if (!address) continue
      const balance = await opts.held(address as Address)
      const stored = store.get(address as Address)
      if (stored?.observedFrom && stored.heldBalance === balance.toString()) continue
      const token = opts.token?.(address as Address)
      await store.upsert(
        address as Address,
        {
          phase: stored?.phase ?? "resolved",
          observedFrom: "1",
          heldBalance: balance.toString(),
          ...(balance > 0n && token ? { tokenAddress: token } : {}),
        },
        { networkId: "0xnet", amount: "0", startTime: Date.now() } as never,
      )
    }
    return {} as SipaDepositSyncResult
  })
  observeDeposits({} as never, `0x${"cd".repeat(32)}`)
  return observe
}
