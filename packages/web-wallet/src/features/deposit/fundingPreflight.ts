/**
 * The last check before a wallet is asked to fund a deposit address: a new capacity read, never a cached one, and
 * the fee the form showed. It reserves nothing; it only stops a transfer that is known not to fit right now.
 */
import type {
  CapacityEligibility,
  PortalCapacityState,
  PortalCapacityStore,
  RequiredCredit,
} from "@obsidion/front-core"
import {
  capacityAllowsFunding,
  fundingEligibility,
  type UnknownCapacityPolicy,
} from "./fundingCapacity"

/**
 * Under `proceed`, how long the check waits for its read before it uses the store's current state instead. It stays
 * inside the desktop helper's recheck budget, so a slow read cannot refuse a send by running out of time.
 */
export const PROCEED_READ_WAIT_MS = 8_000

/** Nothing was sent: the form should show the new state and let the user decide again. */
export class FundingPreflightError extends Error {
  constructor(
    readonly reason: "capacity" | "quote-changed",
    message: string,
    readonly eligibility?: CapacityEligibility,
  ) {
    super(message)
    this.name = "FundingPreflightError"
  }
}

export async function runFundingPreflight(input: {
  /** Unset: the deployment's bucket is not known, so neither is its capacity. */
  store?: PortalCapacityStore
  required: RequiredCredit
  /** Defaults to `hold`. */
  unknownCapacity?: UnknownCapacityPolicy
  /** The fee the form showed and the one read for this send, compared as display strings of one token. */
  shownFee?: string
  freshFee?: string
  now?: () => number
}): Promise<void> {
  if (
    input.shownFee !== undefined &&
    input.freshFee !== undefined &&
    input.shownFee !== input.freshFee
  ) {
    throw new FundingPreflightError(
      "quote-changed",
      "The deposit fee changed. Review the new amount before sending.",
    )
  }
  const policy = input.unknownCapacity ?? "hold"
  const eligibility: CapacityEligibility = input.store
    ? await freshEligibility(input.store, input.required, policy, input.now ?? Date.now)
    : { kind: "unavailable", error: new Error("capacity bucket not known") }
  if (!capacityAllowsFunding(eligibility, policy)) {
    throw new FundingPreflightError(
      "capacity",
      "Network capacity changed. Review your deposit.",
      eligibility,
    )
  }
}

async function freshEligibility(
  store: PortalCapacityStore,
  required: RequiredCredit,
  policy: UnknownCapacityPolicy,
  now: () => number,
): Promise<CapacityEligibility> {
  const state = policy === "proceed" ? await readWithin(store) : await store.refreshForSubmit()
  return fundingEligibility({
    state,
    required,
    now: now(),
    staleAfterMs: store.policy.staleAfterMs,
    unknownCapacity: policy,
  })
}

/**
 * A new read, or the store's state once `PROCEED_READ_WAIT_MS` passes first. Another read may have published a
 * current shortfall or mismatch in the meantime, and that still holds the deposit.
 */
async function readWithin(store: PortalCapacityStore): Promise<PortalCapacityState> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      store.refreshForSubmit(),
      new Promise<PortalCapacityState>((resolve) => {
        timer = setTimeout(() => resolve(store.getState()), PROCEED_READ_WAIT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
