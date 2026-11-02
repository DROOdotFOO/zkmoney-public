import { describe, expect, it } from "vitest"
import { entryBlock, type EntryConditions } from "../../../src/features/backupPasskey/backupPasskeyEntry"

const DAI = 10n ** 18n
const amount = (atomic: bigint) => `${atomic / DAI} DAI`

const ready: EntryConditions = {
  sessionIsRoot: true,
  verified: true,
  routeLive: true,
  registered: true,
  withdrawalInFlight: false,
  openLink: false,
  historicBalance: false,
  balance: 10n * DAI,
  fundingAmount: 2n * DAI,
  chunk: { kind: "fits" },
  plan: true,
  usesLeft: true,
}

const block = (over: Partial<EntryConditions>) => entryBlock({ ...ready, ...over }, amount)

describe("the add entry's conditions", () => {
  it("names each unmet condition", () => {
    expect(block({ sessionIsRoot: false })?.line).toBe("Use your first passkey to add a backup")
    expect(block({ verified: false })?.line).toBe("This account is not registered yet")
    expect(block({ routeLive: false })?.line).toBe("Not available on this network yet")
    expect(block({ registered: false })).toEqual({
      line: "Sponsored transactions are not set up",
      action: "sponsorship",
    })
    expect(block({ withdrawalInFlight: true })).toEqual({
      line: "Finish your withdrawal first",
      action: "activity",
    })
    expect(block({ openLink: true })).toEqual({
      line: "Finish your open paylinks first. Once a backup is added, links you made before can't be cancelled or reclaimed.",
      action: "activity",
    })
    expect(block({ historicBalance: true })).toEqual({
      line: "Finish your migration first",
      action: "migration",
    })
    expect(block({ balance: DAI })?.line).toBe("You need at least 2 DAI to add a backup")
    expect(block({ chunk: { kind: "short", chunk: 3n * DAI } })?.line).toBe(
      "Your balance is in too many small pieces to fund this. Send yourself 3 DAI first.",
    )
    expect(block({ plan: false })?.line).toBe(
      "Part of your balance is still syncing. Try again in a moment.",
    )
    expect(block({ usesLeft: false })?.line).toBe(
      "Not enough sponsored transactions left this period",
    )
  })

  it("a balance exactly at the funding amount is enough", () => {
    expect(block({ balance: 2n * DAI })).toBeUndefined()
  })
})
