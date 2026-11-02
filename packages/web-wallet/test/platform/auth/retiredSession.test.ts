import { beforeEach, describe, expect, it } from "vitest"
import { signOut } from "../../../src/features/identity/signOut"
import {
  findRetiredSession,
  forgetRetiredSession,
  retiredSession,
} from "../../../src/platform/auth/retiredSession"
import { WebAlphaAuthService } from "../../../src/platform/auth/WebAlphaAuthService"
import { storageIdFromSecret } from "../../../src/platform/storage/activeStorage"
import { setActiveRollup } from "../../../src/platform/storage/rollupStorage"
import { closeWalletStore, openWalletStore } from "../../../src/platform/storage/walletStorage"
import { sandboxProfile } from "../../fixtures/sandboxProfile"
import { FakePasskeyCeremony, MemoryStorage } from "../../support/fakePasskeyCeremony"
import { testWalletDbs } from "../../support/fakeWalletDb"

const dbs = testWalletDbs()
const ACTIVE = sandboxProfile().shared.rollupVersion
const RP = "localhost"

const service = () =>
  new WebAlphaAuthService({
    storage: new MemoryStorage(),
    rpId: RP,
    ceremony: new FakePasskeyCeremony({ route: "local" }),
    posture: () => "phone",
  })

type Created = Awaited<ReturnType<WebAlphaAuthService["createPasskey"]>>

/** `created`'s session and record in `version`'s database, as that rollup's wallet left them. */
async function seedRetired(version: string, created: Created, passkeySet?: unknown) {
  const storageId = await storageIdFromSecret(new Uint8Array(created.secretKey.toBuffer()))
  const { credentialId, pubkey, prfSlot } = created
  const state = dbs.db(version).state
  state.set("webwallet.storageId", storageId)
  state.set("webwallet.credentialId", credentialId)
  state.set(
    "webwallet.msk",
    JSON.stringify({ v: 1, storageId, credentialId, msk: created.secretKey.toString() }),
  )
  state.set(
    "obsidion.obsidion_web_passkey_identity_map",
    JSON.stringify({
      version: 1,
      entries: {
        [credentialId]: {
          credentialId,
          pubkey,
          prfSlot,
          isMskRoot: true,
          rpId: RP,
          usertag: "alice",
          ...(passkeySet !== undefined ? { passkeySet } : {}),
        },
      },
    }),
  )
}

async function boot() {
  await closeWalletStore()
  setActiveRollup(ACTIVE)
  await openWalletStore(ACTIVE, { persistent: true })
  await findRetiredSession(RP)
}

beforeEach(() => forgetRetiredSession())

describe("retired session", () => {
  it("answers the cache source with the retired key, its tag, and no address", async () => {
    const auth = service()
    const created = await auth.createPasskey("@alice")
    await seedRetired("111", created)
    await boot()
    const cached = await auth.recoverFromCache()
    expect(cached?.credentialId).toBe(created.credentialId)
    expect(cached?.candidates[created.prfSlot ?? "first"]?.toString()).toBe(
      created.secretKey.toString(),
    )
    expect(cached?.expectedAddress).toBeUndefined()
    expect(cached?.usertag).toBe("alice")
    // A tap's read never takes it.
    expect(await auth.recoverFromCache({ restore: false })).toBeUndefined()
  })

  it("is none when retired databases name different sessions", async () => {
    await seedRetired("111", await service().createPasskey("@alice"))
    await seedRetired("222", await service().createPasskey("@bob"))
    await boot()
    expect(retiredSession()).toBeUndefined()
  })

  it("is none for a key that does not derive its storage id", async () => {
    await seedRetired("111", await service().createPasskey("@alice"))
    const state = dbs.db("111").state
    const cache = JSON.parse(state.get("webwallet.msk")!)
    state.set("webwallet.msk", JSON.stringify({ ...cache, msk: `0x${"01".repeat(32)}` }))
    await boot()
    expect(retiredSession()).toBeUndefined()
  })

  it.each([
    ["not a list", "ab"],
    ["a list holding null", [null]],
  ])("skips only the database whose record's key set is %s", async (_, passkeySet) => {
    const created = await service().createPasskey("@alice")
    await seedRetired("111", created, passkeySet)
    await seedRetired("222", created)
    await boot()
    expect(retiredSession()?.credentialId).toBe(created.credentialId)
  })

  it("is gone after a sign-out, which also removes it from the retired database", async () => {
    await seedRetired("111", await service().createPasskey("@alice"))
    await boot()
    expect(retiredSession()).toBeDefined()
    await signOut()
    expect(retiredSession()).toBeUndefined()
    await findRetiredSession(RP)
    expect(retiredSession()).toBeUndefined()
  })
})
