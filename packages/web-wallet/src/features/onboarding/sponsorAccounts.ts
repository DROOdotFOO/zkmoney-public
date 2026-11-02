/**
 * Which account's subscription note pays for the session's sponsored batches on one ClaimFPC
 * instance: front-core's fee-payer rule over this browser's record of the account, the session's
 * signer and the PXE. A rotated wallet keeps paying through its previous account where that account
 * subscribed, on a device that opened it with the backup passkey too; a wallet that never rotated
 * pays with its own note and sees no change.
 */
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { discoverFeePayer, feePayerEntry, type FeePayerEntry } from "@obsidion/front-core"
import {
  normalizePubkeyHex,
  ObsidionAccount,
  pubkeyHexOf,
  WebAuthnAlphaAuthProvider,
  type AlphaAuthProvider,
  type ClaimSponsorContext,
  type ObsidionWallet,
  type RecoveryMetadata,
} from "@obsidion/sdk"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import {
  holdsSubscription,
  type SponsorAccounts,
  type SponsorAccountsResolver,
} from "./claimSponsorship"

/** What the rule reads and writes on this browser. */
export interface SponsorSession {
  /** The record this browser opens `l2Address` with: its root credential's, else a backup's. */
  accountRecord(l2Address: string): Promise<RecoveryMetadata | undefined>
  sessionKeys(): Promise<{ secretKey: Fr; authProvider: AlphaAuthProvider } | undefined>
  providerFor(passkey: {
    credentialId: string
    pubkeyHex: string
    passkeys: readonly string[]
  }): AlphaAuthProvider
  recordFeePayer(credentialId: string, fpc: string, payer: FeePayerEntry): Promise<void>
}

export interface SponsorAccountsDeps {
  wallet: ObsidionWallet
  session: SponsorSession
  /** Whether `account` holds the rail's note on the instance. */
  holdsSubscription(account: ObsidionAccount): Promise<boolean>
}

const sameKey = (a: string, b: string) => normalizePubkeyHex(a) === normalizePubkeyHex(b)

/**
 * The payer for `acting`'s batches on `sponsor`'s instance. The account record's entry for the
 * instance names it; a two-key record with no entry discovers it among the single-key accounts of
 * its set, and writes what it finds. An account the step needs that the wallet does not hold is
 * registered by its exact address: with the session's own signer when the session signs with its
 * key, else with one that never signs. The acting account pays itself in every other case.
 */
export async function sponsorAccounts(
  deps: SponsorAccountsDeps,
  acting: ObsidionAccount,
  sponsor: ClaimSponsorContext,
): Promise<SponsorAccounts> {
  const self = { payer: acting, acting }
  const record = await deps.session.accountRecord(acting.getAddress().toString())
  if (!record) return self
  const fpc = sponsor.fpcAddress.toString()
  const entry = feePayerEntry(record, fpc)
  if (entry) {
    if (sameAddress(entry.address, acting.getAddress())) return self
    return { payer: await payerAccount(deps, record, entry), acting }
  }
  const keys = record.passkeySet ?? [record.pubkey]
  if (keys.length < 2 || (await deps.holdsSubscription(acting))) return self
  const found = await discoverFeePayer(keys, async (passkey) => {
    const account = await singleKeyAccount(deps, record, passkey)
    return {
      address: account.getAddress().toString(),
      subscribed: await deps.holdsSubscription(account),
    }
  })
  if (!found) return self
  await deps.session.recordFeePayer(record.credentialId, fpc, found)
  return { payer: await payerAccount(deps, record, found), acting }
}

const sameAddress = (a: string, b: AztecAddress) => a.toLowerCase() === b.toString().toLowerCase()

/** The account an entry names, refused when its key no longer derives that address. */
async function payerAccount(
  deps: SponsorAccountsDeps,
  record: RecoveryMetadata,
  entry: FeePayerEntry,
): Promise<ObsidionAccount> {
  const account = await singleKeyAccount(deps, record, entry.passkey)
  if (!sameAddress(entry.address, account.getAddress())) {
    throw new Error("the fee payer's key does not derive the account it names")
  }
  return account
}

/** Registrations of one address, per wallet: each starts once the one before it settled. */
const registrations = new WeakMap<ObsidionWallet, Map<string, Promise<unknown>>>()

function oneAtATime<T>(wallet: ObsidionWallet, address: string, run: () => Promise<T>): Promise<T> {
  const byAddress = registrations.get(wallet) ?? new Map<string, Promise<unknown>>()
  registrations.set(wallet, byAddress)
  const key = address.toLowerCase()
  const next = (byAddress.get(key) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => {})
  byAddress.set(key, settled)
  void settled.then(() => byAddress.get(key) === settled && byAddress.delete(key))
  return next
}

/**
 * The single-key account of `passkey`, registered one at a time per address. `held` takes the
 * account the wallet holds, else registers it with `providerOver`'s signer; `sign` registers it
 * with the session's own signer every time, so a refusing one an earlier session left is replaced.
 * A registration whose session signer changed on the way throws `SessionChangedError`, so it never
 * lands after a newer session's.
 */
export async function singleKeyAccount(
  deps: Pick<SponsorAccountsDeps, "wallet" | "session">,
  record: RecoveryMetadata,
  passkey: string,
  mode: "held" | "sign" = "held",
): Promise<ObsidionAccount> {
  const keys = await deps.session.sessionKeys()
  if (!keys) throw new Error("wallet is locked — cannot resolve the fee payer")
  const address = await deps.wallet.deriveAccountAddress(keys.secretKey, [passkey])
  return oneAtATime(deps.wallet, address.toString(), async () => {
    if (mode === "held") {
      const held = await heldAccount(deps.wallet, address)
      if (held) return held
    }
    const signs = await signsFor(keys.authProvider, record, passkey)
    if (mode === "sign" && !signs) throw new Error("this session's passkey cannot sign for it")
    const provider = providerOver(deps.session, record, passkey, signs)
    if ((await deps.session.sessionKeys())?.authProvider !== keys.authProvider) {
      throw new SessionChangedError()
    }
    return deps.wallet.createObsidionAccount(keys.secretKey, provider)
  })
}

async function heldAccount(
  wallet: ObsidionWallet,
  address: AztecAddress,
): Promise<ObsidionAccount | undefined> {
  try {
    const account = await wallet.getAccountFromAddress(address)
    return account instanceof ObsidionAccount ? account : undefined
  } catch {
    return undefined
  }
}

/** Whether the session signs for `passkey`'s account: the record's key and its own are that key. */
async function signsFor(
  sessionProvider: AlphaAuthProvider,
  record: RecoveryMetadata,
  passkey: string,
): Promise<boolean> {
  return sameKey(record.pubkey, passkey) && sameKey(await pubkeyHexOf(sessionProvider), passkey)
}

/**
 * The signer of the single-key account of `passkey`: the session's own passkey when the session
 * signs with that key, else one that refuses to sign, since the account can only read and nullify
 * with the master key.
 */
function providerOver(
  session: SponsorSession,
  record: RecoveryMetadata,
  passkey: string,
  signs: boolean,
): AlphaAuthProvider {
  if (signs) {
    return session.providerFor({
      credentialId: record.credentialId,
      pubkeyHex: passkey,
      passkeys: [passkey],
    })
  }
  const bytes = Buffer.from(normalizePubkeyHex(passkey), "hex")
  return new WebAuthnAlphaAuthProvider(
    bytes.subarray(0, 32),
    bytes.subarray(32, 64),
    () => Promise.reject(new Error("this session's passkey cannot sign for the fee payer")),
    [passkey],
  )
}

/** The resolver the wallet installs: this browser's auth service over the context's own note read. */
export const sessionSponsorAccounts: SponsorAccountsResolver = (deps, sponsor) =>
  sponsorAccounts(
    {
      wallet: deps.wallet,
      session: getAuthService(),
      holdsSubscription: (account) => holdsSubscription(deps.wallet, sponsor, account),
    },
    deps.account,
    sponsor,
  )
