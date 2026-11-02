import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createExtendedL1Client } from "@aztec-labs/ethereum/client"
import { deployL1Contract } from "@aztec-labs/ethereum/deploy-l1-contract"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Buffer32 } from "@aztec-labs/foundation/buffer"
import {
  deployNamePortal,
  deployNameRegistryStack,
  updateDomainOwner,
  updateRegistrationController,
  deployFrozenDepositsRefundVerifier,
  deployFrozenNotesRefundVerifier,
  deployNitroValidator,
  deployPlainWithdrawalExecutor,
  deployPortalFactory,
  deployTeeRegistry,
  DEPOSIT_SWEEP_FEE,
  REGISTRATION_SWEEP_FEE,
  USER_OP_SWEEP_FEE,
  SipaIntent,
  deployForwardingTable,
  deploySIPAImplementations,
  deployRegistrationController,
  deployUnprocessedDepositRefundVerifier,
  MockV3AggregatorAbi,
  MockV3AggregatorBytecode,
  OxideAccountFactoryAbi,
  OxideAccountFactoryBytecode,
  MintableTokenAbi,
  MintableTokenBytecode,
  type OxidePortalContract,
  type PortalFactoryContract,
  type TeeRegistryContract,
} from "@oxide/l1-contracts"
import { hashPcr0 } from "@oxide/oxide-lib/attestation/pcr0.js"
import type { P256PublicKey } from "@oxide/oxide-lib/encryption.js"
import type { OxideTokenImmutables } from "@oxide/oxide-lib/token_immutables.js"
import {
  erc20Abi,
  getContract,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"

import { generateTestAttestation, type TestAttestationFixture } from "./gen_test_attestation.js"
import { deployTestCertManager } from "./deploy_test_cert_manager.js"

const ONE_ETH = 10n ** 18n
const CAPS_RATE = ONE_ETH
const CAPS_GLOBAL_LIMIT = 500_000n * ONE_ETH
/** Each harness portal's default `TX_AMOUNT_CAP()`, and its token's `maxNoteAmount`. */
export const HARNESS_TX_AMOUNT_CAP = 5166n * ONE_ETH
/** The sweep tips the table's deposit and registration rows charge — oxide's own defaults, so a
 *  harness sweep costs what a deployed one does. */
export const HARNESS_DEPOSIT_FEE = DEPOSIT_SWEEP_FEE
export const HARNESS_REGISTRATION_FEE = REGISTRATION_SWEEP_FEE
/** The plain withdrawal executor's `FEE()`: 0.1 token, so a release pays a fee as a deployed one does. */
export const HARNESS_WITHDRAWAL_FEE = ONE_ETH / 10n
/** Receives `HARNESS_WITHDRAWAL_FEE`: a stand-in for the FPCFunder, with no code and no other inflow. */
export const HARNESS_FEE_BENEFICIARY = `0x${"fee".padStart(40, "0")}` as Address

export interface AztecL1Wiring {
  registry: EthAddress
  rollup: EthAddress
  inbox: EthAddress
  outbox: EthAddress
  rollupVersion: bigint
}

function requireEthAddress(value: unknown, name: string): EthAddress {
  if (value == null || value === "") {
    throw new Error(
      `Aztec L1 wiring missing ${name} — is \`aztec start --local-network\` fully up? ` +
        `node_getNodeInfo must return l1ContractAddresses.${name}.`,
    )
  }
  if (value instanceof EthAddress) {
    return value
  }
  return EthAddress.fromString(String(value))
}

export function aztecL1WiringFromNodeInfo(nodeInfo: {
  rollupVersion: number
  l1ContractAddresses: {
    registryAddress?: unknown
    rollupAddress?: unknown
    inboxAddress?: unknown
    outboxAddress?: unknown
  }
}): AztecL1Wiring {
  const l1 = nodeInfo.l1ContractAddresses
  return {
    registry: requireEthAddress(l1.registryAddress, "registryAddress"),
    rollup: requireEthAddress(l1.rollupAddress, "rollupAddress"),
    inbox: requireEthAddress(l1.inboxAddress, "inboxAddress"),
    outbox: requireEthAddress(l1.outboxAddress, "outboxAddress"),
    rollupVersion: BigInt(nodeInfo.rollupVersion),
  }
}

export interface TEEDraftKeys {
  pubKeyX: Buffer32
  pubKeyY: Buffer32
  ethAddress: EthAddress
  encryptionPublicKey: P256PublicKey
}

/**
 * Registration payment policy (registration-by-deposit). Given, the harness deploys a fresh
 * `OxideAccountFactory` plus a RegistrationController with these args (feeToken = the test token,
 * `feeBeneficiary` = beneficiary id 0) and blesses it on the registry, so registration sweeps run;
 * omitted, no controller exists and only the plain deposit + broadcast paths work.
 */
export type RegistrationDeployOpts = {
  domainOwner: Address
  feeBeneficiary: Address
  registrationMin: bigint
  registrationFee: bigint
}

/** The portal's shared deposit bucket (`Caps`): its refill rate per second and its ceiling, in
 *  token base units, and its per-operation cap. All are immutable once the portal is deployed. */
export type PortalCapsOpts = {
  rate: bigint
  globalLimit: bigint
  /** Default {@link HARNESS_TX_AMOUNT_CAP}. */
  txAmountCap?: bigint
}

/** Publishes the L2 token the immutables commit to and returns its address. */
export type PublishL2Token = (immutables: OxideTokenImmutables) => Promise<AztecAddress>

export interface DeploymentResultWithNitro {
  tokenPortal: Address
  testToken: Address
  registryAddress: Address
  /** The oxide NameRegistry — NOT `registryAddress`, which is the Aztec rollup registry. */
  nameRegistry: Address
  /** Where user records live; the NameRegistry holds only the name → owner mapping. */
  accountMetadataRegistry: Address
  /**
   * The permanent CREATE2 deployer of every SIPA, and the registry of blessed implementations it
   * will clone. A SIPA deployed anywhere else derives a different address, so tests must use it.
   */
  sipaFactory: Address
  /** The CCIP resolution module blessed as the registry's `latestResolver`. */
  sipaResolver: Address
  /** The `OxideAccountFactory` register() predicts owners from + deploys — present only with `registration`. */
  accountFactory?: Address
  /** The NamePortal the controller notifies a claimed name through — present only with `registration`. */
  namePortal?: Address
  /** Every withdrawal settles into it; it takes `HARNESS_WITHDRAWAL_FEE` to `HARNESS_FEE_BENEFICIARY`,
   *  pays the relayer tip and forwards the rest. */
  plainWithdrawalExecutor: Address
  registrationController?: Address
  /** Routes this stack's SIPAs to `portal`; its registration row charges the heavier tip. */
  forwardingTable: Address
  /** Blessed on `sipaFactory` for `forwardingTable`. */
  depositSIPAImplementation: Address
  registrationSIPAImplementation: Address
  userOpSIPAImplementation: Address
  portal: OxidePortalContract
  /** The L2 token the portal is bound to, and the immutables it was published with. */
  l2Token: AztecAddress
  immutables: OxideTokenImmutables
  /** Every enclave the portal's token trusts registers here. */
  teeRegistry: TeeRegistryContract
  portalFactory: PortalFactoryContract
  nitroValidatorAddress: Address
  certManagerAddress: Address
  frozenNotesRefundVerifierAddress: Address
  frozenDepositRefundVerifierAddress: Address
  unprocessedDepositRefundVerifierAddress: Address
  fixture: TestAttestationFixture
}

export async function deploySandboxOxidePortalStack(
  walletClient: WalletClient,
  publicClient: PublicClient,
  aztec: AztecL1Wiring,
  teeKeys: TEEDraftKeys,
  options: {
    relayerPrivateKey: Hex
    l1Chain: Chain
    l1RpcUrl: string
    l1ChainTimestampMillis?: number
    // Bind the portal to an already-deployed underlying ERC20 (cross-generation
    // reclaim tests) instead of deploying a fresh one.
    existingTestToken?: Address
    // Deploy a real register()-capable registry (+ a fresh OxideAccountFactory) instead of the
    // placeholder-arg one; feeToken is the test token so a funded SIPA can pay the registration fee.
    registration?: RegistrationDeployOpts
    // Deposit bucket for suites that exercise capacity; omitted, the bucket is effectively unlimited.
    caps?: PortalCapsOpts
    // A fresh test token's name and symbol; default "DAI". The L2 token takes the underlying's.
    tokenName?: string
    tokenSymbol?: string
    publishL2Token: PublishL2Token
  },
): Promise<DeploymentResultWithNitro> {
  const account = walletClient.account!

  let testToken: Address
  if (options.existingTestToken) {
    testToken = options.existingTestToken
  } else {
    const tokenHash = await walletClient.deployContract({
      account,
      chain: walletClient.chain!,
      abi: MintableTokenAbi,
      bytecode: MintableTokenBytecode,
      args: [options.tokenName ?? "DAI", options.tokenSymbol ?? "DAI", 18],
    })
    const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash })
    testToken = tokenReceipt.contractAddress!
  }

  const fixture = generateTestAttestation({
    pubKeyX: teeKeys.pubKeyX,
    pubKeyY: teeKeys.pubKeyY,
    encPubKeyX: teeKeys.encryptionPublicKey.x,
    encPubKeyY: teeKeys.encryptionPublicKey.y,
    timestampMillis: options.l1ChainTimestampMillis,
  })

  const extendedClient = createExtendedL1Client(
    [options.l1RpcUrl],
    options.relayerPrivateKey,
    options.l1Chain,
  )

  const owner = EthAddress.fromString(extendedClient.account.address)
  const certManagerEth = await deployTestCertManager(extendedClient, fixture.rootArgs)
  const nitroValidatorEth = await deployNitroValidator(extendedClient, certManagerEth)
  const teeRegistry = await deployTeeRegistry(extendedClient, {
    pcr0Hash: hashPcr0(fixture.summary.pcr0),
    certManager: certManagerEth,
    nitroValidator: nitroValidatorEth,
    registry: aztec.registry,
    rollupVersion: aztec.rollupVersion,
  })
  // Without `registration` opts nothing here resolves or REGISTERS a name, so the verifier /
  // factory slots take the owner address (the constructor only rejects a zero factory) and no
  // payment policy exists. With them, deploy a real register()-capable stack over a fresh
  // OxideAccountFactory: registration sweeps resolve the payment policy live via
  // `nameRegistry.registrationController()`, so a RegistrationController (test token as fee token,
  // `feeBeneficiary` seeded as beneficiary id 0) is deployed and blessed. The NameRegistry is
  // deployed with the DEPLOYER as domain owner so the bless needs no extra key, then ownership is
  // handed to `reg.domainOwner` before any claim is signed.
  // Deploy through `extendedClient`, the same relayer-key client the surrounding stack deploys use;
  // a `walletClient` tx here would advance the relayer nonce out from under it (later txs revert
  // "nonce too low").
  let accountFactory: Address | undefined
  if (options.registration) {
    accountFactory = String(
      (
        await deployL1Contract(
          extendedClient,
          OxideAccountFactoryAbi,
          OxideAccountFactoryBytecode,
          [],
        )
      ).address,
    ) as Address
  }
  const reg = options.registration
  const { nameRegistry, accountMetadataRegistry, sipaFactory, sipaResolver } =
    await deployNameRegistryStack(walletClient, publicClient, account.address, account.address)
  let namePortal: Address | undefined
  let registrationController: Address | undefined
  if (reg) {
    // Bound to the NameRegistry and the Aztec Registry it resolves a rollup version's Inbox
    // through; the controller binds it immutably, so it is deployed first.
    namePortal = await deployNamePortal(
      walletClient,
      publicClient,
      nameRegistry,
      aztec.registry.toString() as Address,
      accountFactory ?? account.address,
    )
    registrationController = await deployRegistrationController(
      walletClient,
      publicClient,
      nameRegistry,
      sipaFactory,
      accountFactory ?? account.address,
      namePortal,
      testToken,
      reg.registrationMin,
      reg.registrationFee,
      reg.feeBeneficiary,
    )
    await updateRegistrationController(
      walletClient,
      publicClient,
      nameRegistry,
      registrationController,
    )
    await updateDomainOwner(walletClient, publicClient, nameRegistry, reg.domainOwner)
  }
  const frozenNotesVerifierEth = await deployFrozenNotesRefundVerifier(extendedClient)
  const frozenDepositVerifierEth = await deployFrozenDepositsRefundVerifier(extendedClient)
  const unprocessedDepositVerifierEth = await deployUnprocessedDepositRefundVerifier(extendedClient)

  const portalFactory = await deployPortalFactory(extendedClient, {
    owner,
    teeRegistry: teeRegistry.address,
    registry: aztec.registry,
    rollupVersion: aztec.rollupVersion,
    verifiers: {
      frozenNotes: frozenNotesVerifierEth,
      frozenDeposits: frozenDepositVerifierEth,
      unprocessedDeposit: unprocessedDepositVerifierEth,
    },
  })
  const portalArgs = {
    underlying: EthAddress.fromString(testToken),
    txAmountCap: options.caps?.txAmountCap ?? HARNESS_TX_AMOUNT_CAP,
    rate: options.caps?.rate ?? CAPS_RATE,
    globalLimit: options.caps?.globalLimit ?? CAPS_GLOBAL_LIMIT,
  }
  // The token's metadata is the underlying's: a wallet reads the immutables back off the portal.
  const underlying = { address: testToken, abi: erc20Abi } as const
  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({ ...underlying, functionName: "name" }),
    publicClient.readContract({ ...underlying, functionName: "symbol" }),
    publicClient.readContract({ ...underlying, functionName: "decimals" }),
  ])
  const immutables: OxideTokenImmutables = {
    portal: await portalFactory.predictPortalAddress(portalArgs),
    teeRegistry: teeRegistry.address,
    name,
    symbol,
    decimals,
    maxNoteAmount: portalArgs.txAmountCap,
  }
  const l2Token = await options.publishL2Token(immutables)
  const { portal } = await portalFactory.deployPortal(portalArgs, l2Token, {
    waitForReceipt: true,
  })

  const forwardingTable = await deployForwardingTable(walletClient, publicClient, {
    owner: account.address,
    rollupVersion: aztec.rollupVersion,
    beneficiary: account.address,
    rows: [
      {
        token: testToken,
        portal: portal.address.toString() as Address,
        intents: [
          { intent: SipaIntent.Deposit, beneficiaryFee: 0n, sweepTip: HARNESS_DEPOSIT_FEE },
          {
            intent: SipaIntent.Registration,
            beneficiaryFee: 0n,
            sweepTip: HARNESS_REGISTRATION_FEE,
          },
          { intent: SipaIntent.UserOp, beneficiaryFee: 0n, sweepTip: USER_OP_SWEEP_FEE },
        ],
      },
    ],
  })
  const { depositSIPAImplementation, registrationSIPAImplementation, userOpSIPAImplementation } =
    await deploySIPAImplementations(walletClient, publicClient, {
      sipaFactory,
      forwardingTable,
      nameRegistry,
    })
  // The executor's own subsidy prices its payout off an ETH/USD feed: 8 decimals, $3000.
  const { address: priceFeed } = await deployL1Contract(
    extendedClient,
    MockV3AggregatorAbi,
    MockV3AggregatorBytecode,
    [8, 3000_00000000n],
  )
  const { executor: plainWithdrawalExecutor } = await deployPlainWithdrawalExecutor(
    extendedClient,
    portal.address,
    HARNESS_WITHDRAWAL_FEE,
    EthAddress.fromString(HARNESS_FEE_BENEFICIARY),
    owner,
    priceFeed,
  )

  return {
    tokenPortal: portal.address.toString() as Address,
    testToken,
    registryAddress: aztec.registry.toString() as Address,
    nameRegistry,
    accountMetadataRegistry,
    sipaFactory,
    sipaResolver,
    accountFactory,
    namePortal,
    registrationController,
    plainWithdrawalExecutor: plainWithdrawalExecutor.toString() as Address,
    forwardingTable,
    depositSIPAImplementation,
    registrationSIPAImplementation,
    userOpSIPAImplementation,
    portal,
    l2Token,
    immutables,
    teeRegistry,
    portalFactory,
    nitroValidatorAddress: nitroValidatorEth.toString() as Address,
    certManagerAddress: certManagerEth.toString() as Address,
    frozenNotesRefundVerifierAddress: frozenNotesVerifierEth.toString() as Address,
    frozenDepositRefundVerifierAddress: frozenDepositVerifierEth.toString() as Address,
    unprocessedDepositRefundVerifierAddress: unprocessedDepositVerifierEth.toString() as Address,
    fixture,
  }
}

export async function mintTestTokens(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tokenAddress: Address,
  recipient: Address,
  amount: bigint,
): Promise<void> {
  const token = getContract({
    address: tokenAddress,
    abi: MintableTokenAbi,
    client: { public: publicClient, wallet: walletClient },
  })
  const hash = await token.write.mint([recipient, amount], {
    account: walletClient.account!,
    chain: walletClient.chain!,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}
