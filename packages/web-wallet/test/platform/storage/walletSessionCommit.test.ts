import type { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, describe, expect, it } from "vitest"
import { signOut } from "../../../src/features/identity/signOut"
import { WebAlphaAuthService } from "../../../src/platform/auth/WebAlphaAuthService"
import {
  closeSession,
  followSavedSession,
  switchSession,
  openedSession,
} from "../../../src/platform/session"
import {
  getActiveStorageId,
  readCommittedSession,
  withSessionLock,
} from "../../../src/platform/storage/activeStorage"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { FakePasskeyCeremony, MemoryStorage } from "../../support/fakePasskeyCeremony"
import { testWalletDbs } from "../../support/fakeWalletDb"

const dbs = testWalletDbs()
const ADDR = "0xacct"

afterEach(closeSession)

function gate() {
  let open!: () => void
  let fail!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    open = res
    fail = rej
  })
  return { promise, open, fail }
}

async function setup(onSessionSaved?: () => void) {
  const ceremony = new FakePasskeyCeremony({ route: "local" })
  const storage = new MemoryStorage()
  const make = () =>
    new WebAlphaAuthService({
      storage,
      rpId: "localhost",
      ceremony,
      posture: () => "phone",
      onSessionSaved,
    })
  const service = make()
  const created = await service.createPasskey("@alice")
  await service.recordRecoveryMetadata({
    credentialId: created.credentialId,
    l2Address: ADDR,
    pubkey: created.pubkey,
    prfSlot: created.prfSlot,
    isMskRoot: true,
    transports: created.transports,
  })
  const input = { secretKey: created.secretKey, authProvider: created.authProvider }
  const derive = async (msk: Fr, passkeys: readonly string[]) =>
    msk.toString() === created.secretKey.toString() &&
    passkeys.length === 1 &&
    passkeys[0] === created.pubkey
      ? ADDR
      : "0xother"
  const restorable = () => {
    const fresh = make()
    fresh.setAddressDeriver(derive)
    fresh.setAccountReader(async () => ({
      kind: "webauthn",
      credentialId: created.credentialId,
      pubkey: created.pubkey,
      address: ADDR,
    }))
    return fresh
  }
  return { service, input, restorable }
}

/** Holds the next wallet transaction until the returned gate opens or fails; `entered` marks it reached. */
function holdNextWrite() {
  const held = gate()
  const reached = gate()
  let armed = true
  dbs.onApply = async () => {
    if (!armed) return
    armed = false
    reached.open()
    await held.promise
  }
  return { ...held, entered: reached.promise }
}

describe("session commit against the wallet database", () => {
  it("stores nothing and installs no key when its transaction fails", async () => {
    const { service, input } = await setup()
    dbs.onApply = () => {
      throw new Error("disk")
    }
    await expect(service.commitSecret(input)).rejects.toThrow("disk")
    expect(getActiveStorageId()).toBeNull()
    expect(await service.getSecretKey()).toBeUndefined()
  })

  it("installs no key when a sign-out lands while the commit is saving, and ends signed out", async () => {
    const { service, input } = await setup()
    const held = holdNextWrite()
    const commit = service.commitSecret(input, () => true)
    await held.entered
    service.lockOut()
    const out = signOut()
    held.open()
    expect(await commit).toBe(false)
    await out
    expect(await service.getSecretKey()).toBeUndefined()
    expect(readCommittedSession()).toEqual({ storageId: null, credentialId: null, cache: null })
  })

  it("ends signed out with nothing re-written when the overlapped commit fails", async () => {
    const { service, input } = await setup()
    const held = holdNextWrite()
    const commit = service.commitSecret(input, () => true)
    await held.entered
    service.lockOut()
    const out = signOut()
    held.fail(new Error("disk"))
    await expect(commit).rejects.toThrow("disk")
    await out
    expect(readCommittedSession()).toEqual({ storageId: null, credentialId: null, cache: null })
  })

  it("writes nothing when a sign-out lands before the save starts", async () => {
    const { service, input } = await setup()
    let writes = 0
    dbs.onApply = () => {
      writes++
    }
    const commit = service.commitSecret(input, () => true)
    service.lockOut()
    expect(await commit).toBe(false)
    expect(writes).toBe(0)
  })

  it("writes nothing when a sign-out lands while the commit waits for the session lock", async () => {
    const { service, input } = await setup()
    const held = gate()
    const holder = withSessionLock(() => held.promise)
    const commit = service.commitSecret(input, () => true)
    await new Promise((r) => setTimeout(r, 0))
    service.lockOut()
    held.open()
    await holder
    expect(await commit).toBe(false)
    expect(getActiveStorageId()).toBeNull()
  })

  it("removes what it saved when its attempt is cancelled mid-save, and opens no session", async () => {
    const { service, input } = await setup(followSavedSession)
    const anonymous = switchSession({ id: null, prefix: "" })
    let live = true
    const held = holdNextWrite()
    const commit = service.commitSecret(input, () => live)
    await held.entered
    live = false
    held.open()
    expect(await commit).toBe(false)
    expect(await service.getSecretKey()).toBeUndefined()
    expect(readCommittedSession()).toEqual({ storageId: null, credentialId: null, cache: null })
    expect(openedSession.get()).toBe(anonymous)
  })

  it("puts back the session a cancelled switch replaced", async () => {
    const { service, input } = await setup()
    await service.commitSecret(input)
    await walletStorage.flush()
    const before = readCommittedSession()
    const other = await service.createPasskey("@bob")
    let live = true
    const held = holdNextWrite()
    const commit = service.commitSecret(
      { secretKey: other.secretKey, authProvider: other.authProvider },
      () => live,
    )
    await held.entered
    live = false
    held.open()
    expect(await commit).toBe(false)
    expect(readCommittedSession()).toEqual(before)
    expect((await service.getSecretKey())?.toString()).toBe(input.secretKey.toString())
  })

  it("stays locked when a cancelled commit's cleanup fails", async () => {
    const { input, restorable } = await setup()
    const locked = restorable()
    let live = true
    const save = gate()
    const saveReached = gate()
    let writes = 0
    dbs.onApply = async () => {
      writes++
      if (writes === 1) {
        saveReached.open()
        await save.promise
      }
      if (writes === 2) throw new Error("disk")
    }
    const commit = locked.commitSecret(input, () => live)
    await saveReached.promise
    live = false
    save.open()
    await expect(commit).rejects.toThrow("disk")
    dbs.onApply = undefined
    expect(await locked.getSecretKey()).toBeUndefined()
  })

  it("moves the account namespace only once the session is saved", async () => {
    const { service, input } = await setup()
    const held = holdNextWrite()
    const commit = service.commitSecret(input, () => true)
    await held.entered
    expect(getActiveStorageId()).toBeNull()
    held.fail(new Error("disk"))
    await expect(commit).rejects.toThrow("disk")
    expect(getActiveStorageId()).toBeNull()
    dbs.onApply = undefined
    await service.commitSecret(input)
    expect(getActiveStorageId()).not.toBeNull()
  })

  it("keeps a later attempt's identical session when an earlier one is cancelled", async () => {
    const { service, input } = await setup()
    let firstLive = true
    const held = holdNextWrite()
    const first = service.commitSecret(input, () => firstLive)
    const second = service.commitSecret(input, () => true)
    await held.entered
    firstLive = false
    held.open()
    expect(await first).toBe(false)
    expect(await second).toBeTypeOf("number")
    expect(readCommittedSession().storageId).not.toBeNull()
    expect(readCommittedSession().cache).not.toBeNull()
  })

  it("does not restore from a cache while a session write is still saving", async () => {
    const { service, input, restorable } = await setup()
    await service.commitSecret(input)
    const locked = restorable()
    const held = holdNextWrite()
    const pending = locked.commitSecret(input, () => true)
    await held.entered
    expect(await locked.getSecretKey()).toBeUndefined()
    held.fail(new Error("disk"))
    await expect(pending).rejects.toThrow("disk")
  })

  it("finishes removing a rejected cache's session before the restore settles", async () => {
    const { service, input, restorable } = await setup()
    await service.commitSecret(input)
    await walletStorage.flush()
    const locked = restorable()
    locked.setAddressDeriver(async () => "0xother")
    const held = holdNextWrite()
    let settled = false
    const restored = locked.getSecretKey().then((key) => {
      settled = true
      return key
    })
    await held.entered
    expect(settled).toBe(false)
    held.open()
    expect(await restored).toBeUndefined()
    expect(getActiveStorageId()).toBeNull()
  })

  it("restores from the saved cache once no write is in flight", async () => {
    const { service, input, restorable } = await setup()
    await service.commitSecret(input)
    await walletStorage.flush()
    const locked = restorable()
    expect((await locked.getSecretKey())?.toString()).toBe(input.secretKey.toString())
  })
})
