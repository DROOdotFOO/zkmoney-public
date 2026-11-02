// @vitest-environment node
/**
 * The wallet's envelope opener over a real assertion: the user must have been verified, the PRF
 * the assertion returned opens an envelope sealed under it in either slot, and nothing else does.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { MSK_PRF_SALT } from "@obsidion/core/constants"
import type { PrfSlot } from "@obsidion/core/types"
import { PasskeyEnvelopeError, sealMasterKey } from "@obsidion/front-core"
import { describe, expect, it } from "vitest"
import { openBackupEnvelope } from "../../../src/platform/auth/backupEnvelope"
import {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  contextualiseLocal,
} from "../../support/fakePasskeyCeremony"

const ACCOUNT = `0x${"11".repeat(20)}` as const

/** One passkey on a fake authenticator, and an assertion from it carrying both PRF slots. */
async function passkey(opts: FakeCeremonyOptions = {}) {
  const ceremony = new FakePasskeyCeremony({ route: "local", ...opts })
  const { credentialId } = await ceremony.create({
    rpId: "localhost",
    rpName: "test",
    userName: "@alice",
    prfFirstSalt: MSK_PRF_SALT,
  })
  const assert = () =>
    ceremony.assert({
      rpId: "localhost",
      challenge: new Uint8Array(32),
      credentialIds: [credentialId],
      prfFirstSalt: MSK_PRF_SALT,
      prfSecondSalt: contextualiseLocal(MSK_PRF_SALT),
    })
  /** `masterKey` sealed for this passkey under the PRF the fake returns for `slot`. */
  const seal = (masterKey: Fr, slot: PrfSlot = "first", account = ACCOUNT) =>
    sealMasterKey({
      masterKey: new Uint8Array(masterKey.toBuffer()),
      prfOutput: ceremony.prfFor(credentialId, slot),
      slot,
      account,
      credentialId,
    })
  return { ceremony, credentialId, assert, seal }
}

const open = (
  assertion: Awaited<ReturnType<FakePasskeyCeremony["assert"]>>,
  envelope: Uint8Array,
  account = ACCOUNT,
) => openBackupEnvelope(assertion, { envelope, account, credentialId: assertion.credentialId })

const failure = async (run: Promise<unknown>) => {
  const err = await run.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(PasskeyEnvelopeError)
  return (err as PasskeyEnvelopeError).reason
}

describe("openBackupEnvelope", () => {
  it("refuses an assertion without user verification, or with no readable flags", async () => {
    const { assert, seal } = await passkey({ userVerified: false })
    const envelope = await seal(Fr.random())
    expect(await failure(open(await assert(), envelope))).toBe("unverified")
    const verified = await passkey()
    const assertion = await verified.assert()
    const short = { ...assertion, authenticatorData: new Uint8Array(20) }
    expect(await failure(open(short, await verified.seal(Fr.random())))).toBe("unverified")
  })
})
