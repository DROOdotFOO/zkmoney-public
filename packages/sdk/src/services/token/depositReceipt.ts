/** Positive duplicate/consumption evidence returned by the deployed token's store_deposit utility. */
export function isAlreadyClaimedDepositError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("deposit already stored") ||
    message.includes("deposit already spent") ||
    message.includes("deposit already claimed")
  ) // Frozen v4 wording.
}
