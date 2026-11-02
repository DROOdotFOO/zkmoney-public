import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { FunctionCall, FunctionSelector } from "@aztec-labs/stdlib/abi"
import { FunctionType } from "@aztec-labs/stdlib/abi"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import type { GasSettings } from "@aztec-labs/stdlib/gas"

export class ObsidionFeeJuicePaymentMethod implements FeePaymentMethod {
  constructor(
    /**
     * Address of the account that will pay the fee
     */
    private feePayer: AztecAddress,

    /**
     * Gas settings used to compute the maximum fee the user is willing to pay
     */
    protected gasSettings: GasSettings,
  ) {}

  async getExecutionPayload(): Promise<ExecutionPayload> {
    const feeLimit = this.gasSettings.getFeeLimit()
    const randomNonce = Fr.random()
    const selector = await FunctionSelector.fromSignature("fee_entrypoint_private(u128,Field)")

    return new ExecutionPayload(
      [
        FunctionCall.from({
          name: "fee_entrypoint_private",
          to: this.feePayer,
          selector,
          type: FunctionType.PRIVATE,
          isStatic: false,
          hideMsgSender: false,
          args: [feeLimit, randomNonce],
        }),
      ],
      [],
      [],
      [],
      this.feePayer,
    )
  }

  getAsset(): Promise<AztecAddress> {
    throw new Error("Asset is not required for sponsored fpc.")
  }

  getFeePayer(): Promise<AztecAddress> {
    return Promise.resolve(this.feePayer)
  }

  getGasSettings(): GasSettings | undefined {
    return this.gasSettings
  }
}
