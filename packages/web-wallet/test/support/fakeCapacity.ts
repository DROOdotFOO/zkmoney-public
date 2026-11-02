/**
 * A stand-in for `features/deposit/capacityStore` in component tests: real front-core stores over a
 * fake reader whose available capacity, and whether reads and the active key fail, a test sets.
 */
import {
  createPortalCapacityStore,
  portalCapacityKey,
  type PortalCapacityKey,
  type PortalCapacityStore,
} from "@obsidion/front-core"

export const FAKE_ACTIVE_KEY: PortalCapacityKey = {
  chainId: 11155111,
  portal: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
}

export interface FakeCapacity {
  availableAtomic: bigint
  /** The bucket's ceiling; 100,000 tokens unless a test sets it. */
  globalLimitAtomic?: bigint
  readFails?: boolean
  keyFails?: boolean
  /** Keys whose stores were asked for, by key id. */
  keys?: string[]
  /** The rows the active key was asked for; undefined for the pinned bridge's. */
  rowTokens?: (string | undefined)[]
  /** Bump between tests so each starts from a new store and a new read. */
  epoch?: number
}

export function fakeCapacityStore(capacity: FakeCapacity) {
  const stores = new Map<string, PortalCapacityStore>()
  return {
    activeCapacityKey: async (rowToken?: string) => {
      capacity.rowTokens?.push(rowToken)
      if (capacity.keyFails) throw new Error("manifest unavailable")
      return FAKE_ACTIVE_KEY
    },
    depositCapacityStore: (bucket: PortalCapacityKey) => {
      const key = portalCapacityKey(bucket)
      const id = `${key.chainId}|${key.portal}|${key.token}`
      capacity.keys?.push(id)
      const storeId = `${capacity.epoch ?? 0}|${id}`
      let store = stores.get(storeId)
      if (!store) {
        let block = 0n
        store = createPortalCapacityStore(key, {
          read: async () => {
            if (capacity.readFails) throw new Error("capacity read failed")
            block += 1n
            return {
              ...key,
              decimals: 18,
              blockNumber: block,
              blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
              rateAtomicPerSecond: 10n ** 18n,
              globalLimitAtomic: capacity.globalLimitAtomic ?? 100_000n * 10n ** 18n,
              availableAtomic: capacity.availableAtomic,
              txAmountCapAtomic: 5166n * 10n ** 18n,
            }
          },
          policy: { maxHeadAgeMs: Infinity },
          visibility: { isVisible: () => true, onResume: () => () => {} },
        })
        stores.set(storeId, store)
      }
      return store
    },
  }
}
