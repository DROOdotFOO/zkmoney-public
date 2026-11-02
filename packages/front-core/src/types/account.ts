import type { AUTH_TYPE } from "@obsidion/sdk"

export type WebAuthnData = {
  credentialId: string
  pubkey: string
  secretKey?: string
  /**
   * Which authenticator created the credential. Local mirror of the synced map's
   * field so the restart sign path (`getAuthProvider` → `createSignFn`) can
   * dispatch `getSecurityKey` vs `getPlatformKey` without a map round-trip.
   * Absent on accounts created before it existed (treated as `"platform"`).
   */
  authenticatorType?: "platform" | "security-key"
}

export type SignKeyConfig = {
  type: AUTH_TYPE
  webauthnData: WebAuthnData
}

export type AccountState = {
  name: string
  completeAddress: string
  signKeyConfig: SignKeyConfig
}

export type Account = {
  name: string
  completeAddress: string
}

export enum AccountActions {
  CREATE_ACCOUNT = "create_account",
  IMPORT_ACCOUNT = "import_account",
}
