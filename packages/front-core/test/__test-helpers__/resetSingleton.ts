/**
 * Reset the `instance` field on a singleton class between tests.
 *
 * Usage:
 *   resetSingleton(SIPADepositStore as unknown as { instance: SIPADepositStore | null })
 *
 * The `as unknown as { instance: ... }` cast at the call site is deliberate —
 * the field is `private static`, and this helper keeps the non-goal "no
 * production-code changes" literally true. If `instance` is renamed, the
 * call sites break in one place rather than silently leaking state.
 */
export function resetSingleton<T>(cls: { instance: T | null }): void {
  cls.instance = null
}
