/**
 * The entrypoint reaches the passkey sign.
 *
 * A real `ObsidionAccountEntrypoint` runs its full pre-sign hashing, then calls
 * `authProvider.createAuthWit`. A spy that throws a sentinel stands in for the
 * sign, so no valid witness or request is needed — reaching the sentinel is the
 * assertion.
 */
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { GasFees } from "@aztec-labs/stdlib/gas"
import { AccountFeePaymentMethodOptions } from "@aztec-labs/entrypoints/account"
import { describe, expect, it, vi } from "vitest"
import { stubGasSettingsFallback } from "../../../utils/wallet/obsidionWalletStubs.js"
import { ObsidionAccountEntrypoint } from "../../../../src/obsidion/alpha/account/ObsidionAccountEntrypoint.js"

describe("ObsidionAccountEntrypoint — sign boundary", () => {
  const SIGN_REACHED = "SIGN_REACHED"

  function makeEntrypoint() {
    const createAuthWit = vi.fn(async () => {
      throw new Error(SIGN_REACHED)
    })
    const authProvider = { createAuthWit } as never
    const entrypoint = new ObsidionAccountEntrypoint(
      AztecAddress.fromBigIntUnsafe(0x1234n),
      authProvider,
    )
    return { entrypoint, createAuthWit }
  }

  const chainInfo = { chainId: new Fr(31337), version: new Fr(1) }
  const gasSettings = stubGasSettingsFallback({ maxFeesPerGas: new GasFees(100n, 200n) })
  const baseOptions = {
    txNonce: new Fr(0x1234n),
    feePaymentMethodOptions: AccountFeePaymentMethodOptions.EXTERNAL,
  }
  // Empty payload: no intents → the else branch runs the real entrypoint hashing
  // (EncodedAppEntrypointCalls, HashedValues.fromArgs, poseidon2) before the sign.
  const emptyExec = () => new ExecutionPayload([], [], [], [])

  it("runs the pre-sign hashing and then signs", async () => {
    const { entrypoint, createAuthWit } = makeEntrypoint()
    await expect(
      entrypoint.createTxExecutionRequest(emptyExec(), gasSettings, chainInfo, { ...baseOptions }),
    ).rejects.toThrow(SIGN_REACHED)
    expect(createAuthWit).toHaveBeenCalledTimes(1)
  })
})
