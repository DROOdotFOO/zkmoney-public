/** The page's one composition root for sessions: the only place they read config and singletons. */
import {
  AccountStorage,
  BalanceStorage,
  ContactStorage,
  SIPADepositStore,
  TokenStorage,
  contractServiceResource,
  createOxideTeeSignerSource,
  getTokenServiceFactory,
  openDatabase,
  resolveAssetConstants,
  syncCatchUp,
  type ReadonlyStore,
  type Resource,
  type TeeSignerSource,
} from "@obsidion/front-core"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  TokenService,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import { getConfig, getContractServiceOptions } from "../config/env"
import { fleetUrl } from "../config/oxideTuple"
import { sipaProcessingObserver } from "../features/deposit/sipaProcessing"
import { getOperationStore } from "../features/operations/operations"
import { withdrawalRails } from "../features/withdraw/withdrawGateway"
import { connectFleetSigner } from "../features/token/oxideToken"
import { activeTabSince } from "./activeTabSince"
import { walletAuth } from "./auth/useAuthenticator"
import { BrowserContractServiceStorage } from "./contracts/BrowserContractServiceStorage"
import type { Namespace, SessionDeps } from "./session"
import { contactsWriteLock } from "./storage/contactsLock"
import { opfsBackend } from "./storage/walletStorage"
import { webStorage } from "./storage/WebStorageAdapter"
import { pageWallet } from "./wallet"

export const documentVisible: ReadonlyStore<boolean> = {
  get: () => document.visibilityState === "visible",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener)
    return () => document.removeEventListener("visibilitychange", listener)
  },
}

/** The page's one `Database` over the wallet database: its writes run one at a time. */
const walletDatabase = openDatabase(opfsBackend)

let oxideSource: TeeSignerSource | undefined
const oxideSigner = (): TeeSignerSource => {
  const config = getConfig()
  return (oxideSource ??= createOxideTeeSignerSource({
    l1RpcUrl: config.l1RpcUrl,
    l1Chain: config.l1Chain,
    transformEnclaveUrl: (url) => fleetUrl(config, { enclaveUrl: url }),
    connect: connectFleetSigner,
  }))
}
/**
 * The Main token's co-signer, following the manifest tuple; it shares every token's fleet signers.
 * Built when first demanded, so a session opens before the config resolves.
 */
const pageTeeSignerSource: TeeSignerSource = {
  get label() {
    return oxideSigner().label
  },
  load: () => oxideSigner().load(),
  subscribe: (onChange) => oxideSigner().subscribe?.(onChange) ?? (() => {}),
  refresh: () => oxideSigner().refresh?.(),
}

const contractServices = new WeakMap<Resource<ObsidionWallet>, Resource<ContractService>>()
/** The page's contract service over the page's wallet: it outlives every session. */
function pageContractService(wallet: Resource<ObsidionWallet>): Resource<ContractService> {
  let service = contractServices.get(wallet)
  if (!service) {
    service = contractServiceResource({
      wallet,
      get network() {
        return getConfig().network
      },
      get storage() {
        return new BrowserContractServiceStorage(getConfig().network)
      },
      get options() {
        return getContractServiceOptions()
      },
      // Every sponsored rail here pays through the ClaimFPC, which each registers itself.
      registerSponsorFpc: false,
    })
    contractServices.set(wallet, service)
  }
  return service
}

/** A v4-canonical device builds the v4-origin service (`setTokenServiceFactory`). */
async function createToken(wallet: ObsidionWallet, account: ObsidionAccount) {
  const factory = getTokenServiceFactory()
  const token = factory
    ? await factory({ wallet, account })
    : await TokenService.create(wallet, account)
  await seedTokenRow(token)
  return token
}

/** The wallet token's row, so the next cold boot names Main's cached balance before the token builds. */
async function seedTokenRow(token: TokenService) {
  const address = token.tokenAddressOrNull?.toString()
  const entry = resolveAssetConstants(getConfig().network)[WALLET_TOKEN_SYMBOL]
  const rows = TokenStorage.get(webStorage)
  if (!address || !entry || (await rows.getTokens()).some((t) => t.address === address)) return
  await rows.addToken({
    address,
    name: entry.name,
    symbol: entry.symbol,
    decimals: entry.decimals,
  })
}

export function pageSessionDeps(namespace: Namespace, handoff?: ObsidionAccount): SessionDeps {
  const wallet = pageWallet()
  return {
    namespace,
    database: walletDatabase,
    wallet,
    contractService: pageContractService(wallet),
    visible: documentVisible,
    get network() {
      return getConfig().network
    },
    get endpointScope() {
      return getConfig().nodeEndpointDigest
    },
    catchUp: syncCatchUp,
    teeSignerSource: pageTeeSignerSource,
    operations: getOperationStore(),
    get activeSince() {
      return activeTabSince()
    },
    withdrawalRails: () => withdrawalRails(getConfig()),
    sipaDeposits: SIPADepositStore.get(webStorage),
    ...(namespace.id
      ? {
          sipaObserver: sipaProcessingObserver(),
          signIn: {
            storageId: namespace.id,
            accounts: AccountStorage.get(webStorage),
            balances: BalanceStorage.get(webStorage),
            tokens: TokenStorage.get(webStorage),
            contacts: ContactStorage.get(webStorage, contactsWriteLock),
            auth: (ready: ObsidionWallet) => walletAuth(ready),
            createToken,
            handoff,
          },
        }
      : {}),
  }
}
