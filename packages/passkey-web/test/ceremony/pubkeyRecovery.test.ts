import { describe, expect, it } from "vitest"
import { bytesToHex } from "../../src/ceremony/bytes.js"
import { candidatePubkeys, recoverPubkeyFromAssertions } from "../../src/ceremony/pubkeyRecovery.js"
import { FakePasskeyCeremony } from "../support/fakePasskeyCeremony.js"

const assertion = (ceremony: FakePasskeyCeremony, credentialId: string, seed: number) =>
  ceremony.assert({
    rpId: "localhost",
    challenge: new Uint8Array(32).fill(seed),
    credentialIds: [credentialId],
  })

const request = {
  rpId: "localhost",
  rpName: "zk.money",
  userName: "@alice",
  prfFirstSalt: new Uint8Array(32),
}

describe("public-key recovery", () => {
  it("recovers the created key from two assertions over different payloads", async () => {
    const ceremony = new FakePasskeyCeremony()
    const created = await ceremony.create(request)
    const first = await assertion(ceremony, created.credentialId, 1)
    const second = await assertion(ceremony, created.credentialId, 2)
    expect(await candidatePubkeys(first)).toContain(bytesToHex(created.pubkey))
    expect(bytesToHex(await recoverPubkeyFromAssertions(first, second))).toBe(
      bytesToHex(created.pubkey),
    )
  })

  it("refuses two assertions from different credentials", async () => {
    const a = new FakePasskeyCeremony()
    const b = new FakePasskeyCeremony()
    const first = await assertion(a, (await a.create(request)).credentialId, 1)
    const second = await assertion(b, (await b.create(request)).credentialId, 2)
    await expect(recoverPubkeyFromAssertions(first, second)).rejects.toThrow(/ambiguous/)
  })
})
