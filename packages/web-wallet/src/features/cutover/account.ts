import { useEffect } from "react"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useResource } from "@obsidion/front-core"
import { logout } from "../identity/logout"
import { isLogoutBlockedByRegistration } from "../onboarding/webRegistration"
import type { CutoverAccount } from "./parts"
import { useSession } from "../../platform/session"

// The PXE to stop before a sign-out; the mount keeps it current.
let stopPxe: () => Promise<void> = () => Promise.resolve()

/** Keeps the pill's logout pointed at the booted PXE. Mounted once, inside the wallet gate. */
export function CutoverLogoutMount() {
  const obsidionWallet = useResource(useSession().wallet)
  useEffect(() => {
    stopPxe = () => obsidionWallet?.pxe.stop() ?? Promise.resolve()
    return () => {
      stopPxe = () => Promise.resolve()
    }
  }, [obsidionWallet])
  return null
}

/** The tag pill's account, with its menu's logout; none for an account without a tag. */
export function cutoverAccount(): CutoverAccount | undefined {
  const tag = loadWalletIdentity()?.handle
  return tag
    ? {
        tag,
        logout: {
          blocked: () => isLogoutBlockedByRegistration(),
          run: () => logout(() => stopPxe()),
        },
      }
    : undefined
}
