import { fixed, type Balances } from "@obsidion/front-core"
import { activeNamespace, switchSession, type Session } from "../../src/platform/session"

/** What a screen reads from the session beside its stores; each a fake of the real value. */
export interface SessionValues {
  wallet?: unknown
  account?: unknown
  token?: unknown
  teeSigner?: unknown
  savings?: unknown
  balances?: Pick<Balances, "view" | "records">
}

/**
 * Makes the committed namespace's real session current, with each given value in place of its
 * resource, ready from the start. A value left out keeps the session's own resource.
 */
export function openTestSession(values: SessionValues = {}): Session {
  const session = switchSession(activeNamespace())
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue
    Object.defineProperty(session, name, {
      configurable: true,
      value: name === "balances" ? value : fixed(name, value),
    })
  }
  return session
}
