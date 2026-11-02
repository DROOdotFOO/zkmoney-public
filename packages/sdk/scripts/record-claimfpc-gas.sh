#!/usr/bin/env bash
# Re-measures src/feePaymentMethod/claimFpc/gas/claimFpcGasTable.ts against a running sandbox.
#
# The per-call budgets (claimFpcGasBudgets.ts) derive from two registration-gated rows and the lone
# L1-operation broadcasts, and every case that prices a per-call policy reads the budgets from the
# table as imported at process start. So the table is recorded in two passes: the first runs only
# the cases that record those rows, the second runs every fpc suite against the updated table, and
# the inventory check runs last.
#
# The recorder only upserts rows: delete a retired shape's row from the table by hand. A renamed
# shape the budgets read (a burn row, say) has to be recorded once before the second pass can price
# a per-call policy: run its suite with CLAIMFPC_GAS_REPORT=1 first.
#
# Usage, from packages/sdk: pnpm gas:record
set -euo pipefail
cd "$(dirname "$0")/.."

BUDGET_ROWS='subscribes and broadcasts a self-resolved SIPA in ONE tx|onboards a user whose first batch is the account authorizing an empty intent batch alone|on the open policy'

rm -rf pxe-*
CLAIMFPC_GAS_REPORT=1 CI=true npx vitest run --config vitest.sandbox.config.ts \
  test/fpc/claimFpc/registrationRail.sandbox.test.ts test/fpc/claimFpcSipaBroadcast.sandbox.test.ts \
  test/fpc/claimFpcL1Operations.sandbox.test.ts -t "$BUDGET_ROWS"

rm -rf pxe-*
CLAIMFPC_GAS_REPORT=1 CI=true npx vitest run --config vitest.sandbox.config.ts test/fpc

# The second pass re-records the budget rows it imported, so check the table it left behind.
CI=true npx vitest run test/feePaymentMethod/claimFpc/gas/claimFpcGasInventory.test.ts
