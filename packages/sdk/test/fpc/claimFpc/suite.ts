/**
 * Shared fixture for the ClaimFPC e2e files. Each file runs in its own worker against the same
 * sandbox, so each gets its own PXE, token, user and, optionally, a four-rail test FPC. Files
 * never share on-chain state: a file that needs a subscription makes it itself.
 */
import { computeAuthWitMessageHash } from "@aztec-labs/aztec.js/authorization"
import type { BaseAccount } from "@aztec-labs/aztec.js/account"
import type { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { PXE } from "@aztec-labs/pxe/server"
import { keccak256, toBytes, type Hex } from "viem"
import {
  type TestTokenContract,
  ClaimFPCContract,
  ContractService,
  DEFAULT_CONTRACTS,
  Network,
  NodeContractServiceStorage,
  getHardcodedArtifact,
} from "@obsidion/contracts"
import {
  type ClaimFpcRailPolicy,
  type ClassWitnessInput,
  computeIntentsOnlyAuthWitHash,
  padIntentHashes,
} from "../../../src/feePaymentMethod/index.js"
import type { ObsidionWalletTest } from "../../../src/obsidion/ObsidionWalletTest.js"
import type { ObsidionAccount } from "../../../src/obsidion/alpha/account/ObsidionAccount.js"
import { EcdsaK256AlphaAuthProvider } from "../../../src/obsidion/alpha/auth/EcdsaK256AlphaAuthProvider.js"
import { deployTestToken, mintTokensToPrivate } from "../../utils/index.js"
import { setupTest } from "../../utils/helper.js"
import { waitForSandboxL1ToL2Message } from "../../../src/utils/helper.js"
import {
  TEST_RAIL_REGISTERED,
  type ClaimFPCFixture,
  classWitnessFor,
  fixtureRail,
  makeTestClaimFpcConfig,
  openRailSpec,
  sendRegistrationMessage,
  setupClaimFPC,
  testL1Client,
  testNamePortalAccount,
  type TestRegistrant,
} from "../../utils/claimFpc/claimFpcFixture.js"
import { emptyTransferMeta } from "@obsidion/core/constants"

export const TRANSFER_AMOUNT = 10n ** 18n
export const BOOTSTRAP_PK =
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as Hex
export const NAME_HASH = toBytes(keccak256(toBytes("grego")))
/** The four-rail FPC's second rail: same gate, one use, never refilling. */
export const SINGLE_SHOT_RAIL = "single-shot"
/** The four-rail FPC's registration-gated rails; two of them, so one message is shown to open both. */
export const MESSAGE_RAIL = "message-gated"
export const MESSAGE_RAIL_ALT = "message-gated-alt"

export type ClaimFpcSuite = {
  wallet: ObsidionWalletTest
  admin: BaseAccount
  sponsoredFeePaymentMethod: SponsoredFeePaymentMethod
  contractService: ContractService
  recipient: AztecAddress
  /** Registered and funded with tokens, no tx of its own yet. */
  user: ObsidionAccount
  userAuthProvider: EcdsaK256AlphaAuthProvider
  token: TestTokenContract
  paylinkArtifact: ContractArtifact
  emailArtifact: ContractArtifact
  accountArtifact: ContractArtifact
  accountContract: Contract
  accountWitness: ClassWitnessInput
  inboxAddress: Hex
  rollupVersion: number
  portalL1: ReturnType<typeof testL1Client>
  /** The four-rail test FPC; only files set up with `fourRailFpc` have it. */
  fpc: ClaimFPCFixture
  fpcContract: ClaimFPCContract
  sponsoredRail: ClaimFpcRailPolicy
  singleShotRail: ClaimFpcRailPolicy
  messageRail: ClaimFpcRailPolicy
  messageRailAlt: ClaimFpcRailPolicy
}

/** Filled by {@link setupClaimFpcSuite}; one per worker process. */
export const s = {} as ClaimFpcSuite

export async function setupClaimFpcSuite({
  fourRailFpc,
}: {
  fourRailFpc: boolean
}): Promise<ClaimFpcSuite> {
  const setup = await setupTest()
  s.wallet = setup.wallet
  s.admin = setup.accounts[0]!
  s.sponsoredFeePaymentMethod = setup.sponsoredFeePaymentMethod
  s.contractService = setup.contractService
  s.recipient = setup.accounts[1]!.getAddress()

  const signingKey = new Fr(Fr.random().toBigInt() % Fr.MODULUS).toBuffer()
  s.userAuthProvider = new EcdsaK256AlphaAuthProvider(signingKey)
  s.user = await s.wallet.createObsidionAccount(Fr.random(), s.userAuthProvider)

  const deployed = await deployTestToken(
    s.wallet,
    s.admin.getAddress(),
    s.admin.getAddress(),
    s.user.getAddress(),
    TRANSFER_AMOUNT * 100n,
  )
  s.token = deployed.contract as TestTokenContract

  s.accountArtifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.obsidionAccountAlphaTest)
  s.accountContract = Contract.at(s.user.getAddress(), s.accountArtifact, s.wallet)
  s.accountWitness = await classWitnessFor(await s.user.getContractInstance())

  s.paylinkArtifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.paylinkDirect)
  s.emailArtifact = await getHardcodedArtifact(DEFAULT_CONTRACTS.paylinkEmail)

  const nodeInfo = await s.wallet.node.getNodeInfo()
  s.inboxAddress = nodeInfo.l1ContractAddresses.inboxAddress.toString() as Hex
  s.rollupVersion = nodeInfo.rollupVersion
  s.portalL1 = testL1Client(testNamePortalAccount())

  if (fourRailFpc) {
    // A test deployment, not the production rail set. The first rail takes production's policy
    // shape — ONE `ByAny` entry — with allowance 10: subscribe burns 1, then every sponsored batch
    // in nameClaimRail burns one more. The
    // second exists to be independent of it: same gate, one use, no refill. The last two are gated
    // on the portal's L1->L2 message instead, and there are two of them so a spent message can be
    // shown not to open the other.
    s.fpc = await setupClaimFPC(
      s.wallet,
      s.admin,
      s.sponsoredFeePaymentMethod,
      await makeTestClaimFpcConfig([
        openRailSpec({ maxTx: 10 }),
        openRailSpec({ name: SINGLE_SHOT_RAIL, maxTx: 1, refillPeriodSeconds: 0n }),
        openRailSpec({ name: MESSAGE_RAIL, gate: "registration", maxTx: 10 }),
        openRailSpec({ name: MESSAGE_RAIL_ALT, gate: "registration", maxTx: 10 }),
      ]),
    )
    s.sponsoredRail = fixtureRail(s.fpc, TEST_RAIL_REGISTERED)
    s.singleShotRail = fixtureRail(s.fpc, SINGLE_SHOT_RAIL)
    s.messageRail = fixtureRail(s.fpc, MESSAGE_RAIL)
    s.messageRailAlt = fixtureRail(s.fpc, MESSAGE_RAIL_ALT)
    s.fpcContract = ClaimFPCContract.at(s.fpc.fpcAddress, s.fpc.fpcArtifact, s.wallet)
  }
  return s
}

/** The message `authorize_intents` verifies for `account`. */
export const intentsAuthWitHash = (account: ObsidionAccount, intents: Fr[]) =>
  computeIntentsOnlyAuthWitHash(
    account.getAddress(),
    { chainId: account.getChainId(), version: account.getVersion() },
    intents,
  )

/** The allowance the deployed config gives a rail — the note's starting `uses` plus one. */
export function railMaxTx(fixture: ClaimFPCFixture, rail: ClaimFpcRailPolicy): number {
  return fixture.config.rails[rail.railId]!.max_tx
}

export function transferInteraction(from: AztecAddress, nonce: number, amount = TRANSFER_AMOUNT) {
  return s.token.methods.transfer(from, s.recipient, amount, emptyTransferMeta(), nonce)
}

export async function buildSponsoredTransfer(
  account: ObsidionAccount,
  provider: EcdsaK256AlphaAuthProvider,
  nonce: number,
  amount = TRANSFER_AMOUNT,
  fpcAddress?: AztecAddress,
  extraIntents: Fr[] = [],
) {
  const interaction = transferInteraction(account.getAddress(), nonce, amount)
  const call = (await interaction.request()).calls[0]!
  const intentHash = await computeAuthWitMessageHash(
    { caller: fpcAddress ?? s.fpc.fpcAddress, action: interaction },
    { chainId: account.getChainId(), version: account.getVersion() },
  )
  const intentHashes = [intentHash, ...extraIntents]
  const combinedWitness = await provider.createAuthWit(
    await intentsAuthWitHash(account, intentHashes),
  )
  return { call, intentHash, intentHashes, combinedWitness }
}

export async function buildAuthorizeIntentsCall(intentHash: Fr) {
  return (
    await s.accountContract.methods.authorize_intents!(padIntentHashes([intentHash])).request()
  ).calls[0]!
}

/**
 * Put a name-ownership message for `registrant` in the Inbox and wait until it is consumable.
 * Sent by the anvil EOA the fixture config pins as the portal unless another index is named.
 */
export async function deliverRegistrationMessage(
  registrant: TestRegistrant,
  senderIndex?: number,
): Promise<{ leafIndex: bigint }> {
  const l1 =
    senderIndex === undefined ? s.portalL1 : testL1Client(testNamePortalAccount(senderIndex))
  const message = await sendRegistrationMessage(l1, s.inboxAddress, s.fpc.fpcAddress, registrant, {
    rollupVersion: s.rollupVersion,
  })
  await waitForSandboxL1ToL2Message(s.wallet.node, message.messageHash, { timeoutSeconds: 120 })
  return message
}

/** Point the ContractService singleton at `pxe`; account registration follows the singleton. */
export function repointContractService(pxe: PXE) {
  ContractService.resetInstance()
  ContractService.getInstance(
    new NodeContractServiceStorage(Network.SANDBOX),
    s.wallet.node,
    pxe,
    Network.SANDBOX,
    { source: "local-ledger", oxideEnvProfile: null },
  )
}

/** An account with no tx of its own, funded with tokens: what a first sponsored tx starts from. */
export async function freshFundedUser(): Promise<{
  account: ObsidionAccount
  provider: EcdsaK256AlphaAuthProvider
  secret: Fr
}> {
  const provider = new EcdsaK256AlphaAuthProvider(
    new Fr(Fr.random().toBigInt() % Fr.MODULUS).toBuffer(),
  )
  const secret = Fr.random()
  const account = await s.wallet.createObsidionAccount(secret, provider)
  await mintTokensToPrivate(s.token, s.wallet, account.getAddress(), TRANSFER_AMOUNT * 100n, {
    from: s.admin.getAddress(),
    fee: { paymentMethod: s.sponsoredFeePaymentMethod },
  })
  return { account, provider, secret }
}
