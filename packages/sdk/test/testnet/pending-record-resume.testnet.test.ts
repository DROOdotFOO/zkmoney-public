/**
 * Testnet E2E: pending-record resume after process death.
 *
 * Submit `wait: NO_WAIT` (the wallet writes a `PendingTxRecord` adjacent
 * to `node.sendTx` and returns immediately, NOT polling). Force-discard
 * the wallet instance — simulating the "process died before
 * `TxLifecycleService` ever attached" case. Boot a NEW wallet pointed at
 * the SAME `IPendingTxStore`, instantiate `TxLifecycleService` with that
 * store, call `resumeAll()`. Assert the pending record is reconciled:
 * the unified poll observes the original mining, calls
 * `pendingTxStore.remove(txHash)`, and patches `TransactionStorage`
 * status.
 *
 * Validates the pending-record-resume fix on real network under the
 * merged `TxLifecycleService` design.
 *
 * **Manual / pre-merge gate.** Skipped via `TESTNET_SKIP=1`.
 */
import { describe, it, beforeAll, afterAll } from "vitest"

import { setupTestnet, skipUnlessTestnet } from "./setupTestnet.js"
import type { TestnetSetupResult } from "./setupTestnet.js"

describe.skipIf(skipUnlessTestnet())("pending-record resume — testnet E2E", () => {
  let setup: TestnetSetupResult

  beforeAll(async () => {
    setup = await setupTestnet()
  }, 5 * 60_000)

  afterAll(async () => {
    await setup?.teardown()
  })

  it.todo(
    "wallet.sendTx({ wait: NO_WAIT }) → record persisted in pendingTxStore " +
      "→ wallet instance discarded (no TxLifecycleService attached) → " +
      "fresh wallet + TxLifecycleService.get(...) with SAME store → " +
      "resumeAll() → pending record reconciled (remove called once, " +
      "TransactionStorage status patched, exactly one transactionsUpdated event)",
  )

  it.todo(
    "symmetric path: receipt resolves DROPPED → record removed; " +
      "TransactionStorage status reflects the drop",
  )

  /**
   * Implementation note: the test must NOT instantiate a
   * TxLifecycleService in the FIRST process — otherwise the listener
   * picks up the create event and the pending record gets reconciled
   * by the listener path, not the resumeAll() path. The whole point
   * of this test is the listener-attach gap that resumeAll() has to
   * close.
   */
})
