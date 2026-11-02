import { WalletError, type ErrorCode } from "@obsidion/core/errors"
import copy from "./catalog.copy"

const words: Partial<Record<ErrorCode, string>> = copy

/** A `WalletError`'s words, its data filled in; undefined for any other error and a code with none. */
export function errorCopy(e: unknown): string | undefined {
  if (!(e instanceof WalletError)) return undefined
  const data = e.data ?? {}
  return words[e.code]?.replace(/\{(\w+)\}/g, (slot, name: string) => data[name] ?? slot)
}
