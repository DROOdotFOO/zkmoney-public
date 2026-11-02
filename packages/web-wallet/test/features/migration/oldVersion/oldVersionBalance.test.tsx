import { act } from "react"
import { createRoot } from "react-dom/client"
import { beforeAll, beforeEach, expect, it } from "vitest"
import { BalanceStorage } from "@obsidion/front-core"
import { getConfig } from "../../../../src/config/env"
import { saveWalletIdentity } from "../../../../src/features/identity/walletIdentity"
import {
  markOldHoldingsRead,
  markUpgradeMovesFunds,
  oldVersionScope,
  setOldVersionDestinations,
  useOldVersionHoldings,
} from "../../../../src/features/migration/oldVersionBalance"
import {
  acquireUpgradeLock,
  releaseUpgradeLock,
} from "../../../../src/features/migration/upgradeLock"
import { walletStorage } from "../../../../src/platform/storage/walletStorage"
import { webStorage } from "../../../../src/platform/storage/WebStorageAdapter"
import { seedBootConfig } from "../../../support/seedBootConfig"

let PINNED = ""
beforeAll(async () => {
  await seedBootConfig()
  PINNED = getConfig().oxideProfile.portal.toLowerCase()
})
beforeEach(() => saveWalletIdentity({ address: "0xabc", claimedAt: 0 }))

const wad = 10n ** 18n

it.each([[false, false]])(
  "keeps each old account's value recorded (already current: %s, new scan: %s)",
  async (current, scan) => {
    if (current) walletStorage.setItem("webwallet.version/0xabc", PINNED)
    if (scan)
      setOldVersionDestinations(
        PINNED,
        new Map([
          ["0xoldmain", { tuple: { portal: PINNED } }],
          ["0xoldsavings", { tuple: { portal: "0xsavings" } }],
        ]),
      )
    else
      walletStorage.setItem(
        `webwallet.oldSavingsSources/${PINNED}`,
        JSON.stringify(["0xoldsavings"]),
      )
    markOldHoldingsRead("0xabc")
    const balances = BalanceStorage.get(webStorage)
    await balances.updateBalance(oldVersionScope("0xoldmain", "0xabc"), "0xtoken", 59n * wad)
    await balances.updateBalance(oldVersionScope("0xoldsavings", "0xabc"), "0xshares", 40n * wad)
    let shown!: ReturnType<typeof useOldVersionHoldings>
    function Holdings() {
      shown = useOldVersionHoldings()
      return null
    }
    const root = createRoot(document.createElement("div"))
    try {
      await act(async () => root.render(<Holdings />))
      expect(shown.recordedMain).toBe(59n * wad)
      expect(shown.recordedSavings).toBe(40n * wad)
      expect(shown.main).toBe(current ? 0n : 59n * wad)
      expect(shown.savings).toBe(current ? 0n : 40n * wad)
      expect(shown.total).toBe(shown.main + shown.savings)
      expect(shown.pending).toBe(false)
    } finally {
      act(() => root.unmount())
    }
  },
)

it("counts an upgraded account's old versions again while a later check offers to move them", async () => {
  // The upgrade did not see these funds, as when it could not read v5, and released the lock.
  walletStorage.setItem("webwallet.version/0xabc", PINNED)
  markOldHoldingsRead("0xabc")
  const balances = BalanceStorage.get(webStorage)
  await balances.updateBalance(oldVersionScope("0xoldmain", "0xabc"), "0xtoken", 12n * wad)
  await balances.updateBalance(oldVersionScope("0xoldsavings", "0xabc"), "0xshares", 0n)
  let shown!: ReturnType<typeof useOldVersionHoldings>
  function Holdings() {
    shown = useOldVersionHoldings()
    return null
  }
  const root = createRoot(document.createElement("div"))
  try {
    await act(async () => root.render(<Holdings />))
    // No check offers to move them: what is left is abandoned.
    expect(shown.main).toBe(0n)

    act(() => markUpgradeMovesFunds("0xabc", true))
    expect(shown.main).toBe(12n * wad)
    expect(shown.total).toBe(12n * wad)

    // The upgrade that moves them takes the lock, whose figure counts them.
    await act(() => acquireUpgradeLock("0xabc", 12n * wad))
    expect(shown.main).toBe(0n)

    // It finished: the next check offers nothing, and the lock opens.
    act(() => markUpgradeMovesFunds("0xabc", false))
    await act(() => releaseUpgradeLock("0xabc"))
    expect(shown.main).toBe(0n)
    expect(shown.total).toBe(0n)
  } finally {
    act(() => root.unmount())
  }
})
