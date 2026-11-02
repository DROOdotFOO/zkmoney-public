import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { GasSettings } from "@aztec-labs/stdlib/gas"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"

/**
 * Names a not-yet-deployed PasswordFPC as fee payer, contributing NO call of its own.
 *
 * The FPC becomes the payer from inside `constructor_and_pay`, so the payment method has nothing
 * to call — and must not call anything: a call emitted here would land ahead of the deployment and
 * close the setup phase before the fee-juice claim could run. Every transaction against an
 * already-deployed FPC uses {@link PasswordFPCPaymentMethod} instead.
 */
export class PasswordFPCBootstrapPaymentMethod implements FeePaymentMethod {
  constructor(private paymentContract: AztecAddress, private gasSettings: GasSettings) {}

  getExecutionPayload(): Promise<ExecutionPayload> {
    return Promise.resolve(new ExecutionPayload([], [], [], [], this.paymentContract))
  }

  getAsset(): Promise<AztecAddress> {
    return Promise.resolve(this.paymentContract)
  }

  getFeePayer(): Promise<AztecAddress> {
    return Promise.resolve(this.paymentContract)
  }

  getGasSettings(): GasSettings | undefined {
    return this.gasSettings
  }
}
