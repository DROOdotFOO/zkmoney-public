import { expect, it } from "vitest"
import { FakeLocks } from "../../support/fakeLocks"

const locks = new FakeLocks()
Object.defineProperty(navigator, "locks", { configurable: true, value: locks })

const { contactsWriteLock } = await import("../../../src/platform/storage/contactsLock")

it("runs the critical section under the contacts-write Web Lock", async () => {
  expect(await contactsWriteLock(async () => locks.isHeld("contacts-write"))).toBe(true)
})
