import { isAddress, type Address } from "viem"

import { logger } from "../../utils/logger"
import { isZeroAddress } from "../../utils/validate"

import { ContactStorage, L1_PLACEHOLDER_NAME, isUserLabel, type Contact } from "./ContactStorage.js"
import { lookupEnsName, type GetEnsClient } from "../services/ens"

const UNKNOWN_PROVIDER = "unknown"

export interface UpsertDepositL1WalletContactParams {
  address: string
  walletId?: string | null
  walletName?: string | null
  walletImageUrl?: string | null
  walletProvider?: string | null
  lastUsedAt?: number
}

/**
 * Persist the on-chain funder as a deposit-attested L1 contact. A token mint reports the zero
 * address — skip it, it is not a wallet.
 */
export async function upsertDepositL1WalletContact({
  address,
  walletId,
  walletName,
  walletImageUrl,
  walletProvider,
  lastUsedAt,
}: UpsertDepositL1WalletContactParams): Promise<void> {
  if (!isAddress(address) || isZeroAddress(address)) return

  const provider = walletProvider?.trim() || UNKNOWN_PROVIDER
  const displayName = walletName?.trim() || L1_PLACEHOLDER_NAME
  const imageUrl = walletImageUrl ?? undefined

  try {
    await ContactStorage.get().upsertL1WalletContact({
      name: displayName,
      address: address as Address,
      provider,
      walletId: walletId ?? undefined,
      walletName: displayName,
      imageUrl,
      provenance: "deposit-attested",
      avatar: imageUrl ? { type: "image", url: imageUrl } : undefined,
      lastUsedAt,
    })
  } catch (err) {
    logger.warn("[L1WalletContacts] Failed to upsert deposit contact:", err)
  }
}

export interface UpsertSavedL1WalletContactParams {
  address: string
  name?: string | null
  /** A real slug keeps the row apart from user-typed recipients; defaults to `"manual"`. */
  provider?: string
  lastUsedAt?: number
}

/** Persist a withdrawal recipient so it reappears as an L1 contact. */
export async function upsertSavedL1WalletContact({
  address,
  name,
  provider = "manual",
  lastUsedAt,
}: UpsertSavedL1WalletContactParams): Promise<void> {
  if (!isAddress(address) || isZeroAddress(address)) return

  const labeled = isUserLabel(name)
  const displayName = labeled ? name!.trim() : L1_PLACEHOLDER_NAME

  try {
    await ContactStorage.get().upsertL1WalletContact({
      name: displayName,
      address: address as Address,
      provider,
      walletName: displayName,
      provenance: "saved-recipient",
      userLabeled: labeled || undefined,
      lastUsedAt: lastUsedAt ?? Date.now(),
    })
  } catch (err) {
    logger.warn("[L1WalletContacts] Failed to upsert saved recipient:", err)
  }
}

const unnamedL1 = (entry: Contact): boolean =>
  !!entry.l1Wallet && !entry.l1Wallet.deletedAt && !isUserLabel(entry.name)

/**
 * Names each unlabeled L1 contact (stored as the placeholder, so shown by its address) after its
 * ENS primary name, now and after every contacts change. A label the user typed is never replaced.
 * Returns the unsubscribe.
 */
export function nameL1ContactsByEns(getClient: GetEnsClient): () => void {
  const storage = ContactStorage.get()
  const run = () => {
    void storage
      .getEntries()
      .then((entries) =>
        Promise.all(
          entries.filter(unnamedL1).map(async ({ address, l1Wallet }) => {
            const name = await lookupEnsName(getClient, address as Address)
            if (!name) return
            await storage.nameUnlabeledL1Contact({ address, provider: l1Wallet!.provider }, name)
          }),
        ),
      )
      .catch((err) => logger.warn("[L1WalletContacts] Failed to name contacts by ENS:", err))
  }
  run()
  return storage.onChange(run)
}

export interface UpdateSavedL1WalletContactParams {
  /** Identity of the row being edited. */
  originalAddress: string
  provider: string
  /** New values. An empty/placeholder name clears back to "External Wallet". */
  address: string
  name?: string | null
}

/**
 * User edit of an L1 wallet row (label and/or address). ContactStorage records
 * replaced addresses so the old address stops surfacing under "Recent", and
 * creates a saved-recipient row when the edited row was deposit-history-only.
 * Unlike the upsert helpers this THROWS on failure (invalid address, address
 * collision) so the caller can surface the error.
 */
export async function updateSavedL1WalletContact({
  originalAddress,
  provider,
  address,
  name,
}: UpdateSavedL1WalletContactParams): Promise<Contact> {
  if (!isAddress(address) || isZeroAddress(address)) {
    throw new Error("Invalid address")
  }
  return ContactStorage.get().updateL1WalletContact({
    originalAddress,
    provider,
    address,
    name: name ?? "",
  })
}
