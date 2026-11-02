import { expect } from "vitest"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { createExtendedL1Client } from "@aztec-labs/ethereum/client"
import { foundry } from "viem/chains"
import type { Address, Hex } from "viem"
import { MintableTokenAbi } from "@oxide/l1-contracts"
import { L1_RPC_URL } from "@obsidion/core/constants"
import {
  buildWithdrawFinalizationCall,
  WithdrawFinalizationError,
} from "../../../src/oxide/withdrawal/withdrawFinalizationCall.js"
import { sendEmptyTx } from "../../../src/utils/helper.js"
import type { OxideTokenSandbox } from "../oxide/oxideTokenSandbox.js"
import { HARNESS_FEE_BENEFICIARY, HARNESS_WITHDRAWAL_FEE } from "../tee/oxidePortalHarness.js"

/** The executor a burn named, and the fee it pays its beneficiary. */
export interface ReleaseExecutor {
  address: Hex
  fee: bigint
  beneficiary: Address
}

/**
 * Exercise the production finalization builder against the real portal; assert actual ERC20
 * delivery, and the executor's fee reaching its beneficiary. `owner` is the account the burn spent
 * from; `wallet` holds its keys and reads its recovery events. `release` is the executor the burn
 * named; the harness's by default.
 */
export async function finalizePaylinkWithdrawal(
  sandbox: OxideTokenSandbox,
  burnTxHash: Hex,
  owner: AztecAddress,
  recipient: Address,
  expectedNet: bigint,
  wallet: Pick<Wallet, "getPrivateEvents"> = sandbox.wallet,
  release?: ReleaseExecutor,
) {
  const { l1Deployment: deployment, publicClient } = sandbox.oxideStack
  const client = createExtendedL1Client(
    [process.env.SANDBOX_L1_RPC_URL || L1_RPC_URL.LOCAL],
    sandbox.oxideStack.relayerPrivateKey,
    foundry,
  )
  const executor = release?.address ?? sandbox.withdrawal.tuple?.plainWithdrawalExecutor
  if (!executor)
    throw new Error("The sandbox withdrawal deployment has no plain withdrawal executor")
  const { fee, beneficiary } = release ?? {
    fee: HARNESS_WITHDRAWAL_FEE,
    beneficiary: HARNESS_FEE_BENEFICIARY,
  }
  const balance = (holder: Address = recipient) =>
    publicClient.readContract({
      address: deployment.testToken,
      abi: MintableTokenAbi,
      functionName: "balanceOf",
      args: [holder],
    })
  const before = await balance()
  const feeBefore = await balance(beneficiary)
  for (let attempt = 0; attempt < 24; attempt++) {
    try {
      const call = await buildWithdrawFinalizationCall(
        {
          node: sandbox.node,
          wallet,
          signer: sandbox.teeSigner,
          portal: sandbox.portalDomain,
          executor: executor as Hex,
          l1: publicClient,
        },
        { burnTxHash, owner, tipRecipient: client.account.address },
      )
      // The bare estimate leaves the executor's subsidy call short of gas. Buffer it like the
      // wallet's L1 channel does.
      const estimate = await publicClient.estimateGas({
        account: client.account.address,
        to: call.to,
        data: call.data,
      })
      const hash = await client.sendTransaction({
        to: call.to,
        data: call.data,
        gas: (estimate * 120n) / 100n,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      expect(receipt.status).toBe("success")
      expect((await balance()) - before).toBe(expectedNet)
      expect((await balance(beneficiary)) - feeBefore).toBe(fee)
      console.log(`Email withdrawal finalized: l2=${burnTxHash} l1=${hash} net=${expectedNet}`)
      return
    } catch (error) {
      if (!(error instanceof WithdrawFinalizationError) || error.reason !== "not-yet-finalizable")
        throw error
      await sendEmptyTx(sandbox.wallet, sandbox.accounts[0]!, sandbox.sponsoredFeePaymentMethod)
    }
  }
  throw new Error("Email withdrawal did not become finalizable after 24 blocks")
}
