import type { AccountServiceClient } from "@obsidion/front-core"
import { deviceStorage } from "../../platform/storage/rollupStorage"

/** A code's shape; account-service checks the exact format. A tag invite (`@tag`) names none. */
const INVITE_CODE = /^[a-z0-9]{4,16}$/
const STORAGE_KEY = "webwallet.inbound-invite"
/** How long an invite link's code waits for the signup it brought. */
export const INBOUND_INVITE_TTL_MS = 60 * 60 * 1000
/** Refusals that will not change on a retry: a malformed or unknown code, the user's own, or an
 *  invitee already registered. */
const FINAL_REFUSALS = new Set([400, 403, 404, 409])

/** Keeps the code from `?invite=`; runs before routing, which can drop the query. */
export function captureInboundInvite(href = window.location.href, now = Date.now()): void {
  try {
    const code = new URL(href).searchParams.get("invite")
    if (code && INVITE_CODE.test(code)) {
      deviceStorage.setItem(STORAGE_KEY, JSON.stringify({ code, at: now }))
    }
  } catch {
    // Without storage the invite is not credited.
  }
}

export function inboundInvite(now = Date.now()): string | undefined {
  try {
    const raw = deviceStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const { code, at } = JSON.parse(raw) as { code: string; at: number }
    return now - at < INBOUND_INVITE_TTL_MS && INVITE_CODE.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function forget(): void {
  try {
    deviceStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing kept.
  }
}

/**
 * Names the invite link's code as this signup's inviter. account-service refuses once the invitee
 * is registered, so a signup calls it before its tag registers; the credit lands when it does. A
 * final refusal drops the code, anything else keeps it for the next claim.
 */
export async function attributeInboundInvite(
  client: Pick<AccountServiceClient, "attributeInvite">,
  now = Date.now(),
): Promise<void> {
  const code = inboundInvite(now)
  if (!code) return
  try {
    await client.attributeInvite(code)
    forget()
  } catch (err) {
    // AccountServiceError's status, read without its class: main.tsx imports this module, and the
    // boot bundle stays free of front-core.
    const status = (err as { status?: unknown } | undefined)?.status
    if (typeof status === "number" && FINAL_REFUSALS.has(status)) forget()
  }
}
