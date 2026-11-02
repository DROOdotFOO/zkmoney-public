import { PaylinkActionEnum } from "@obsidion/core/constants"
import type { RecoveryMetadata } from "@obsidion/sdk"
import { describe, expect, it } from "vitest"
import {
  WATCH_CHECK_MS,
  WATCH_TAPER_MS,
  WATCH_WINDOW_MS,
  isDust,
  observeWatch,
  openWatch,
  previousRootKey,
  pushWatch,
  recordHoldsMoney,
  refundOnItsWay,
  watchCheckDue,
  type WatchObservation,
} from "../../../src/core/rotation/previousAccount"
import type { SIPADepositRecord } from "../../../src/core/services/deposits/SIPADepositStore"
import type { PreviousAccountWatch } from "../../../src/core/storages/PreviousAccountWatchStore"
import type { PaylinkTransaction } from "../../../src/types/transactions"

const A = "a1".repeat(64)
const B = "b2".repeat(64)
const C = "c3".repeat(64)
const OWNER = "0x00000000000000000000000000000000000000Ee"
const TWO_KEY = `0x${"22".repeat(32)}`
const ONE_KEY = `0x${"11".repeat(32)}`
const ENVELOPE = `0x${"01".repeat(62)}`

const root = (over: Partial<RecoveryMetadata> = {}): RecoveryMetadata => ({
  credentialId: "root-credential",
  l2Address: TWO_KEY,
  pubkey: A,
  isMskRoot: true,
  passkeySet: [A, B],
  ...over,
})

const backup = (over: Partial<RecoveryMetadata> = {}): RecoveryMetadata => ({
  credentialId: "backup-credential",
  l2Address: TWO_KEY,
  pubkey: B,
  isMskRoot: false,
  backup: { account: OWNER, envelope: ENVELOPE },
  passkeySet: [A, B],
  ...over,
})

/** A paylink's creation row, as the creating account stamps it, with a refund sent. */
const link = (over: Partial<PaylinkTransaction> = {}): PaylinkTransaction => ({
  timestamp: 1,
  status: "success",
  txHash: `0x${"66".repeat(32)}`,
  action: PaylinkActionEnum.PAY,
  emailPaymentAction: PaylinkActionEnum.PAY,
  flavor: "direct",
  obsidionAccountAddress: ONE_KEY,
  refundTxHash: `0x${"77".repeat(32)}`,
  ...over,
})

describe("previousRootKey", () => {
  it("names the root key from the root's record and from the backup's", () => {
    expect(previousRootKey(root())).toBe(A)
    expect(previousRootKey(backup())).toBe(A)
  })

  it("names the root from records as the wallet writes them", () => {
    // The re-root's pair: the root's stored fields carried over, the backup's from the rotation.
    const rerootRoot = root({ prfSlot: "first", authenticatorType: "platform" })
    const rerootBackup = {
      ...backup({ prfSlot: "second", authenticatorType: "security-key", transports: ["usb"] }),
      userHandle: "YWxpY2U",
    }
    // A sign-in by tag takes the set in the chain's order, which may list the backup first.
    const byTagRoot = root({ prfSlot: "first", passkeySet: [B, A], authenticatorType: "platform" })
    const byTagBackup = backup({
      prfSlot: "second",
      passkeySet: [B, A],
      authenticatorType: "platform",
    })
    // A browser only ever opened with the backup holds the backup's record alone.
    const backupOnly = backup({ prfSlot: "first", authenticatorType: "platform" })
    // A Ledger's raw credential id may begin with the byte oxide's envelope prefix uses.
    const raw = new Uint8Array(95).map((_, i) => (i * 37 + 11) & 0xff)
    raw[0] = 0x01
    const ledgerRoot = root({
      credentialId: Buffer.from(raw).toString("base64url"),
      authenticatorType: "security-key",
    })
    for (const record of [rerootRoot, rerootBackup, byTagRoot, byTagBackup, backupOnly, ledgerRoot])
      expect(previousRootKey(record)).toBe(A)
  })

  it("names nothing without a two-key set holding the record's own key", () => {
    const { passkeySet: _, ...unrotated } = root()
    expect(previousRootKey(unrotated)).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A] }))).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A, B, C] }))).toBeUndefined()
    expect(previousRootKey(backup({ passkeySet: [A, B, C] }))).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A, A] }))).toBeUndefined()
    expect(previousRootKey(root({ passkeySet: [A, `0x${A.toUpperCase()}`] }))).toBeUndefined()
    expect(previousRootKey(root({ pubkey: C }))).toBeUndefined()
    expect(previousRootKey(backup({ pubkey: C }))).toBeUndefined()
  })

  it("names nothing over a key that is not 64 bytes of hex", () => {
    expect(previousRootKey(root({ pubkey: "0x1234" }))).toBeUndefined()
    expect(previousRootKey(backup({ passkeySet: ["zz".repeat(64), B] }))).toBeUndefined()
  })

  it("compares keys across a 0x prefix and case, and names the root unprefixed in lowercase", () => {
    expect(previousRootKey(root({ pubkey: `0x${A.toUpperCase()}` }))).toBe(A)
    expect(previousRootKey(root({ passkeySet: [`0X${A}`, B.toUpperCase()] }))).toBe(A)
    expect(previousRootKey(backup({ pubkey: `0x${B}`, passkeySet: [A.toUpperCase(), B] }))).toBe(A)
  })
})

describe("isDust", () => {
  it("counts an amount below the floor as dust and one at the floor as not", () => {
    expect(isDust(9n, 10n)).toBe(true)
    expect(isDust(10n, 10n)).toBe(false)
    expect(isDust(0n, 0n)).toBe(false)
  })
})

const NOW = 1_000_000
const empty: WatchObservation = { completed: true, held: false, inFlight: false }
const holding: WatchObservation = { completed: true, held: true, inFlight: false }
const MOVE = {
  source: ONE_KEY,
  destination: TWO_KEY,
  txHash: `0x${"33".repeat(32)}` as const,
  expiresAtMs: NOW + 60_000,
  amount: "700",
}

describe("the watch window", () => {
  const fresh = openWatch(ONE_KEY, NOW)
  const end = NOW + WATCH_WINDOW_MS

  it("opens a fresh watch until a window from now", () => {
    expect(fresh).toEqual({ address: ONE_KEY, watchUntilMs: end })
    expect(watchCheckDue(fresh, NOW)).toBe(false)
  })

  it("pushes the end out on a holding check and leaves it on an empty one", () => {
    expect(observeWatch(fresh, holding, NOW + 5)).toEqual({
      address: ONE_KEY,
      watchUntilMs: end + 5,
    })
    expect(observeWatch(fresh, { ...holding, completed: false }, NOW + 5).watchUntilMs).toBe(
      end + 5,
    )
    expect(observeWatch(fresh, empty, NOW + 5)).toBe(fresh)
  })

  it("never pulls the end in", () => {
    expect(pushWatch({ ...fresh, watchUntilMs: end + 99 }, NOW).watchUntilMs).toBe(end + 99)
  })

  it("closes once its end has passed, on a complete check that found nothing", () => {
    expect(observeWatch(fresh, empty, end - 1)).toBe(fresh)
    expect(observeWatch(fresh, empty, end + 1)).toEqual({
      address: ONE_KEY,
      watchUntilMs: end,
      closed: true,
      closedAtMs: end + 1,
      lastCheckAtMs: end + 1,
    })
  })

  it("stays open past its end on an incomplete check, a chunk being sent or a chunk stored", () => {
    expect(observeWatch(fresh, { ...empty, completed: false }, end + 1)).toBe(fresh)
    expect(observeWatch(fresh, { ...empty, inFlight: true }, end + 1)).toBe(fresh)
    const moving = { ...fresh, move: MOVE }
    expect(observeWatch(moving, empty, end + 1)).toBe(moving)
  })

  it("is pushed out past its end by a refund on its way", () => {
    const refunding = { ...empty, held: refundOnItsWay(link(), ONE_KEY) }
    expect(observeWatch(fresh, refunding, end + 1)).toEqual({
      address: ONE_KEY,
      watchUntilMs: end + 1 + WATCH_WINDOW_MS,
    })
  })

  it("closes on a balance below the dust floor and stays open on one at the floor", () => {
    const dust = 10n
    const checked = (balance: bigint) =>
      observeWatch(fresh, { ...empty, held: !isDust(balance, dust) }, end + 1)
    expect(checked(9n).closed).toBe(true)
    expect(checked(10n).closed).toBeUndefined()
  })

  describe("once closed", () => {
    const closedAt = end + 1
    const closed = observeWatch(fresh, empty, closedAt)
    const nextDay = closedAt + WATCH_CHECK_MS

    it("is due its check once a day", () => {
      expect(watchCheckDue(closed, closedAt)).toBe(false)
      expect(watchCheckDue(closed, nextDay - 1)).toBe(false)
      expect(watchCheckDue(closed, nextDay)).toBe(true)
      const { lastCheckAtMs: _, ...unchecked } = closed
      expect(watchCheckDue(unchecked, closedAt)).toBe(true)
    })

    it("dates a closed watch with no close date at its next check, so the taper still runs out", () => {
      const { closedAtMs: _, ...undated } = closed
      let watch = observeWatch(undated, empty, nextDay)
      expect(watch.closedAtMs).toBe(nextDay)
      for (let day = 2; day < 60 && watchCheckDue(watch, nextDay + day * WATCH_CHECK_MS); day++) {
        watch = observeWatch(watch, empty, nextDay + day * WATCH_CHECK_MS)
      }
      expect(watch.closedAtMs).toBe(nextDay)
      expect(watch.lastCheckAtMs).toBeLessThan(nextDay + WATCH_TAPER_MS)
      expect(watchCheckDue(watch, nextDay + WATCH_TAPER_MS + WATCH_CHECK_MS)).toBe(false)
    })

    it("stops its daily checks once the taper after the close has run out", () => {
      const lastDay = closedAt + WATCH_TAPER_MS - 1
      expect(watchCheckDue({ ...closed, lastCheckAtMs: lastDay - WATCH_CHECK_MS }, lastDay)).toBe(
        true,
      )
      expect(watchCheckDue(closed, closedAt + WATCH_TAPER_MS)).toBe(false)
      const checkedDaily = observeWatch(closed, empty, closedAt + WATCH_TAPER_MS - WATCH_CHECK_MS)
      expect(checkedDaily.closedAtMs).toBe(closedAt)
      expect(watchCheckDue(checkedDaily, closedAt + WATCH_TAPER_MS + WATCH_CHECK_MS)).toBe(false)
    })

    it("stays closed on a complete check that found nothing, and is not due again that day", () => {
      const checked = observeWatch(closed, empty, nextDay)
      expect(checked).toEqual({ ...closed, lastCheckAtMs: nextDay })
      expect(watchCheckDue(checked, nextDay + 1)).toBe(false)
    })

    it("reopens for a window on a holding check", () => {
      expect(observeWatch(closed, holding, nextDay)).toEqual({
        address: ONE_KEY,
        watchUntilMs: nextDay + WATCH_WINDOW_MS,
        lastCheckAtMs: closedAt,
      })
      expect(observeWatch(closed, holding, nextDay).closedAtMs).toBeUndefined()
    })

    it("stays closed and unchecked on an incomplete check, so it is still due", () => {
      const short = { ...empty, completed: false }
      expect(observeWatch(closed, short, nextDay)).toBe(closed)
      expect(watchCheckDue(closed, nextDay + 1)).toBe(true)
      expect(observeWatch(closed, { ...holding, completed: false }, nextDay).closed).toBeUndefined()
    })

    it("dates an undated closed watch on an incomplete check, so the taper still runs out", () => {
      const { closedAtMs: _, ...undated } = closed
      const short = { ...empty, completed: false }
      const dated = observeWatch(undated, short, nextDay)
      expect(dated).toEqual({ ...undated, closedAtMs: nextDay })
      expect(observeWatch(dated, short, nextDay + WATCH_TAPER_MS)).toBe(dated)
      expect(watchCheckDue(dated, nextDay + WATCH_TAPER_MS)).toBe(false)
    })

    it("reopens when a chunk is stored or being sent", () => {
      expect(observeWatch({ ...closed, move: MOVE }, empty, nextDay).closed).toBeUndefined()
      expect(observeWatch(closed, { ...empty, inFlight: true }, nextDay).closed).toBeUndefined()
    })

    it("reopens when pushed", () => {
      const pushed: PreviousAccountWatch = pushWatch(closed, nextDay)
      expect(pushed.closed).toBeUndefined()
      expect(pushed.watchUntilMs).toBe(nextDay + WATCH_WINDOW_MS)
    })
  })
})

const DAI = "0x00000000000000000000000000000000000000Da"
const USDC = "0x0000000000000000000000000000000000000Cc0"
const OTHER = "0x00000000000000000000000000000000000000F0"
const PORTAL = "0x00000000000000000000000000000000000000Aa"
const OTHER_PORTAL = "0x00000000000000000000000000000000000000Bb"
const ROW = { portal: PORTAL, token: DAI }
const DUST = 10n
const SWEEP = {
  inboxIndex: "4",
  amount: "500",
  messageKey: `0x${"44".repeat(32)}` as const,
  blockNumber: "9",
  sweepTxHash: `0x${"55".repeat(32)}` as const,
  portal: PORTAL as `0x${string}`,
}

const deposit = (over: Partial<SIPADepositRecord> = {}): SIPADepositRecord => ({
  sipaAddress: "0x0000000000000000000000000000000000005150",
  recipientL2Address: ONE_KEY,
  messageSecret: "0x01",
  recipientHash: "0x02",
  recoveryAddress: "0x03",
  l1ChainId: 1,
  amount: "5",
  tokenSymbol: "DAI",
  phase: "claimed",
  startTime: 1,
  tokenAddress: DAI as `0x${string}`,
  ...over,
})

describe("recordHoldsMoney", () => {
  it("holds on a sweep not yet claimed, even at claimed", () => {
    expect(recordHoldsMoney(deposit({ pendingSweeps: [SWEEP] }), ROW, DUST)).toBe(true)
  })

  it("holds at pendingClaim with a zero balance", () => {
    expect(recordHoldsMoney(deposit({ phase: "pendingClaim", heldBalance: "0" }), ROW, DUST)).toBe(
      true,
    )
  })

  it("holds a claimed address paid again at or above the floor, and not below it", () => {
    expect(recordHoldsMoney(deposit({ heldBalance: "10" }), ROW, DUST)).toBe(true)
    expect(recordHoldsMoney(deposit({ heldBalance: "9" }), ROW, DUST)).toBe(false)
    expect(recordHoldsMoney(deposit(), ROW, DUST)).toBe(false)
  })

  it("holds while unsettled, and not once settled", () => {
    for (const phase of ["funding", "funded", "sweeping"] as const)
      expect(recordHoldsMoney(deposit({ phase }), ROW, DUST)).toBe(true)
    for (const phase of ["claimed", "failed", "recovered"] as const)
      expect(recordHoldsMoney(deposit({ phase }), ROW, DUST)).toBe(false)
  })

  it("does not hold an address published and never paid", () => {
    const unpaid = deposit({ phase: "broadcast", amount: "0", tokenAddress: undefined })
    expect(recordHoldsMoney(unpaid, ROW, DUST)).toBe(false)
    expect(recordHoldsMoney({ ...unpaid, amount: "3" }, ROW, DUST)).toBe(true)
  })

  it("never holds on a payment only an L1 recovery moves", () => {
    expect(recordHoldsMoney(deposit({ phase: "recoverable", heldBalance: "1" }), ROW, DUST)).toBe(
      false,
    )
    expect(
      recordHoldsMoney(deposit({ phase: "recoverable", heldBalance: "1000" }), ROW, DUST),
    ).toBe(false)
  })

  it("does not hold on another token's row", () => {
    const other = { tokenAddress: OTHER as `0x${string}` }
    expect(recordHoldsMoney(deposit({ ...other, phase: "pendingClaim" }), ROW, DUST)).toBe(false)
    expect(recordHoldsMoney(deposit({ ...other, heldBalance: "1000" }), ROW, DUST)).toBe(false)
    const elsewhere = { ...SWEEP, portal: OTHER_PORTAL as `0x${string}` }
    expect(recordHoldsMoney(deposit({ ...other, pendingSweeps: [elsewhere] }), ROW, DUST)).toBe(
      false,
    )
  })

  it("names the row by its token in any case, a swapped funding's row token, or a sweep's portal", () => {
    const upper = deposit({ phase: "funded", tokenAddress: DAI.toUpperCase() as `0x${string}` })
    expect(recordHoldsMoney(upper, ROW, DUST)).toBe(true)
    const swapped = deposit({
      phase: "funded",
      tokenAddress: USDC as `0x${string}`,
      rowToken: DAI as `0x${string}`,
    })
    expect(recordHoldsMoney(swapped, ROW, DUST)).toBe(true)
    const repaid = deposit({ tokenAddress: OTHER as `0x${string}`, pendingSweeps: [SWEEP] })
    expect(recordHoldsMoney(repaid, ROW, DUST)).toBe(true)
  })

  it("holds a record that names no token yet", () => {
    expect(recordHoldsMoney(deposit({ phase: "funded", tokenAddress: undefined }), ROW, DUST)).toBe(
      true,
    )
  })
})

describe("refundOnItsWay", () => {
  it("is a refund sent and not landed of a link the account made, whatever the address's case", () => {
    expect(refundOnItsWay(link(), ONE_KEY)).toBe(true)
    expect(refundOnItsWay(link({ isRefunded: false }), ONE_KEY.toUpperCase())).toBe(true)
  })

  it("is not one once the refund landed, or before any was sent", () => {
    expect(refundOnItsWay(link({ isRefunded: true }), ONE_KEY)).toBe(false)
    expect(refundOnItsWay(link({ refundTxHash: undefined }), ONE_KEY)).toBe(false)
  })

  it("is not one for a link another account made, or one naming no creator", () => {
    expect(refundOnItsWay(link({ obsidionAccountAddress: TWO_KEY }), ONE_KEY)).toBe(false)
    expect(refundOnItsWay(link({ obsidionAccountAddress: undefined }), ONE_KEY)).toBe(false)
  })

  it("is not one for a row that is not the link's creation", () => {
    const claim = link({
      action: PaylinkActionEnum.CLAIM,
      emailPaymentAction: PaylinkActionEnum.CLAIM,
    })
    expect(refundOnItsWay(claim, ONE_KEY)).toBe(false)
  })
})
