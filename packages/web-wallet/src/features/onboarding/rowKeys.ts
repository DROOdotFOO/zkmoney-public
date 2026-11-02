import { useRef, useState } from "react"
import { installedCredentials } from "@obsidion/front-core"
import { type AccountKey, type SignInKeyChoice, signInKeyChoices } from "@obsidion/passkey-web"
import type { AccountPasskeys } from "../../platform/auth/WebAlphaAuthService"
import {
  type RememberedAccount,
  type WalletKey,
  authenticatorFor,
  walletKeysFor,
} from "../../platform/auth/WebPasskeyIdentityMap"
import { resolveSignInTag } from "../contacts/registryResolution"
import { lookupPasskeyByTag } from "./findPasskeyByTag"
import type { SignInHints } from "./oxideOnboarding"
import type { RowKeys } from "./steps/ConfirmTagModal"

/** What a tap pins the sign-in to: the tag's account and keys as L1 lists them, or a remembered credential. */
export type Found = {
  tag: string
  l2Address: string
  hints: SignInHints
  /** The L1 read found keys beyond the first; unset on a remembered account, which had no read. */
  moreKeys?: boolean
  /** The account's keys to choose between before any prompt; unset for a one-key account. */
  keys?: KeyOption[]
}

/** One key a sign-in may be pinned to, and the sign-in that names it alone. */
export type KeyOption = SignInKeyChoice & { target: Found }

/** A tag's account as its L1 read found it. */
export type AccountFound = Found & { hints: AccountPasskeys }

/** A sign-in pinned to a credential this browser holds an opening record for. */
const recordTarget = (
  { tag, l2Address }: Pick<Found, "tag" | "l2Address">,
  credentialId: string,
): Found => ({ tag, l2Address, hints: { credentialId, chosen: true } })

/**
 * The choice among the keys a tag's read lists; none for a one-key account. Each option names only
 * its own credential, still matched against every key; on a remembered row, a key this browser
 * holds an opening record for is pinned by that record instead.
 */
export function keyOptions(
  found: AccountFound,
  recorded?: readonly AccountKey[],
): KeyOption[] | undefined {
  const installed = installedCredentials(found.hints.keys)
  const choices = signInKeyChoices(
    installed.map(({ credentialId, backup, key }) => {
      const known = authenticatorFor(key.pubkeyHex)
      return { credentialId, backup, aaguid: known?.prfAaguid, usedAt: known?.usedAt }
    }),
  )
  return choices?.map((choice) => {
    const { credentialId } = choice
    const target = recorded?.some((r) => r.credentialId === credentialId)
      ? recordTarget(found, credentialId)
      : { ...found, keys: undefined, hints: { ...found.hints, chosen: credentialId } }
    return { ...choice, target }
  })
}

/**
 * One row per wallet: records of one address list once, by the record naming the most keys and,
 * on a tie, the sign-up key's, so the row offers every key this browser knows for it.
 */
export function oneRowPerWallet(
  rows: RememberedAccount[],
  keyCount: (row: RememberedAccount) => number,
): RememberedAccount[] {
  const kept = new Map<string, { row: RememberedAccount; keys: number }>()
  for (const row of rows) {
    const address = row.l2Address.toLowerCase()
    const keys = keyCount(row)
    const held = kept.get(address)
    if (!held || keys > held.keys || (keys === held.keys && held.row.backup && !row.backup)) {
      kept.set(address, { row, keys })
    }
  }
  return rows.filter((row) => kept.get(row.l2Address.toLowerCase())?.row === row)
}

/** A remembered row's keys as the screen holds them, each option with its sign-in. */
type RowChoice = Omit<RowKeys, "credentialId" | "choices"> & {
  account: RememberedAccount
  options: KeyOption[]
}

/**
 * The selected remembered row's keys, shown in place of Login. Records this browser holds name them
 * at once; a key it holds none for is found by reading the row's tag, so its option pins the tag's
 * account. Only the latest read lands.
 */
export function useRowKeys(rpId: string) {
  const [choice, setChoice] = useState<RowChoice>()
  const gen = useRef(0)

  const open = (account: RememberedAccount, keys: WalletKey[]) => {
    const mine = ++gen.current
    const row = { tag: account.usertag, l2Address: account.l2Address }
    const recorded = keys.flatMap((k) => (k.record ? [k.record] : []))
    if (recorded.length === keys.length) {
      const options = (signInKeyChoices(recorded) ?? []).map((c) => ({
        ...c,
        target: recordTarget(row, c.credentialId),
      }))
      setChoice({ account, options })
      return
    }
    const failed = () => mine === gen.current && setChoice({ account, options: [], failed: true })
    setChoice({ account, options: [], reading: true })
    void lookupPasskeyByTag(account.usertag, { resolveTag: resolveSignInTag }).then((read) => {
      if (mine !== gen.current) return
      if (read.kind !== "resolved") return failed()
      const options = keyOptions(
        {
          ...row,
          l2Address: read.l2Address,
          hints: { account: read.account, l2Address: read.l2Address, keys: read.keys },
          moreKeys: read.moreKeys,
        },
        recorded,
      )
      if (!options) return failed()
      setChoice({ account, options })
    }, failed)
  }

  const close = () => {
    gen.current++
    setChoice(undefined)
  }

  const again = () => {
    if (!choice) return
    const keys = walletKeysFor(rpId, choice.account.credentialId)
    if (keys && keys.length > 1) open(choice.account, keys)
  }

  const rowKeys: RowKeys | undefined = choice && {
    credentialId: choice.account.credentialId,
    choices: choice.options,
    reading: choice.reading,
    failed: choice.failed,
  }

  return {
    /** The selected row's account, when one is selected. */
    selected: choice?.account,
    rowKeys,
    open,
    close,
    again,
    optionFor: (credentialId: string) =>
      choice?.options.find((o) => o.credentialId === credentialId),
  }
}
