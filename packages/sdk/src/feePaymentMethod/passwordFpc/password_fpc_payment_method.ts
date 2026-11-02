import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import {
  FunctionCall,
  FunctionSelector,
  FunctionType,
  encodeArguments,
  type FunctionAbi,
} from "@aztec-labs/stdlib/abi"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { GasSettings } from "@aztec-labs/stdlib/gas"
import { ExecutionPayload } from "@aztec-labs/stdlib/tx"

const PASSWORD_FPC_FEE_ENTRYPOINT: FunctionAbi = {
  name: "fee_entrypoint_private",
  functionType: FunctionType.PRIVATE,
  isOnlySelf: false,
  isStatic: false,
  isInitializer: false,
  parameters: [
    {
      name: "max_fee",
      type: { kind: "integer", sign: "unsigned", width: 128 },
      visibility: "private",
    },
    {
      name: "nonce",
      type: { kind: "field" },
      visibility: "private",
    },
    {
      name: "password",
      type: { kind: "string", length: 31 },
      visibility: "private",
    },
  ],
  returnTypes: [],
  errorTypes: {},
}

// Hold the password off the instance entirely, keyed by the payment-method object. This keeps it
// out of `JSON.stringify`, `util.inspect`, and structured-clone output, so it can't leak into logs
// or serialized errors — without the `#private` field syntax, which this package's tsconfig
// target would downlevel and require `tslib` for.
const passwordStore = new WeakMap<object, string>()

export class PasswordFPCPaymentMethod implements FeePaymentMethod {
  constructor(
    password: string,
    private paymentContract: AztecAddress,
    private gasSettings: GasSettings,
  ) {
    passwordStore.set(this, password)
  }

  async getExecutionPayload(): Promise<ExecutionPayload> {
    const feeLimit = this.gasSettings.getFeeLimit()
    const txNonce = Fr.random()
    const password = passwordStore.get(this)
    if (password === undefined) {
      throw new Error("PasswordFPCPaymentMethod: password unavailable")
    }
    const args = encodeArguments(PASSWORD_FPC_FEE_ENTRYPOINT, [
      feeLimit.toBigInt(),
      txNonce,
      password,
    ])

    return new ExecutionPayload(
      [
        FunctionCall.from({
          name: "fee_entrypoint_private",
          to: this.paymentContract,
          selector: await FunctionSelector.fromNameAndParameters(
            PASSWORD_FPC_FEE_ENTRYPOINT.name,
            PASSWORD_FPC_FEE_ENTRYPOINT.parameters,
          ),
          type: FunctionType.PRIVATE,
          hideMsgSender: false,
          args,
          isStatic: false,
        }),
      ],
      [],
      [],
      [],
      this.paymentContract,
    )
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

  // Guard against the password leaking through stringification / logging.
  toString(): string {
    return `[PasswordFPCPaymentMethod -> ${this.paymentContract.toString()}]`
  }

  toJSON(): string {
    return this.toString()
  }
}
