// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  ObsidionAccount,
  WebAuthnAlphaAuthProvider,
  type AlphaAuthProvider,
  type ObsidionWallet,
} from "@obsidion/sdk"

vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => {
    throw new Error("the session resolver is not under test")
  },
}))

const { singleKeyAccount, sponsorAccounts } = await import(
  "../../../src/features/onboarding/sponsorAccounts"
)
const { SessionChangedError } = await import("../../../src/platform/auth/sessionErrors")
type Deps = Parameters<typeof sponsorAccounts>[0]
type Session = Deps["session"]

const KEY_A = "aa".repeat(64)
const KEY_B = "bb".repeat(64)
const ADDRESS_OF: Record<string, string> = { [KEY_A]: "0xa", [KEY_B]: "0xb" }
const TWO_KEY = "0xab"
const FPC = "0x" + "0f".repeat(32)
const sponsor = { fpcAddress: { toString: () => FPC } } as never

const address = (s: string) => ({ toString: () => s })
const account = (at: string): ObsidionAccount =>
  Object.assign(Object.create(ObsidionAccount.prototype), { getAddress: () => address(at) })
const provider = (key: string): AlphaAuthProvider =>
  ({
    getPubkeys: async () => [
      Buffer.from(key.slice(0, 64), "hex"),
      Buffer.from(key.slice(64), "hex"),
    ],
  } as never)

const record = (over: Record<string, unknown> = {}) => ({
  credentialId: "cred-a",
  l2Address: TWO_KEY,
  pubkey: KEY_A,
  isMskRoot: true,
  createdAt: 1,
  passkeySet: [KEY_A, KEY_B],
  ...over,
})

interface Harness {
  deps: Deps
  acting: ObsidionAccount
  created: AlphaAuthProvider[]
  providerFor: ReturnType<typeof vi.fn>
  recordFeePayer: ReturnType<typeof vi.fn>
  holdsSubscription: ReturnType<typeof vi.fn>
  /** Switches the session to `key`'s signer. */
  signInWith(key: string): void
  /** The signer the wallet's account at `at` signs with now. */
  signerOf(at: string): AlphaAuthProvider | undefined
  /** Holds the next wallet lookup of a held account until it resolves. */
  holdLookup(gate: Promise<void>): void
  /** Holds the next account registration until it resolves. */
  holdRegistration(gate: Promise<void>): void
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function harness(opts: {
  record?: ReturnType<typeof record>
  sessionKey?: string | null
  held?: string[]
  subscribed?: string[]
}): Harness {
  const held = new Map((opts.held ?? []).map((at) => [at, account(at)]))
  // One account per address; the registration that finishes last installs its signer.
  const signers = new Map<string, AlphaAuthProvider>()
  const created: AlphaAuthProvider[] = []
  const providerFor = vi.fn((p: { pubkeyHex: string }) => provider(p.pubkeyHex))
  const recordFeePayer = vi.fn(async () => {})
  const holdsSubscription = vi.fn(async (a: ObsidionAccount) =>
    (opts.subscribed ?? []).includes(a.getAddress().toString()),
  )
  let sessionSigner = opts.sessionKey === null ? undefined : provider(opts.sessionKey ?? KEY_A)
  let lookupGate: Promise<void> | undefined
  let registrationGate: Promise<void> | undefined
  const session: Session = {
    accountRecord: async () => opts.record as never,
    sessionKeys: async () =>
      sessionSigner && ({ secretKey: "msk", authProvider: sessionSigner } as never),
    providerFor,
    recordFeePayer,
  }
  const wallet = {
    deriveAccountAddress: async (_: unknown, keys: string[]) => address(ADDRESS_OF[keys[0]!]!),
    getAccountFromAddress: async (at: { toString(): string }) => {
      const gate = lookupGate
      lookupGate = undefined
      await gate
      const found = held.get(at.toString())
      if (!found) throw new Error("Account not found")
      return found
    },
    createObsidionAccount: async (_: unknown, p: AlphaAuthProvider) => {
      created.push(p)
      const gate = registrationGate
      registrationGate = undefined
      await gate
      const [x, y] = await p.getPubkeys()
      const at = ADDRESS_OF[Buffer.concat([x, y]).toString("hex")]!
      const made = held.get(at) ?? account(at)
      held.set(at, made)
      signers.set(at, p)
      return made
    },
  } as never
  const acting = account(TWO_KEY)
  return {
    deps: { wallet, session, holdsSubscription },
    acting,
    created,
    providerFor,
    recordFeePayer,
    holdsSubscription,
    signInWith: (key) => (sessionSigner = provider(key)),
    signerOf: (at) => signers.get(at),
    holdLookup: (gate) => (lookupGate = gate),
    holdRegistration: (gate) => (registrationGate = gate),
  }
}

const backupRecord = () =>
  record({
    credentialId: "cred-b",
    pubkey: KEY_B,
    isMskRoot: false,
    backup: { envelopeHex: "01".repeat(62) },
  })

/** Whether a signer is one the auth service built to sign, not one that refuses. */
const signsWith = (h: Harness, signer: AlphaAuthProvider | undefined) =>
  !!signer && h.providerFor.mock.results.some((result) => result.value === signer)

const payerOf = async (h: Harness) => (await sponsorAccounts(h.deps, h.acting, sponsor)).payer

describe("sponsorAccounts", () => {
  it("lets the acting account pay when this browser holds no record for it", async () => {
    const h = harness({ record: undefined })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).not.toHaveBeenCalled()
  })

  it("takes an entry naming the acting account without a chain read", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: TWO_KEY, passkey: KEY_A } } }),
    })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).not.toHaveBeenCalled()
  })

  it("registers the payer with the session's own signer when the session signs with its key", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      sessionKey: KEY_A,
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.providerFor).toHaveBeenCalledWith({
      credentialId: "cred-a",
      pubkeyHex: KEY_A,
      passkeys: [KEY_A],
    })
    expect(h.created).toEqual([h.providerFor.mock.results[0]!.value])
  })

  it("registers the payer with a signer that refuses when the session signs with another key", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      sessionKey: KEY_B,
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.providerFor).not.toHaveBeenCalled()
    const [silent] = h.created as WebAuthnAlphaAuthProvider[]
    expect(silent).toBeInstanceOf(WebAuthnAlphaAuthProvider)
    const [x, y] = await silent!.getPubkeys()
    expect(Buffer.concat([x, y]).toString("hex")).toBe(KEY_A)
    await expect(silent!.signChallenge(Buffer.alloc(32))).rejects.toThrow("cannot sign")
  })

  it("refuses an entry whose key no longer derives the account it names", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xelse", passkey: KEY_A } } }),
    })
    await expect(payerOf(h)).rejects.toThrow("does not derive")
  })

  it("needs the unlocked wallet to register the payer", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      sessionKey: null,
    })
    await expect(payerOf(h)).rejects.toThrow("locked")
  })

  it("lets a one-key account pay itself without probing", async () => {
    const h = harness({ record: record({ passkeySet: undefined }) })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).not.toHaveBeenCalled()
  })

  it("discovers the payer on a device that opened the account with the backup passkey, and writes it on the backup's record", async () => {
    const h = harness({
      record: record({
        credentialId: "cred-b",
        pubkey: KEY_B,
        isMskRoot: false,
        backup: { envelopeHex: "01".repeat(62) },
      }),
      sessionKey: KEY_B,
      subscribed: ["0xa"],
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.recordFeePayer).toHaveBeenCalledWith("cred-b", FPC, { address: "0xa", passkey: KEY_A })
    expect(h.providerFor).not.toHaveBeenCalled()
    const [silent] = h.created as WebAuthnAlphaAuthProvider[]
    expect(h.created).toHaveLength(1)
    await expect(silent!.signChallenge(Buffer.alloc(32))).rejects.toThrow("cannot sign")
  })

  it("lets the acting account pay when no single-key account subscribed, and writes nothing", async () => {
    const h = harness({ record: record() })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).toHaveBeenCalledTimes(3)
    expect(h.recordFeePayer).not.toHaveBeenCalled()
  })
})

describe("singleKeyAccount", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it("registers with the session's own signer when asked to sign, replacing a refusing one an earlier session left", async () => {
    const h = harness({ sessionKey: KEY_B })
    await singleKeyAccount(h.deps, backupRecord(), KEY_A)
    expect(signsWith(h, h.signerOf("0xa"))).toBe(false)

    h.signInWith(KEY_A)
    const account = await singleKeyAccount(h.deps, record(), KEY_A, "sign")

    expect(account.getAddress().toString()).toBe("0xa")
    expect(signsWith(h, h.signerOf("0xa"))).toBe(true)
    expect(h.created).toHaveLength(2)
  })

  it("refuses to sign for a key the session does not sign with, and registers nothing", async () => {
    const h = harness({ sessionKey: KEY_B })
    await expect(singleKeyAccount(h.deps, backupRecord(), KEY_A, "sign")).rejects.toThrow(
      "cannot sign",
    )
    expect(h.created).toHaveLength(0)
  })

  it("drops a backup session's registration that resumes after a root session took over", async () => {
    const h = harness({ sessionKey: KEY_B })
    const lookup = deferred()
    h.holdLookup(lookup.promise)
    const late = singleKeyAccount(h.deps, backupRecord(), KEY_A)
    await settle()

    h.signInWith(KEY_A)
    const root = singleKeyAccount(h.deps, record(), KEY_A, "sign")
    lookup.resolve()

    await expect(late).rejects.toBeInstanceOf(SessionChangedError)
    await root
    expect(h.created).toHaveLength(1)
    expect(signsWith(h, h.signerOf("0xa"))).toBe(true)
  })

  it("holds a root session's registration until one already registering lands, so the root's signer is the one left", async () => {
    const h = harness({ sessionKey: KEY_B })
    const registering = deferred()
    h.holdRegistration(registering.promise)
    const early = singleKeyAccount(h.deps, backupRecord(), KEY_A)
    await settle()

    h.signInWith(KEY_A)
    const root = singleKeyAccount(h.deps, record(), KEY_A, "sign")
    await settle()
    expect(h.created).toHaveLength(1)

    registering.resolve()
    await early
    await root
    expect(h.created).toHaveLength(2)
    expect(signsWith(h, h.signerOf("0xa"))).toBe(true)
  })

  it("drops a fee payer discovery that resumes after a root session took over, and writes nothing", async () => {
    const h = harness({ record: backupRecord(), sessionKey: KEY_B, subscribed: ["0xa"] })
    const lookup = deferred()
    h.holdLookup(lookup.promise)
    const discovery = payerOf(h)
    await settle()

    h.signInWith(KEY_A)
    const root = singleKeyAccount(h.deps, record(), KEY_A, "sign")
    lookup.resolve()

    await expect(discovery).rejects.toBeInstanceOf(SessionChangedError)
    await root
    expect(signsWith(h, h.signerOf("0xa"))).toBe(true)
    expect(h.recordFeePayer).not.toHaveBeenCalled()
  })

  it("leaves a signing signer whether the rotation's own registration of the account runs before or after", async () => {
    for (const rotationFirst of [true, false]) {
      const h = harness({ sessionKey: KEY_A })
      // The rotation registers the one-key account with the root passkey's provider directly.
      const rotation = () =>
        (h.deps.wallet as never as ObsidionWallet).createObsidionAccount(
          "msk" as never,
          h.deps.session.providerFor({
            credentialId: "cred-a",
            pubkeyHex: KEY_A,
            passkeys: [KEY_A],
          }),
        )
      const step = () => singleKeyAccount(h.deps, record(), KEY_A, "sign")
      if (rotationFirst) {
        await rotation()
        await step()
      } else {
        await step()
        await rotation()
      }
      expect(signsWith(h, h.signerOf("0xa"))).toBe(true)
    }
  })
})
