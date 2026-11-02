/**
 * A stranded rotation's funding leaves through the account recovery: the origin a rotation's record
 * yields must pass that recovery's own checks and deploy the user-op clone.
 */
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { SIPAFactoryAbi } from "@oxide/l1-contracts"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { decodeFunctionData, multicall3Abi, type Address, type Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { SIPADepositRecord } from "../../../src/core/services/deposits/SIPADepositStore"
import { rotationDepositOrigin } from "../../../src/core/storages/BackupRotationStore"
import { runSipaRecovery, sipaDeployArgCandidates } from "../../../src/oxide/sipaRecovery"
import { addr, SIPA, storedRotation, word } from "../../__test-helpers__/backupRotation"

const FACTORIES = { sipaFactory: addr(0xfa), accountFactory: addr(0xaf) }
const TOKEN = addr(0xd4)
const TARGET = addr(0xee)

/** A rotation whose deploy args commit to `committed` with its own salt. */
function rotationFor(committed: Address) {
  const salt = Fr.random()
  const base = storedRotation()
  return storedRotation({
    sharedSecretSalt: salt.toString() as Hex,
    deployArgs: {
      ...base.deployArgs,
      recoveryCommitment: deriveRecoveryCommitment(
        salt,
        EthAddress.fromString(committed),
      ).toString() as Hex,
    },
  })
}

function recover(rotation: ReturnType<typeof storedRotation>) {
  const record = {
    sipaAddress: SIPA,
    phase: "sweeping",
    messageSecret: rotation.sharedSecretSalt!,
    recoveryAddress: "",
    tokenAddress: TOKEN,
    origin: rotationDepositOrigin(rotation, FACTORIES),
  } as SIPADepositRecord
  const signAccount = vi.fn(async () => `0x${"11".repeat(65)}` as Hex)
  const sendTransaction = vi.fn(async (_to: Address, _data: Hex) => word(0xab))
  const run = runSipaRecovery({
    record,
    stealthKey: { scalar: 1n, publicKey: { x: 1n, y: 2n } } as never,
    target: TARGET,
    signAccount,
    tokens: [TOKEN],
    chainId: 1,
    deployment: {
      readDeployed: async () => false,
      candidates: sipaDeployArgCandidates(record, []),
      predict: async () => SIPA,
    },
    sendTransaction,
    waitForReceipt: async () => true,
    store: { get: () => record, upsert: async () => record } as never,
    makeNonce: () => new Uint8Array(32),
  })
  return { run, signAccount, sendTransaction }
}

describe("rotationDepositOrigin", () => {
  it("lets the account recovery sign with the salt and deploy the user-op clone it was prepared on", async () => {
    const rotation = rotationFor(storedRotation().owner)
    const { run, signAccount, sendTransaction } = recover(rotation)
    expect(await run).toBe(word(0xab))
    expect(signAccount).toHaveBeenCalledWith(rotation.owner, expect.any(String))
    const [, data] = sendTransaction.mock.calls[0]!
    const [calls] = decodeFunctionData({ abi: multicall3Abi, data }).args as [
      { target: Address; callData: Hex }[],
    ]
    expect(calls.map((c) => c.target)).toEqual([FACTORIES.sipaFactory, SIPA])
    const deploy = decodeFunctionData({ abi: SIPAFactoryAbi, data: calls[0]!.callData })
    const { deployArgs } = rotation
    expect(deploy).toMatchObject({
      functionName: "deploySIPA",
      args: [
        deployArgs.implementation,
        deployArgs.intentHash,
        deployArgs.recoveryCommitment,
        BigInt(deployArgs.rollupVersion),
        false,
        deployArgs.forwardingTable,
      ],
    })
  })

  it("refuses before any signature when the salt commits to another account", async () => {
    const { run, signAccount, sendTransaction } = recover(rotationFor(addr(0x99)))
    await expect(run).rejects.toThrow("does not match the SIPA commitment")
    expect(signAccount).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
