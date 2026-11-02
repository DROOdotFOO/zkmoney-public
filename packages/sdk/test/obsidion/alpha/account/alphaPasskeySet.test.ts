/**
 * The TS passkey-set derivation against the vectors pinned in `contracts/alpha/lib/src/keys.nr`
 * and against oxide's own TS, plus the provider-side rules: witness slots, membership, input
 * isolation and the client data JSON cap. No sandbox.
 */
import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
  computePasskeyHash,
  computePasskeySetImmutablesHash,
} from "@oxide/oxide-lib-tee/account_address.js"
import { passkeySetSlots } from "@oxide/oxide-lib/account_address.js"
import {
  alphaPasskeySet,
  lazyPasskeySet,
  MAX_ACCOUNT_PASSKEYS,
  normalizePubkeyHex,
  passkeySetHas,
  pubkeyHexOf,
} from "../../../../src/obsidion/alpha/account/alphaPasskeySet.js"
import { EcdsaK256AlphaAuthProvider } from "../../../../src/obsidion/alpha/auth/EcdsaK256AlphaAuthProvider.js"
import {
  WebAuthnAlphaAuthProvider,
  WITNESS_MAX_CLIENT_DATA_JSON_LEN,
} from "../../../../src/obsidion/alpha/auth/WebAuthnAlphaAuthProvider.js"
import { MAX_WITNESS_LEN, PASSKEY_SET_INDEX } from "../../../../src/utils/constants.js"
import { SoftwareWebauthnKey } from "../../../utils/wallet/softwareWebauthn.js"

// `keys.nr` vectors: key 1 is x[i] = i + 1, y[i] = 0xff - i; key 2 swaps them. Hash 2 sorts first.
const ASCENDING = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("hex")
const DESCENDING = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xff - i)).toString("hex")
const KEY_1 = ASCENDING + DESCENDING
const KEY_2 = DESCENDING + ASCENDING
const PASSKEY_HASH_VECTOR_1 = "0x1fe0fbf8537e7fe1fc8c28921a3b5c8c75452fa4550a27d1234ecd835e492e0f"
const PASSKEY_HASH_VECTOR_2 = "0x0d10652febab90ae0b2cafef1709a23bf1e729fb6b6c31f1e4885bd8c39972a8"
const SET_HASH_VECTOR_ONE_KEY = "0x2b26bbaa93a12de1cf583828e2668c7f889da325cf98385e66390859a1c14d6b"
const SET_HASH_VECTOR_TWO_KEYS =
  "0x081fab49249ef1fd613dd6f790faf2e2e3b4b75387fec57b24b0ca47514582e4"

const CLIENT_DATA_JSON_INDEX = 166
const SLOTS_END = PASSKEY_SET_INDEX + MAX_ACCOUNT_PASSKEYS

const randomKeyHex = () => randomBytes(64).toString("hex")
const randomSigningKey = () => new Fr(Fr.random().toBigInt() % Fr.MODULUS).toBuffer()
const strings = (fields: readonly Fr[]) => fields.map((f) => f.toString())
const allZero = (fields: readonly Fr[]) => fields.every((f) => f.isZero())

describe("alphaPasskeySet", () => {
  it("one-key and two-key sets equal the Noir-pinned vectors", async () => {
    const one = await alphaPasskeySet([KEY_1])
    expect(one.keys).toEqual([KEY_1])
    expect(strings(one.commitments)).toEqual([PASSKEY_HASH_VECTOR_1])
    expect(one.slots).toHaveLength(MAX_ACCOUNT_PASSKEYS)
    expect(one.slots[0]!.toString()).toBe(PASSKEY_HASH_VECTOR_1)
    expect(allZero(one.slots.slice(1))).toBe(true)
    expect(one.immutablesHash.toString()).toBe(SET_HASH_VECTOR_ONE_KEY)

    const two = await alphaPasskeySet([KEY_1, KEY_2])
    expect(two.keys).toEqual([KEY_2, KEY_1])
    expect(strings(two.commitments)).toEqual([PASSKEY_HASH_VECTOR_2, PASSKEY_HASH_VECTOR_1])
    expect(strings(two.slots.slice(0, 2))).toEqual([PASSKEY_HASH_VECTOR_2, PASSKEY_HASH_VECTOR_1])
    expect(allZero(two.slots.slice(2))).toBe(true)
    expect(two.immutablesHash.toString()).toBe(SET_HASH_VECTOR_TWO_KEYS)
  })

  it("agrees with oxide's TS through oxide-lib-tee and oxide-lib", async () => {
    const passkey = (hex: string) => {
      const raw = Buffer.from(hex, "hex")
      return { x: raw.subarray(0, 32), y: raw.subarray(32) }
    }
    const hashes = [
      await computePasskeyHash(passkey(KEY_1)),
      await computePasskeyHash(passkey(KEY_2)),
    ]
    expect(strings(hashes)).toEqual([PASSKEY_HASH_VECTOR_1, PASSKEY_HASH_VECTOR_2])
    const slots = passkeySetSlots(hashes)
    expect((await computePasskeySetImmutablesHash(slots)).toString()).toBe(SET_HASH_VECTOR_TWO_KEYS)
    expect((await computePasskeySetImmutablesHash(passkeySetSlots([hashes[0]!]))).toString()).toBe(
      SET_HASH_VECTOR_ONE_KEY,
    )
  })

  it("is independent of the input order and of key spelling", async () => {
    const reference = await alphaPasskeySet([KEY_1, KEY_2])
    const reordered = await alphaPasskeySet([KEY_2, KEY_1])
    const respelled = await alphaPasskeySet([`0x${KEY_2.toUpperCase()}`, KEY_1.toUpperCase()])
    for (const set of [reordered, respelled]) {
      expect(set.keys).toEqual(reference.keys)
      expect(set.immutablesHash.equals(reference.immutablesHash)).toBe(true)
    }
  })

  it("refuses an empty list, nine keys, a malformed key and a duplicate", async () => {
    await expect(alphaPasskeySet([])).rejects.toThrow(/1 to 8 passkeys, not 0/)
    const nine = Array.from({ length: MAX_ACCOUNT_PASSKEYS + 1 }, randomKeyHex)
    await expect(alphaPasskeySet(nine)).rejects.toThrow(/1 to 8 passkeys, not 9/)
    await expect(alphaPasskeySet(["abcd"])).rejects.toThrow(/64-byte/)
    await expect(alphaPasskeySet([KEY_1, `${KEY_2}00`])).rejects.toThrow(/64-byte/)
    await expect(alphaPasskeySet([KEY_1, KEY_1])).rejects.toThrow(/duplicate/)
    await expect(alphaPasskeySet([KEY_1, `0x${KEY_1.toUpperCase()}`])).rejects.toThrow(/duplicate/)
  })

  it("eight keys fill every slot", async () => {
    const set = await alphaPasskeySet(Array.from({ length: MAX_ACCOUNT_PASSKEYS }, randomKeyHex))
    expect(set.keys).toHaveLength(MAX_ACCOUNT_PASSKEYS)
    expect(set.slots.some((slot) => slot.isZero())).toBe(false)
    const ascending = set.commitments.every(
      (c, i) => i === 0 || c.toBigInt() > set.commitments[i - 1]!.toBigInt(),
    )
    expect(ascending).toBe(true)
  })

  it("passkeySetHas accepts any spelling of a member and nothing else", async () => {
    const set = await alphaPasskeySet([KEY_1])
    expect(passkeySetHas(set, KEY_1)).toBe(true)
    expect(passkeySetHas(set, `0x${KEY_1.toUpperCase()}`)).toBe(true)
    expect(passkeySetHas(set, KEY_2)).toBe(false)
    expect(() => passkeySetHas(set, "abcd")).toThrow(/64-byte/)
  })

  it("shares nothing with its input and is frozen", async () => {
    const input = [KEY_1]
    const set = await alphaPasskeySet(input)
    input[0] = KEY_2
    input.push(KEY_2)
    expect(set.keys).toEqual([KEY_1])
    expect(Object.isFrozen(set)).toBe(true)
    expect(() => (set.keys as string[]).push(KEY_2)).toThrow()
    expect(() => (set.commitments as Fr[]).push(Fr.ZERO)).toThrow()
    expect(() => ((set.slots as Fr[])[0] = Fr.ZERO)).toThrow()
  })

  it("normalizePubkeyHex strips the prefix, lowercases, and refuses short input", () => {
    expect(normalizePubkeyHex(`0x${KEY_1.toUpperCase()}`)).toBe(KEY_1)
    expect(() => normalizePubkeyHex(`${"00".repeat(63)}gg`)).toThrow(/64-byte/)
  })
})

describe("providers carry their passkey set", () => {
  it("lazyPasskeySet shares one computation and retries after a rejection", async () => {
    let calls = 0
    const set = lazyPasskeySet(async () => {
      if (++calls === 1) throw new Error("transient")
      return alphaPasskeySet([KEY_1])
    })
    await expect(set()).rejects.toThrow("transient")
    const first = set()
    expect(set()).toBe(first)
    expect((await first).keys).toEqual([KEY_1])
    expect(calls).toBe(2)
  })

  it("EcdsaK256AlphaAuthProvider: the default set is its own key, written at the slot window", async () => {
    const provider = new EcdsaK256AlphaAuthProvider(randomSigningKey())
    const own = await pubkeyHexOf(provider)
    const set = await provider.getPasskeySet()
    expect(set.keys).toEqual([own])
    expect(await provider.getPasskeySet()).toBe(set)

    const { witness } = await provider.createAuthWit(Fr.random())
    expect(witness).toHaveLength(MAX_WITNESS_LEN)
    expect(strings(witness.slice(PASSKEY_SET_INDEX, SLOTS_END))).toEqual(strings(set.slots))
    expect(allZero(witness.slice(128, PASSKEY_SET_INDEX))).toBe(true)
    expect(allZero(witness.slice(SLOTS_END))).toBe(true)
  })

  it("EcdsaK256AlphaAuthProvider over a two-key set writes both slots", async () => {
    const signingKey = randomSigningKey()
    const own = await pubkeyHexOf(new EcdsaK256AlphaAuthProvider(signingKey))
    const other = randomKeyHex()
    const provider = new EcdsaK256AlphaAuthProvider(signingKey, [other, own])
    const set = await provider.getPasskeySet()
    expect(new Set(set.keys)).toEqual(new Set([own, other]))
    expect(set.slots[1]!.isZero()).toBe(false)
    const { witness } = await provider.createAuthWit(Fr.random())
    expect(strings(witness.slice(PASSKEY_SET_INDEX, SLOTS_END))).toEqual(strings(set.slots))
  })

  it("WebAuthnAlphaAuthProvider writes its slots past the JSON and zero elsewhere", async () => {
    const key = new SoftwareWebauthnKey()
    const other = randomKeyHex()
    const provider = key.provider([key.pubkeyHex, other])
    const set = await provider.getPasskeySet()
    expect(passkeySetHas(set, key.pubkeyHex)).toBe(true)
    expect(passkeySetHas(set, other)).toBe(true)

    const { witness } = await provider.createAuthWit(Fr.random())
    const jsonLen = Number(witness[165]!.toBigInt())
    expect(jsonLen).toBeGreaterThan(0)
    expect(allZero(witness.slice(CLIENT_DATA_JSON_INDEX + jsonLen, PASSKEY_SET_INDEX))).toBe(true)
    expect(strings(witness.slice(PASSKEY_SET_INDEX, SLOTS_END))).toEqual(strings(set.slots))
    expect(allZero(witness.slice(SLOTS_END))).toBe(true)
  })

  it("a provider whose own key is not in its set rejects at getPasskeySet() and createAuthWit()", async () => {
    const foreign = [randomKeyHex(), randomKeyHex()]
    const webauthn = new SoftwareWebauthnKey().provider(foreign)
    await expect(webauthn.getPasskeySet()).rejects.toThrow(/not in its passkey set/)
    await expect(webauthn.createAuthWit(Fr.random())).rejects.toThrow(/not in its passkey set/)
    const ecdsa = new EcdsaK256AlphaAuthProvider(randomSigningKey(), foreign)
    await expect(ecdsa.getPasskeySet()).rejects.toThrow(/not in its passkey set/)
    await expect(ecdsa.createAuthWit(Fr.random())).rejects.toThrow(/not in its passkey set/)
  })

  it("mutating the list a provider was built with changes nothing", async () => {
    const key = new SoftwareWebauthnKey()
    const other = randomKeyHex()
    const list = [key.pubkeyHex, other]
    const provider = key.provider(list)
    list.length = 0
    const set = await provider.getPasskeySet()
    expect(new Set(set.keys)).toEqual(new Set([key.pubkeyHex, other]))
  })

  it("hands createAuthWit's signal to the signer", async () => {
    const key = new SoftwareWebauthnKey()
    const seen: (AbortSignal | undefined)[] = []
    const provider = new WebAuthnAlphaAuthProvider(key.pubkeyX, key.pubkeyY, async (c, opts) => {
      seen.push(opts?.signal)
      return key.sign(c)
    })
    const { signal } = new AbortController()
    await provider.createAuthWit(Fr.random(), { signal })
    await provider.createAuthWit(Fr.random())
    expect(seen).toEqual([signal, undefined])
  })

  it("signs a 319-byte client data JSON and refuses a 320-byte one", async () => {
    const key = new SoftwareWebauthnKey()
    const withJsonOf = (length: number) =>
      new WebAuthnAlphaAuthProvider(key.pubkeyX, key.pubkeyY, async (c) => ({
        ...(await key.sign(c)),
        clientDataJSON: new Uint8Array(length).fill(0x20),
      }))
    expect(WITNESS_MAX_CLIENT_DATA_JSON_LEN).toBe(319)
    const { witness } = await withJsonOf(319).createAuthWit(Fr.random())
    expect(Number(witness[165]!.toBigInt())).toBe(319)
    expect(witness[CLIENT_DATA_JSON_INDEX + 318]!.isZero()).toBe(false)
    expect(witness[PASSKEY_SET_INDEX]!.isZero()).toBe(false)
    await expect(withJsonOf(320).createAuthWit(Fr.random())).rejects.toThrow(/at most 319/)
  })
})
