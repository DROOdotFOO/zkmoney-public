/**
 * The `localStorage` side of the wallet. Wallet state lives in the rollup's wallet database; what
 * stays here: device keys (this browser's, not a rollup's), the partition accessors the Google
 * sign-in relay uses (`rollup.<version>.<key>`), and the cleanup of the wallet state older builds
 * kept here. The active rollup is set once by `resolveBootConfig`; a partitioned read before that
 * is a boot-order bug and throws. No-ops without `localStorage`.
 */
const PREFIX = "rollup."
/** The demo boot's partition: no profile can carry it, and it reaches into no other. */
export const DEMO_ROLLUP = "demo"

/** Keys about this browser rather than a rollup: never prefixed, never removed as old wallet state. */
export const DEVICE_KEYS: ReadonlySet<string> = new Set([
  "zkm_bid",
  "zkm_sid",
  "zkm_rid",
  "webwallet.hide-balances",
  "webwallet.hide-deposit-privacy-disclaimer",
  "webwallet.hide-paylink-info",
  "webwallet.hide-withdraw-privacy-disclaimer",
  "webwallet.local-passkey-hint-shown",
  "webwallet.local-refusals",
  "webwallet.passkey-names",
  "webwallet.ticket-intro-seen",
  "webwallet.passkeyEnv",
  "webwallet.handoff",
  // A payer with no account has no wallet database.
  "webwallet.unresolved-payments",
  // Read before the profile names a rollup, and a user's node choice outlives a roll.
  "webwallet.endpoints",
  // The signup analytics' channel and source, kept an hour.
  "webwallet.attribution",
  // An invite link's code, until the signup it brought names its inviter.
  "webwallet.inbound-invite",
])

/** Families older builds kept wallet state under, at the top level and in partitions. */
const OLD_WALLET_FAMILIES = ["webwallet.", "obsidion.", "obsidion-google-callback"]
/** The Google sign-in relay's keys (`googleAuth.tsx`), kept in the active partition. */
const RELAY_FAMILY = "obsidion-google-callback"

/** One partition per page, shared by every instance of this module. */
const PARTITION_STATE = Symbol.for("zk.money/rollup-partition")
type PartitionState = { version?: string }
const state: PartitionState = ((globalThis as { [PARTITION_STATE]?: PartitionState })[
  PARTITION_STATE
] ??= {})

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage)

export function setActiveRollup(version: string): void {
  state.version = version
}

export function activeRollup(): string {
  if (!state.version) {
    throw new Error(
      "rollup partition read before resolveBootConfig() — the wallet boots from a config profile, " +
        "and no partition exists until it has resolved.",
    )
  }
  return state.version
}

export function __resetActiveRollupForTests(): void {
  delete state.version
}

export function rollupKey(key: string): string {
  return `${PREFIX}${activeRollup()}.${key}`
}

export const rollupStorage = {
  getItem(key: string): string | null {
    const store = storage()
    return store ? store.getItem(rollupKey(key)) : null
  },
  setItem(key: string, value: string): void {
    storage()?.setItem(rollupKey(key), value)
  },
  removeItem(key: string): void {
    storage()?.removeItem(rollupKey(key))
  },
  /** The active partition's keys, prefix stripped. */
  keys(): string[] {
    const store = storage()
    if (!store) return []
    const prefix = rollupKey("")
    return Object.keys(store)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  },
}

const assertDeviceKey = (key: string) => {
  if (!DEVICE_KEYS.has(key)) throw new Error(`${key} is not a device key`)
}

/** Unprefixed access for {@link DEVICE_KEYS} only. */
export const deviceStorage = {
  getItem(key: string): string | null {
    assertDeviceKey(key)
    return storage()?.getItem(key) ?? null
  },
  setItem(key: string, value: string): void {
    assertDeviceKey(key)
    storage()?.setItem(key, value)
  },
  removeItem(key: string): void {
    assertDeviceKey(key)
    storage()?.removeItem(key)
  },
}

/**
 * Deletes the wallet state older builds kept here, cached master key included: the wallet families
 * at the top level and in every partition (except the active partition's relay entries), their
 * import markers and wagmi's old store; with `names`, only those keys, wherever they sit. Device
 * and third-party keys stay. A key that cannot be removed does not stop the rest; the first failure
 * is thrown once they have been tried.
 */
export function removeOldWalletKeys(names?: readonly string[]): void {
  const store = storage()
  if (!store) return
  const relay = rollupKey(RELAY_FAMILY)
  let failed: { error: unknown } | undefined
  for (const key of Object.keys(store)) {
    if (!isOldWalletKey(key, relay) || (names && !names.includes(nameOf(key)))) continue
    try {
      store.removeItem(key)
    } catch (error) {
      failed ??= { error }
    }
  }
  if (failed) throw failed.error
}

/** A key's name without its `rollup.<version>.` prefix. */
const nameOf = (key: string) =>
  key.startsWith(PREFIX) ? key.slice(key.indexOf(".", PREFIX.length) + 1) : key

function isOldWalletKey(key: string, relay: string): boolean {
  if (key.startsWith("zkm_wallet_imported.") || key === "wagmi.store") return true
  if (key.startsWith(relay) || DEVICE_KEYS.has(key)) return false
  return OLD_WALLET_FAMILIES.some((family) => nameOf(key).startsWith(family))
}
