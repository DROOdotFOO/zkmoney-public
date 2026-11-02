/**
 * zkmoney-demo-mode-seed — writes a scenario's fixtures into the real stores, unlocks a synthetic
 * session, and stands up the two collaborators an offline browser lacks (an injected L1 wallet and
 * the L1 RPC behind it). Runs to completion before React mounts, so every hook's first read
 * already sees a populated wallet.
 *
 * Runtime gates skip external services for the demo session. Contact lookup and Share inject
 * deterministic inputs at their service boundaries; persistence and payload encoding remain real.
 */
import SCENARIO_HELP from "./demoScenarios.json"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AUTH_TYPE, EcdsaK256AlphaAuthProvider } from "@obsidion/sdk"
import {
  AccountStorage,
  BalanceStorage,
  ContactStorage,
  SIPADepositStore,
  TokenStorage,
  type SIPADepositRecord,
  type Transaction,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { getConfig } from "../config/env"
import { primeOxideDeployment, primeOxideTuple } from "../config/oxideTuple"
import { loadWalletIdentity, saveWalletIdentity } from "../features/identity/walletIdentity"
import { getAuthService } from "../platform/auth/useAuthenticator"
import { WebPasskeyIdentityMap } from "../platform/auth/WebPasskeyIdentityMap"
import { activateTab } from "../platform/storage/activeTab"
import { contactsWriteLock } from "../platform/storage/contactsLock"
import { WebStorageAdapter, WEB_STORAGE_PREFIX } from "../platform/storage/WebStorageAdapter"
import { deviceStorage } from "../platform/storage/rollupStorage"
import { walletStorage } from "../platform/storage/walletStorage"
import { activeNamespace, session, switchSession } from "../platform/session"
import {
  disableDemoMode,
  DEMO_DEFAULT_SCENARIO,
  DEMO_SCENARIOS,
  type DemoScenario,
} from "./demoFlag"
import {
  activityDeposits,
  demoClaimFragments,
  demoContacts,
  demoRequests,
  demoTransactions,
  demoWithdrawals,
  recoveryDeposits,
  DEMO_BALANCE_RAW,
  DEMO_COMPLETE_ADDRESS,
  DEMO_CREDENTIAL_ID,
  DEMO_HANDLE,
  DEMO_L2_ADDRESS,
  DEMO_L2_TOKEN,
  DEMO_MSK_HEX,
  DEMO_NETWORK_ID,
  DEMO_OXIDE_DEPLOYMENT,
  DEMO_OXIDE_TUPLE,
  DEMO_PASSKEY_PUBKEY_HEX,
  DEMO_SIGNING_KEY_HEX,
} from "./demoFixtures"
import { longDemoContacts } from "./contactDemo"
import { installFakeEthereum } from "./fakeEthereum"
import { createL1RpcHandler, installL1RpcStub, registerDemoSipaPrediction } from "./fakeL1Rpc"

/**
 * Demo mode owns this origin's wallet state — seeding on top of whatever is there would duplicate
 * contacts and interleave two accounts' history. Scoped to the keys the wallet itself writes.
 */
async function resetWalletStorage(): Promise<void> {
  // Both prefixes: front-core's stores go through the adapter, while the identity record and the
  // session are written directly.
  await walletStorage.commitRemoveUnder(WEB_STORAGE_PREFIX)
  await walletStorage.commitRemoveUnder("webwallet.")
  // A hidden-balance pref left behind would blank the seeded figure.
  deviceStorage.removeItem("webwallet.hide-balances")
}

/**
 * An unlocked session without a passkey: `commitSecret` installs the master key and a signing
 * provider in memory, which is exactly what a completed passkey ceremony leaves behind — so
 * `getSecretKey()` (and the stealth-key derivation the recovery flow runs on it) answers normally.
 * The breadcrumb + identity record are what the wallet route gate reads.
 */
async function seedIdentity(rpId: string): Promise<void> {
  await getAuthService().commitSecret({
    secretKey: Fr.fromHexString(DEMO_MSK_HEX),
    authProvider: new EcdsaK256AlphaAuthProvider(Buffer.from(DEMO_SIGNING_KEY_HEX, "hex")),
  })
  await new WebPasskeyIdentityMap(new WebStorageAdapter(), rpId).upsert({
    credentialId: DEMO_CREDENTIAL_ID,
    l2Address: DEMO_L2_ADDRESS,
    pubkey: DEMO_PASSKEY_PUBKEY_HEX,
    isMskRoot: true,
  })
  await AccountStorage.get(new WebStorageAdapter()).setAccount({
    name: DEMO_HANDLE,
    completeAddress: DEMO_COMPLETE_ADDRESS,
    signKeyConfig: {
      type: AUTH_TYPE.WEB_AUTHN,
      webauthnData: { credentialId: DEMO_CREDENTIAL_ID, pubkey: DEMO_PASSKEY_PUBKEY_HEX },
    },
  })
  await saveWalletIdentity({ handle: DEMO_HANDLE, address: DEMO_L2_ADDRESS, claimedAt: Date.now() })
}

/** Token row + scoped balance record — the pair the balances store reads the home figure from. */
async function seedBalance(networkType: string, balance: bigint): Promise<void> {
  const adapter = new WebStorageAdapter()
  await TokenStorage.get(adapter).addToken({
    address: DEMO_L2_TOKEN,
    name: WALLET_TOKEN_SYMBOL,
    symbol: WALLET_TOKEN_SYMBOL,
    decimals: 18,
  })
  await BalanceStorage.get(adapter).updateBalance(
    `${networkType}:${DEMO_COMPLETE_ADDRESS}`,
    DEMO_L2_TOKEN,
    balance,
  )
}

async function seedDeposits(records: SIPADepositRecord[]): Promise<void> {
  const store = SIPADepositStore.get(new WebStorageAdapter())
  for (const record of records) {
    const { sipaAddress, phase, ...rest } = record
    await store.upsert(sipaAddress, { ...rest, phase }, { ...rest, networkId: DEMO_NETWORK_ID })
    // Teach the fake Registry this fixture's CREATE2 answer — the self-sweep refuses to deploy
    // unless `predictSIPA` reproduces the record's own address.
    registerDemoSipaPrediction(record.recipientHash, sipaAddress)
  }
}

async function seedWithdrawals(records: WithdrawalRecord[]): Promise<void> {
  const store = session().withdrawals
  for (const record of records) await store.create({ ...record, networkId: DEMO_NETWORK_ID })
}

/** Past-dated history, written as the rows themselves so every fixture keeps its own time. */
async function seedTransactions(rows: Transaction[]): Promise<void> {
  const { activity } = session()
  for (const row of rows) await activity.insertPending({ ...row, networkId: DEMO_NETWORK_ID })
}

async function seedContactsAndRequests(
  now: number,
  networkId: string,
  longContacts = false,
): Promise<void> {
  const adapter = new WebStorageAdapter()
  // Constructed with the same lock App.tsx passes, so its later `get()` adopts this instance
  // rather than one that silently lost the cross-tab mutex.
  const contacts = ContactStorage.get(adapter, contactsWriteLock)
  await contacts.initialize()
  await contacts.addEntries(longContacts ? longDemoContacts() : demoContacts())
  const { requests } = session()
  for (const request of demoRequests(now, networkId)) await requests.add(request)
}

/**
 * What this origin already holds, named for the refusal message — or null when it holds nothing
 * but the demo's own prior seed. Both halves of the app's onboarded definition count: the claimed
 * handle AND the breadcrumb of a passkey that opens it. An onboarding that died between the two
 * leaves only the breadcrumb, and the passkey behind it is still a real account key.
 */
async function foreignWalletState(rpId: string): Promise<string | null> {
  const identity = loadWalletIdentity()
  if (identity && identity.address !== DEMO_L2_ADDRESS) {
    return `a wallet identity ("${identity.handle}")`
  }
  const opening = await new WebPasskeyIdentityMap(new WebStorageAdapter(), rpId).getOpeningRecord()
  if (opening && opening.l2Address !== DEMO_L2_ADDRESS) return "a passkey for another account"
  return null
}

/** Every URL query demo mode understands, keyed off the scenario list so the two cannot drift. */
function demoHelp(): string {
  const rows: [string, string][] = [
    ...DEMO_SCENARIOS.map((name): [string, string] => [
      `?demo=${name}`,
      SCENARIO_HELP[name] ?? "(no description)",
    ]),
    ["?demo", `same as ?demo=${DEMO_DEFAULT_SCENARIO}`],
    ["?demo=off", "leave demo mode (clears the sessionStorage latch)"],
  ]
  const width = Math.max(...rows.map(([query]) => query.length))
  const lines = rows.map(([query, what]) => `  ${query.padEnd(width)}  ${what}`)
  return [
    "[demo] URL queries:",
    ...lines,
    "  The scenario is latched in sessionStorage, so in-app navigation keeps it.",
  ].join("\n")
}

/** Seeds the scenario; false when this origin holds a real wallet and was left untouched. */
export async function seedDemo(scenario: DemoScenario): Promise<boolean> {
  const config = getConfig()
  // Never replace a real wallet. Only an origin with no wallet state — or one holding the demo's
  // own from a prior seed — may be seeded; anything else refuses and boots the real app.
  const foreign = await foreignWalletState(config.rpId)
  if (foreign) {
    console.error(
      `[demo] refusing to seed: this origin already holds ${foreign}. ` +
        "Demo mode replaces the origin's wallet state — use a browser profile without a wallet. " +
        "Booting the real app.",
    )
    disableDemoMode()
    return false
  }

  // Demo mode runs no active-tab lifecycle, so the seed marks this page as the active tab.
  activateTab()
  const now = Date.now()
  console.info(`[demo] seeding scenario "${scenario}" — this origin's wallet state is replaced`)
  console.info(demoHelp())

  await resetWalletStorage()
  primeOxideTuple(config, DEMO_OXIDE_TUPLE)
  primeOxideDeployment(config, DEMO_OXIDE_DEPLOYMENT)
  switchSession(activeNamespace())
  // Onboarding uses mockOnboarding's local transitions and starts without an identity or provider.
  // Its token lists still read the table.
  if (scenario === "onboarding") {
    installL1RpcStub(config.l1RpcUrl, createL1RpcHandler(config.l1ChainId))
    return true
  }
  installL1RpcStub(config.l1RpcUrl, installFakeEthereum(config.l1ChainId))

  await seedIdentity(config.rpId)
  await seedBalance(config.network, scenario === "empty" ? 0n : DEMO_BALANCE_RAW)

  if (scenario === "recovery") {
    await seedDeposits(recoveryDeposits(now))
    await seedTransactions(demoTransactions(now).slice(0, 2))
  }
  if (["activity", "contacts", "contact-search", "share-retry", "share-long"].includes(scenario)) {
    await seedContactsAndRequests(
      now,
      config.network,
      scenario === "contacts" || scenario === "contact-search",
    )
    await seedTransactions(demoTransactions(now))
    await seedWithdrawals(demoWithdrawals(now))
    await seedDeposits(activityDeposits(now))
    const claims = demoClaimFragments()
    console.info(
      `[demo] claimable paylinks:\n  direct: /link#${claims.direct}\n  email:  /link#${claims.email}`,
    )
  }
  return true
}
