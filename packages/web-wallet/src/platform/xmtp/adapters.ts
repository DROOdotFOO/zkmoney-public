/**
 * Web implementations of the front-core receiver ports (stage-3 inbox): sender-tag resolution over
 * the Registry (always a fresh manifest — the contact cache never vouches for a sender) and
 * store writes over the web stores (requests, ContactStorage). Transfer receive is
 * chain-native (the `transferScan` task), not an XMTP port.
 */

import {
  approvedContactTags,
  contactRowFromEntry,
  incomingRequestToRow,
  isPaymentContactEntry,
  type Contact,
  type ContactsByL2,
  type IncomingRequestInput,
  type RequestSenderPolicy,
  type Requests,
  type RequestStoreWrites,
  type RequestTagBindingResolver,
} from "@obsidion/front-core"
import { verifyTag } from "../../features/contacts/registryResolution"

/**
 * Contact lookup + auto-add for transfer attribution. `registerL2`: a first-time
 * verified sender (tag registry-resolved and proven against the on-chain event) is added to the
 * contact book via the idempotent `addOrMergeContact` — an existing colliding row wins unchanged,
 * EXCEPT a `pending-handshake` row, which that method replaces outright. This path skips those, so
 * an unsolicited transfer can never finish a handshake the user is still waiting on. The row is
 * `autoAdded`: a transfer does not make the sender a contact who may send requests.
 */
export function createContactsByL2(contacts: {
  getEntries(): Promise<Contact[]>
  addOrMergeContact(entry: Contact): Promise<Contact>
}): ContactsByL2 {
  return {
    async findByL2Address(addr: string): Promise<{ tag: string } | null> {
      try {
        const needle = addr.toLowerCase()
        const match = (await contacts.getEntries()).find(
          (e) =>
            e.tag &&
            (e.addressKind ?? "aztec-l2") === "aztec-l2" &&
            e.address.toLowerCase() === needle,
        )
        return match?.tag ? { tag: match.tag } : null
      } catch {
        return null
      }
    },
    async registerL2({ tag, l2Address }: { tag: string; l2Address: string }): Promise<void> {
      // A stranger who claims a tag the user is mid-handshake with could otherwise take over that
      // contact by sending dust: the merge REPLACES a pending row on a tag/name collision.
      const needle = tag.toLowerCase()
      const entries = await contacts.getEntries().catch(() => [] as Contact[])
      const collidesWithPending = entries.some(
        (e) =>
          (e.addressKind as string | undefined) === "pending-handshake" &&
          ((e.tag ?? "").toLowerCase() === needle || (e.name ?? "").toLowerCase() === needle),
      )
      if (collidesWithPending) return

      await contacts.addOrMergeContact({
        name: tag,
        address: l2Address,
        addressKind: "aztec-l2",
        tag,
        verified: true,
        autoAdded: true,
      })
    },
  }
}

/**
 * Sender lookup for the request receiver: a tag's Registry bootstrap address, always over a fresh
 * manifest. Tag not resolvable → null (skip); transport throw propagates so the receiver defers.
 */
export function createRequestBindingResolver(
  verify: (tag: string) => Promise<{ xmtpAddress?: string } | null> = verifyTag,
): RequestTagBindingResolver {
  return {
    async resolveXmtpBinding(tag: string): Promise<string | null> {
      const record = await verify(tag)
      return record?.xmtpAddress ?? null
    },
  }
}

/** With the Settings toggle off, only contacts the user added may send requests. */
export function createRequestSenderPolicy(
  contacts: { getEntries(): Promise<Contact[]> },
  allowNonContacts: () => boolean,
): RequestSenderPolicy {
  return {
    async admitsRequester(tag: string): Promise<boolean> {
      if (allowNonContacts()) return true
      const rows = (await contacts.getEntries())
        .filter(isPaymentContactEntry)
        .map(contactRowFromEntry)
      return approvedContactTags(rows).has(tag.toLowerCase())
    },
  }
}

/** Receiver writes over the requests store, via the shared row mapping. */
export function createRequestStoreWrites(store: Requests): RequestStoreWrites {
  return {
    findById: async (requestId: string) => (await store.get(requestId)) ?? null,
    addIncomingRequest: (input: IncomingRequestInput) =>
      store.addIfAbsent(incomingRequestToRow(input)),
    decline: (requestId) => store.decline(requestId),
  }
}
