import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"
import { onePasswordCreate, otherCreate } from "../../support/passkeyExtensionStubs"
import { shortL1Addr } from "../../../src/ui/format"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import type { SignInRoute } from "@obsidion/core/types"
import { AccountStorage, PendingRegistrationStore, SIPADepositStore } from "@obsidion/front-core"
import {
  beginTicketSignupAccount,
  completeTicketSignupAccount,
  isTicketSignupCreating,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../../../src/features/paylink/ticketSignupAccount"
import type { GateOptions } from "../../../src/features/identity/ceremonyGate"
import { setActiveCredentialId } from "../../../src/platform/storage/activeStorage"
import { askedTotal } from "../../../src/features/onboarding/registrationAsk"
import { PAID, PAID_ASK, RANDOM, RANDOM_ASK } from "../../support/registrationPrices"
import { PAY_PRICE } from "../../../src/features/onboarding/ChooseNameSheet"
import {
  DEPOSIT_TERMS_PENDING,
  formatDepositAmount,
  formatDepositDue,
  formatDepositSeen,
} from "../../../src/features/onboarding/steps/DepositTermsRows"
import {
  CHAIN_READ_RETRIES,
  CHAIN_READ_RETRY_MS,
} from "../../../src/features/onboarding/registrationTerms"
import { REGISTRATIONS_PAUSED_NOTICE } from "../../../src/features/onboarding/onboardingErrorCopy"
import type { PendingRegistrationRecord } from "@obsidion/front-core"
import type { Hex } from "viem"
import type {
  LaptopCreation,
  PasskeyRequestScope,
  PhoneReach,
  SignUpChoice,
} from "@obsidion/passkey-web"
import {
  type HeldRequest,
  pageHide,
  passkeyEvents,
  passkeyTelemetryHarness,
} from "../../support/passkeyTelemetryHarness"
import { testWalletDbs } from "../../support/fakeWalletDb"
import { peekPreBootCreate, setPreBootCreate } from "../../../src/ui/preBootTaps"
import {
  earnedTerms,
  nameClaim,
  pendingRecord,
  resetRegistrationStores,
} from "../../support/registrationFixtures"

const ACCOUNT = "0x00000000000000000000000000000000000000aa"
const NAME_HASH = `0x${"77".repeat(32)}` as Hex
const L2_ADDRESS = `0x${"cd".repeat(32)}` as Hex

const h = vi.hoisted(() => ({
  /** The pending deposit's processing state, as the observer reports it; none unless a test sets one. */
  processing: { current: undefined as unknown },
  /** One observer object, like the production singleton. */
  observer: {
    stateFor: () => h.processing.current,
    capacityKeyFor: () => ({ status: "unknown", retryable: false }),
    subscribe: () => () => {},
    retry: async () => undefined,
    refreshForSweep: async () => undefined,
  },
  navigate: vi.fn(),
  reloadIfSessionSwitched: vi.fn(() => false),
  prepareRefund: vi.fn(),
  recoverDeposit: vi.fn(),
  fireEvent: vi.fn(),
  showReportableError: vi.fn(),
  getClaimStatus: vi.fn(),
  claimTag: vi.fn(),
  collectOnboardingKeys: vi.fn(),
  reusePasskeyAccount: vi.fn(),
  buildRetrySignDeps: vi.fn(),
  routeGrantIsCurrent: vi.fn(async () => true),
  drawTag: vi.fn(async () => ({
    tag: "brisk-otter",
    nameHash: `0x${"d7".repeat(32)}`,
    grantToken: "draw-token",
    expiresAt: 0,
  })),
  runDetectionTick: vi.fn(),
  buildWebDetectionDeps: vi.fn(),
  createAccount: vi.fn(),
  getAuthService: vi.fn(),
  claimSponsoredLink: vi.fn(async () => "0xclaim"),
  prewarmGoldenTicket: vi.fn(),
  viewLink: vi.fn(),
  obtainEmailClaimProof: vi.fn(),
  paylinkDeps: { wallet: true } as { wallet: boolean } | undefined,
  /** The session's signing account, as a host inside the wallet has it. */
  obsidionAccount: { getAddress: () => ({ toString: () => "0xacc" }) } as object | undefined,
  gateHook: () => ({
    gate: async (_options?: unknown) => ({
      signal: new AbortController().signal,
      reach: "unknown" as PhoneReach,
    }),
    state: { kind: "idle" },
    cancel: () => {},
    dismiss: () => {},
  }),
  realNavigation: false,
  hasRootBreadcrumb: true,
  useRealLandingStep: false,
  asked: true,
  // Optional, so a test can render with a wallet that has not booted yet.
  aztec: { obsidionWallet: { wallet: true } } as { obsidionWallet?: { wallet: boolean } },
  config: {
    network: "testnet",
    l1ChainId: 11155111,
    l1RpcUrl: "http://127.0.0.1:8545",
    accountServiceUrl: "http://127.0.0.1:5060",
    accountServiceTestMode: false,
    /** Empty by default: a bare visit only leaves for a campaign a build actually names. */
    campaignUrl: "" as string | undefined,
    rpId: "localhost",
    rpName: "zk.money",
    l1Chain: { name: "Sepolia" },
    oxideProfile: { portal: "0x" + "11".repeat(20) },
  },
  /** What the fake registry answers for REGISTRATION_MIN / REGISTRATION_FEE. */
  amounts: { min: 0n, fee: 0n },
  /** Set to make the schedule read fail instead of answering `amounts`. */
  scheduleFails: false,
  /** How many times the controller's schedule was actually read. */
  scheduleReads: 0,
  skim: 0n,
  /** What the fake token answers for balanceOf(sipa). */
  balance: 0n,
  /** Holds balanceOf(sipa) until the test lands it. */
  balanceRead: undefined as Promise<bigint> | undefined,
  /** The oxide tuple the fake manifest serves. */
  tuple: { registry: "0x00000000000000000000000000000000000000e4" } as Record<string, string>,
  l1: { account: null as string | null, walletName: null as string | null, connect: vi.fn() },
  /** The visitor page's voucher read: the link can pay its own way out. */
  voucher: {
    uses: 1 as number | undefined,
    deps: { wallet: true },
    error: undefined,
    retry: vi.fn(),
  },
  /** The network's ticket offer the visitor page reads. */
  offer: {
    offer: {
      threshold: "2000000000000000000",
      schedule: { fee: "500000000000000000", minDeposit: "0" },
    },
    failed: false,
    retry: vi.fn(),
  },
}))

// The executor's withdrawal fee is priced in its own suites; here it costs nothing.
vi.mock("../../../src/features/withdraw/withdrawalFee", () => ({
  withdrawalExecutorFee: async () => 0n,
  activeWithdrawalFee: async () => 0n,
  activeWithdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutor: async () => ({ fee: 0n }),
  withdrawalExecutorAt: async () => ({ fee: 0n }),
  useActiveWithdrawalFee: () => 0n,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>()
  return {
    ...actual,
    // Records every call; forwards to the real router when a test opts in.
    useNavigate: () => {
      const real = actual.useNavigate()
      return ((...args: unknown[]) => {
        ;(h.navigate as (...a: unknown[]) => void)(...args)
        if (h.realNavigation) (real as (...a: never[]) => unknown)(...(args as never[]))
      }) as ReturnType<typeof actual.useNavigate>
    },
  }
})
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  // The create's own arguments, past the wallet and auth service it runs over.
  createAccount: (_deps: unknown, ...args: unknown[]) => h.createAccount(...args),
  useScreener: () => ({ screen: async () => ({ compliant: true }) }),
  useContractServiceContext: () => ({ contractService: { service: true } }),
  useConfigValue: () => ({ value: h.asked, setValue: vi.fn() }),
}))
vi.mock("../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/env")>()),
  getConfig: () => h.config,
}))
// Availability has its own suite. Pending-registration walks start with a claimable tag, so keep
// their tag step independent of the probe's debounce and network response.
vi.mock("../../../src/features/onboarding/nameAvailability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/nameAvailability")>()),
  routeGrantIsCurrent: h.routeGrantIsCurrent,
  drawTag: h.drawTag,
  useNameAvailability: () => ({ status: "available" as const, checking: false }),
}))
vi.mock("../../../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/platform/auth/WebPasskeyIdentityMap")>()),
  hasOpeningBreadcrumb: () => h.hasRootBreadcrumb,
}))
vi.mock("../../../src/features/onboarding/registrationTerms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/registrationTerms")>()),
  // A disabled read never lands, as in the real hooks.
  useDepositSkim: (_config: unknown, enabled = true) => (enabled ? h.skim : undefined),
}))
vi.mock("../../../src/lib/analytics", () => ({
  fireEvent: h.fireEvent,
  fireOnboardingEvent: h.fireEvent,
  reportLanding: vi.fn(),
  lapTimer: () => () => 0,
  failureCode: () => "err",
}))
vi.mock("../../../src/errors/errorModal", () => ({ showReportableError: h.showReportableError }))
vi.mock("../../../src/features/onboarding/registrationQuoteRecovery", async (original) => ({
  ...(await original<object>()),
  prepareRegistrationRefund: h.prepareRefund,
}))
vi.mock("../../../src/features/deposit/sipaProcessing", async (original) => ({
  ...(await original<object>()),
  useSipaProcessing: () => ({ state: h.processing.current, shown: h.processing.current }),
  sipaProcessingObserver: () => h.observer,
}))
vi.mock("../../../src/features/deposit/sipaRecovery", async (original) => ({
  ...(await original<object>()),
  recoverDeposit: h.recoverDeposit,
}))
vi.mock("../../../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => h.l1,
  getL1Clients: vi.fn(),
}))
vi.mock("../../../src/ui/screening", () => ({
  ScreeningNotice: () => null,
  useScreenedAddress: () => ({ verdict: null, cleared: true, rescreen: vi.fn() }),
}))
vi.mock("../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: h.getAuthService,
  peekAuthService: h.getAuthService,
}))
// The ceremony gate has its own suite; here it is whatever `h.gateHook` says, a pass-through by
// default so the step walks never wait at the phone steps.
vi.mock("../../../src/features/identity/ceremonyGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/identity/ceremonyGate")>()),
  useCeremonyGate: () => {
    // The real hook re-renders its screen when a gate opens; the stub does the same so a test's
    // swapped state is picked up.
    const [, rerender] = React.useReducer((n: number) => n + 1, 0)
    const hook = h.gateHook()
    return {
      ...hook,
      gate: (options?: unknown) => {
        const pending = hook.gate(options)
        rerender()
        return pending
      },
    }
  },
}))
// The DS drags in liquid-glass optics jsdom can't render; these tests are about surface + wiring.
// Fake fragments never decode; the binding only needs a stable name for one.
vi.mock("../../../src/features/paylink/linkIdentity", () => ({
  linkIdentity: (fragment: string) => `id:${fragment}`,
}))
vi.mock("@obsidion/web-ds", () => ({
  DoubleCheckIcon: () => null,
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PrimaryGradientButton: ({
    title,
    testId,
    onClick,
    isDisabled,
    buttonStyle,
  }: {
    title: string
    testId?: string
    onClick?: () => void
    isDisabled?: boolean
    buttonStyle?: string
  }) => (
    <button data-testid={testId} data-style={buttonStyle} disabled={isDisabled} onClick={onClick}>
      {title}
    </button>
  ),
  TextField: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange?: (value: string) => void
    placeholder?: string
  }) => (
    <input placeholder={placeholder} value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
  GradientHeroCard: ({
    title,
    subtitle,
    footer,
    avatar,
  }: {
    title?: React.ReactNode
    subtitle?: React.ReactNode
    footer?: React.ReactNode
    avatar?: React.ReactNode
  }) => (
    <div>
      {avatar}
      {title}
      {subtitle}
      {footer}
    </div>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  GradientSpinner: () => <span>spinner</span>,
  ConfirmationSheetDetailRow: ({
    label,
    value,
  }: {
    label: React.ReactNode
    value: React.ReactNode
  }) => (
    <div>
      {label}
      {value}
    </div>
  ),
  Spinner: () => <span aria-label="Loading" />,
  IconCircle: () => null,
  AuroraBackground: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TopNavIconButton: ({
    onClick,
    ariaLabel,
    testId,
    disabled,
  }: {
    onClick?: () => void
    ariaLabel?: string
    testId?: string
    disabled?: boolean
  }) => (
    <button aria-label={ariaLabel} data-testid={testId} disabled={disabled} onClick={onClick}>
      x
    </button>
  ),
  NumberedStepRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../src/features/onboarding/InvitationChrome", () => ({
  InvitationChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("../../../src/features/onboarding/steps/InvitationStep", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/features/onboarding/steps/InvitationStep")
  >()
  return {
    InvitationStep: (props: Parameters<typeof actual.InvitationStep>[0]) =>
      h.useRealLandingStep ? (
        <actual.InvitationStep {...props} />
      ) : (
        <div>
          <span data-testid="invite-probe">{String(props.checkAvailability)}</span>
          <button onClick={() => props.onUnlock("taga")}>landing-signin</button>
          {props.notice && (
            <span>
              {props.notice.kind === "taken"
                ? `taken:${props.notice.handle}`
                : props.notice.message}
            </span>
          )}
        </div>
      ),
  }
})
vi.mock("../../../src/features/onboarding/steps/ClaimTagModal", () => ({
  ClaimTagModal: ({
    busy,
    onClaim,
    onCancel,
    error,
  }: {
    busy: boolean
    onClaim: () => void
    onCancel: () => void
    error?: string
  }) => (
    <div>
      {busy ? "claim-modal-busy" : "claim-modal"}
      {error && <span>{error}</span>}
      <button onClick={onClaim}>claim-tag</button>
      <button onClick={onCancel}>cancel-op</button>
    </div>
  ),
  AllSetModal: () => <div>all-set</div>,
}))
vi.mock("../../../src/features/onboarding/sessionReload", () => ({
  reloadIfSessionSwitched: h.reloadIfSessionSwitched,
}))
vi.mock("../../../src/features/onboarding/webRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/webRegistration")>()),
  buildWebDetectionDeps: h.buildWebDetectionDeps,
  runDetectionTick: h.runDetectionTick,
}))
vi.mock("../../../src/features/onboarding/oxideOnboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/oxideOnboarding")>()),
  getClaimStatus: h.getClaimStatus,
  claimTag: h.claimTag,
  collectOnboardingKeys: h.collectOnboardingKeys,
  reusePasskeyAccount: h.reusePasskeyAccount,
  buildRetrySignDeps: h.buildRetrySignDeps,
}))
// The tag step's warm-up loads the prover and reads the chain; here it is only observed.
vi.mock("../../../src/features/onboarding/goldenTicket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/onboarding/goldenTicket")>()),
  prewarmGoldenTicket: h.prewarmGoldenTicket,
}))
vi.mock("../../../src/features/paylink/sponsoredPaylink", () => ({
  claimSponsoredLink: h.claimSponsoredLink,
  viewLink: h.viewLink,
}))
vi.mock("../../../src/features/paylink/emailClaim", () => ({
  obtainEmailClaimProof: h.obtainEmailClaimProof,
}))
// The paylink services reach the wizard through its host (`PaylinkOnboardingScreen`), so the
// /claim renders below pass them as that host would.
vi.mock("../../../src/features/paylink/usePaylinkDeps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/paylink/usePaylinkDeps")>()),
  usePaylinkKit: () => h.paylinkDeps,
  useLinkVoucher: () => h.voucher,
}))
vi.mock("../../../src/features/paylink/chainTime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/paylink/chainTime")>()),
  latestChainSeconds: async () => 1_000,
}))
vi.mock("../../../src/features/paylink/goldenTicketOffer", () => ({
  useGoldenTicketOffer: () => h.offer,
}))
/** The tip the split decides; its quote and decision have a suite of their own. */
const splitTip = vi.hoisted(() => ({ value: (10n ** 18n) as bigint | undefined }))
vi.mock("../../../src/features/paylink/registrationProverTip", async () => {
  const { useEffect } = await import("react")
  return {
    useRegistrationSpeed: ({
      active,
      onCommit,
    }: {
      active: boolean
      onCommit: (tip: bigint, speed: string) => void
    }) => {
      const tip = active ? splitTip.value : undefined
      useEffect(() => {
        if (tip !== undefined) onCommit(tip, "faster")
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tip])
      return {
        choice: {
          loading: false,
          speed: "faster",
          setSpeed: () => {},
          settled: false,
          pricedTip: 0n,
        },
        outcome: { proverTip: 0n },
        proverTip: tip,
        settle: () => {
          if (active && tip === undefined) onCommit(0n, "standard")
        },
      }
    },
  }
})
// The registration's table lists only the fixtures' deposit token.
vi.mock("../../../src/features/deposit/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts, singleToken } = await import("../../support/depositTokens")
  return mockLoadDepositFacts(importOriginal, () =>
    singleToken("0x00000000000000000000000000000000000000d4"),
  )
})
// The real buildRetrySignDeps (below) fetches the registration env; stub it so the unit test needs
// no L1. The tuple carries portal/sipaFactory/token/accountMetadataRegistry so the SIPA deriver
// constructs offline.
vi.mock("../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/oxideTuple")>()),
  getOxideTuple: vi.fn(async () => h.tuple),
  l1PublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "REGISTRATION_MIN"
        ? (h.scheduleReads++,
          h.scheduleFails ? Promise.reject(new Error("rpc down")) : h.amounts.min)
        : functionName === "REGISTRATION_FEE"
        ? h.amounts.fee
        : functionName === "depositFee"
        ? 0n
        : h.balanceRead ?? h.balance,
  }),
  oxideEnvFor: vi.fn(async () => ({
    tuple: {
      portal: "0x00000000000000000000000000000000000000e1",
      token: "0x00000000000000000000000000000000000000e3",
      registry: "0x00000000000000000000000000000000000000e4",
      accountMetadataRegistry: "0x00000000000000000000000000000000000000e8",
      sipaFactory: "0x00000000000000000000000000000000000000e7",
      forwardingTable: "0x00000000000000000000000000000000000000e9",
      rollupVersion: "3",
      ensDomain: "zk.money",
    },
    env: {
      registry: "0x00000000000000000000000000000000000000e4",
      factory: "0x00000000000000000000000000000000000000e5",
      ensDomain: "zk.money",
      resolverOperator: "0x00000000000000000000000000000000000000e6",
      rollupVersion: 3n,
      l1ChainId: 11155111,
      feeToken: "0x00000000000000000000000000000000000000e3",
      namePortalRecipient: `0x${"00".repeat(32)}`,
    },
    publicClient: {},
  })),
}))

const { OnboardingScreen } = await import("../../../src/features/onboarding/OnboardingScreen")
const { PaylinkVisitorScreen } = await import("../../../src/features/paylink/PaylinkVisitorScreen")
const { activeNamespace, closeSession, session } = await import("../../../src/platform/session")
const { valueOf } = await import("@obsidion/front-core")
/** The account a sign-in handed the session, or the one it started with. */
const sessionAccount = () => valueOf(session().account!)
const pageModules = async () => ({
  support: await import("../../support/session"),
  core: await import("@obsidion/front-core"),
})
const firstPage = await pageModules()
/**
 * The session as a host inside the wallet has it: the page's wallet up and an account signed in,
 * which a sign-in replaces. A fresh page load passes its own modules.
 */
async function openHostSession(modules = firstPage) {
  const { openTestSession } = modules.support
  const { accountResource, resource } = modules.core
  const open = openTestSession({ wallet: h.aztec.obsidionWallet })
  const account = accountResource({
    wallet: resource<[], ObsidionWallet>(
      "wallet",
      { from: [], lazy: true, backoff: "manual" },
      async () => undefined,
    ),
    contractService: resource<[], ContractService>(
      "contractService",
      { from: [], lazy: true, backoff: "manual" },
      async () => undefined,
    ),
    accounts: { getAccount: async () => undefined, setAccount: async () => {} },
    auth: () => ({} as never),
    handoff: h.obsidionAccount as never,
  })
  Object.defineProperty(open, "account", { configurable: true, value: account })
}
beforeEach(() => openHostSession())
afterEach(closeSession)
const { LostRegistrationNoticeCard } = await import(
  "../../../src/features/onboarding/LostRegistrationNoticeCard"
)
const { applyIdentityOutcome, getPendingStore } = await import(
  "../../../src/features/onboarding/webRegistration"
)
const { provideFakeDepositRail } = await import("../../support/fakeDepositRail")
const { NameTakenError, PasskeyMismatchError } = await import(
  "../../../src/features/onboarding/oxideOnboarding"
)
// Bound before a test resets modules, so it is the class the screen's refusal check knows.
const {
  PhoneRequiredError: ScreenPhoneRequiredError,
  LaptopPasskeyRefusedError: ScreenLaptopRefusedError,
  PHONE_STEPS_COPY,
  markPasskeyWritten,
  recordRequestHeld,
  routeForChoice,
} = await import("@obsidion/passkey-web")
const realOxideOnboarding = await vi.importActual<
  typeof import("../../../src/features/onboarding/oxideOnboarding")
>("../../../src/features/onboarding/oxideOnboarding")
const { upgradeLock } = await import("../../../src/features/migration/upgradeLock")
const { loadWalletIdentity, saveWalletIdentity } = await import(
  "../../../src/features/identity/walletIdentity"
)
const { clearNameGrant } = await import("../../../src/features/onboarding/nameGrant")
const { ticketSignupContinuation } = await import(
  "../../../src/features/paylink/ticketContinuation"
)
const { loadRegistrationTerms, saveRegistrationTerms } = await import(
  "../../../src/features/onboarding/registrationTerms"
)
const { GateCancelledError } = await import("../../../src/features/identity/ceremonyGate")
const { getBroadcastLedger, resetBroadcastsForTests } = await import(
  "../../../src/features/broadcasts/broadcasts"
)
const { userFlowActive } = await import("../../../src/features/provingGate")
const { CLAIM_STASH_KEY, TICKET_STASH_KEY, stashTicketSignup, updateTicketSignup } = await import(
  "../../../src/features/paylink/claimStash"
)
const { firstWalletEntry } = await import("../../../src/features/onboarding/walletEntry")
const { isClaimRunning } = await import("../../../src/features/paylink/runningClaims")
const { getOperationStore } = await import("../../../src/features/operations/operations")
const { provingProgress } = await import("@obsidion/proving-progress")

const fakeAccount = {
  getAuthProvider: () => ({}),
  getAddress: () => ({ toString: () => L2_ADDRESS }),
  getCompleteAddress: () => ({ toString: () => L2_ADDRESS }),
}
const fakeKeys = {
  account: fakeAccount,
  secretKey: { toString: () => `0x${"11".repeat(32)}` },
  authProvider: {},
  pubkeyHex: `0x${"22".repeat(64)}`,
}
const CLAIM = nameClaim()
const WAIVED_CLAIM = nameClaim({ terms: earnedTerms({ minDeposit: "0" }) })

let container: HTMLDivElement
let root: Root

const baseRecord = (over: Partial<PendingRegistrationRecord> = {}) =>
  pendingRecord({ account: ACCOUNT, nameHash: NAME_HASH, l2Address: L2_ADDRESS, ...over })

const seedRecord = (over: Partial<PendingRegistrationRecord> = {}) =>
  getPendingStore().upsert(ACCOUNT, {}, baseRecord(over))

/** The reduced schedule an earned tag signs: the tag price waived, the relayer's 0.5 cut kept. */
const REDUCED_FEE = String(RANDOM.fee)
/** The reduced schedule a waived claim carries. */
const TERMS = earnedTerms({ fee: REDUCED_FEE, minDeposit: String(RANDOM.min) })

/** A live claim the service signed without a schedule — the one state the controller prices. */
const unsignedTerms = () =>
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    feeWaived: false,
  })

/** A live reservation whose fee the campaign waived — the only state that may log out. */
const waivedTerms = () =>
  saveRegistrationTerms({
    account: ACCOUNT,
    tag: "taga",
    deadline: Math.floor(Date.now() / 1000) + 7200,
    fee: REDUCED_FEE,
    minDeposit: String(10n * 10n ** 18n),
    feeWaived: true,
  })

/** Props the host passes; the visitor page's ticket signup sets `ticketSignup`. */
let screenProps: { ticketSignup?: boolean } = {}
afterEach(() => {
  screenProps = {}
})

const render = (path = "/claim", Screen = OnboardingScreen) =>
  act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/claim/:handle?"
            element={<Screen {...screenProps} paylinkKit={h.paylinkDeps as never} />}
          />
        </Routes>
      </MemoryRouter>,
    )
  })

const buttons = () => Array.from(container.querySelectorAll("button"))
/** The "Check again" text button under the address — the step's manual check. */
const checkControl = () => buttons().find((b) => b.textContent === "Check again") ?? null
const clickCheck = () =>
  act(async () => {
    const target = checkControl()
    if (!target) throw new Error("no check control beside the address")
    target.click()
  })
const button = (label: string) => buttons().find((b) => b.textContent === label)
/** The terms CTA carries the quote ("Deposit $11.00"), so the walks click it by its verb. */
const clickDeposit = () =>
  act(async () => {
    const target = buttons().find((b) => b.textContent?.startsWith("Deposit"))
    if (!target) throw new Error(`no Deposit button — have: ${buttons().map((b) => b.textContent)}`)
    target.click()
  })
/** The golden ticket tag step's CTA carries the tag and the amount, so walks click it by its verb. */
const clickClaimTag = () =>
  act(async () => {
    const target = buttons().find((b) => b.textContent?.startsWith("Claim @"))
    if (!target) throw new Error(`no claim button — have: ${buttons().map((b) => b.textContent)}`)
    target.click()
  })
/** The hand-off's no-tap attempt settles; with no material the spinner gives way to the terms sheet. */
const click = (label: string) =>
  act(async () => {
    const target = button(label)
    if (!target) {
      throw new Error(`no button "${label}" — have: ${buttons().map((b) => b.textContent)}`)
    }
    target.click()
  })

/** Lets the async registry amounts read land. */
const settleReads = () => act(async () => new Promise((r) => setTimeout(r, 0)))
/** The wizard ends by entering the wallet; Home shows what the account still owes. */
const enteredWallet = () => (h.navigate.mock.calls as unknown[][]).some(([to]) => to === "/")

/** One deposit-terms figure, by row, with no sentence around it. */
const termsValue = (id: string) =>
  container.querySelector(`[data-testid="deposit-terms-${id}"]`)?.textContent ?? undefined
const summary = () =>
  container.querySelector('[data-testid="registration-sheet-summary"]')?.textContent ?? ""
const paused = () =>
  container.querySelector('[data-testid="registrations-paused"]')?.textContent ?? ""
/** Amounts are built from the same formatters the screen prices with, never from its sentences. */
const decimals = () => tokenDecimalsForNetwork(h.config.network as never)
const usd = (amount: bigint) => formatDepositAmount(amount, decimals())
/** A deposit the screen asks for, rounded the way it asks. */
const due = (amount: bigint) => formatDepositDue(amount, decimals())
/** An amount already at the address. */
const seen = (amount: bigint) => formatDepositSeen(amount, decimals())
const ask = (kind: "standard" | "earned_tag") => due(askedTotal(kind))

beforeEach(async () => {
  h.processing.current = undefined
  vi.clearAllMocks()
  h.getAuthService.mockReset()
  h.reloadIfSessionSwitched.mockReset().mockReturnValue(false)
  // The asked total must come from the constants here, never from a developer's .env.local.
  vi.stubEnv("VITE_REGISTRATION_ASK_DEPOSIT_TOTAL", "")
  resetRegistrationStores()
  // The rail observes the open registration's address: what the fake token answers for it.
  provideFakeDepositRail({
    addresses: () => [getPendingStore().current()?.sipaAddress],
    held: () => h.balanceRead ?? h.balance,
    token: () => getPendingStore().current()?.depositToken as Hex | undefined,
  })
  h.prepareRefund.mockReset()
  h.recoverDeposit.mockReset()
  h.l1.account = null
  localStorage.clear()
  sessionStorage.clear()
  clearNameGrant()
  h.routeGrantIsCurrent.mockReset().mockResolvedValue(true)
  await getPendingStore().load()
  h.realNavigation = false
  h.hasRootBreadcrumb = true
  h.useRealLandingStep = false
  h.gateHook = () => ({
    gate: async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
    state: { kind: "idle" },
    cancel: () => {},
    dismiss: () => {},
  })
  h.asked = true
  h.getClaimStatus.mockResolvedValue("reserved")
  h.balance = 0n
  h.balanceRead = undefined
  h.amounts = { min: 0n, fee: 0n }
  // The sandbox relayer's cut, and what a waived schedule's whole fee is.
  h.skim = 5n * 10n ** 17n
  h.scheduleFails = false
  h.scheduleReads = 0
  h.tuple = { registry: "0x00000000000000000000000000000000000000e4" }
  h.createAccount.mockImplementation(async (...args: unknown[]) => {
    const opts = args[5] as
      | { onAccountCreated?: (created: { credentialId: string; l2Address: string }) => void }
      | undefined
    await opts?.onAccountCreated?.({ credentialId: "new-ticket-passkey", l2Address: L2_ADDRESS })
    setActiveCredentialId("new-ticket-passkey")
    return fakeAccount
  })
  h.collectOnboardingKeys.mockResolvedValue(fakeKeys)
  h.reusePasskeyAccount.mockResolvedValue(fakeKeys)
  h.buildRetrySignDeps.mockReturnValue({ sign: true })
  h.runDetectionTick.mockResolvedValue("pending")
  h.buildWebDetectionDeps.mockImplementation(async (_config: unknown, extras = {}) => ({
    ...extras,
  }))
  h.claimSponsoredLink.mockResolvedValue("0xclaim")
  h.viewLink.mockResolvedValue({ flavor: "direct" })
  h.obtainEmailClaimProof.mockResolvedValue({ vkey: [], proof: [], public_inputs: [] })
  h.paylinkDeps = { wallet: true }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("pending step — a policy refusal on retry", () => {
  it("renders the refusal in place with its own retry, never the report modal", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    await seedRecord({ broadcast: false, fundedAt: Date.now() })
    h.reusePasskeyAccount.mockRejectedValueOnce(new PhoneRequiredError())
    await render("/claim/taga")
    await click("Retry")
    const refused = container.querySelector<HTMLElement>('[data-testid="pending-refused"]')
    expect(refused?.dataset.reason).toBe("PhoneRequiredError")
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(h.fireEvent).toHaveBeenCalledWith("action_failed", {
      action: "pending_retry",
      code: "err",
    })

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="pending-retry"]')!.click(),
    )
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="pending-refused"]')).toBeNull()
  })
})

describe("pending step — a refusal another attempt cannot fix", () => {
  it("leaves Log out as the only way on, with no Retry anywhere", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    await seedRecord({ broadcast: false, fundedAt: Date.now(), startTime: Date.now() - 6 * 60_000 })
    h.reusePasskeyAccount.mockRejectedValueOnce(new RotatedCredentialError())
    await render("/claim/taga")
    await click("Retry")
    const refused = container.querySelector<HTMLElement>('[data-testid="pending-refused"]')
    expect(refused?.dataset.reason).toBe("RotatedCredentialError")
    expect(container.querySelector('[data-testid="pending-retry"]')).toBeNull()
    expect(button("Retry")).toBeUndefined()
    expect(container.querySelector('[data-testid="pending-log-out"]')).not.toBeNull()
  })

  it("closing the sheet while the held key is being adopted ends the retry", async () => {
    await seedRecord({ broadcast: false, fundedAt: Date.now() })
    waivedTerms()
    let scope: AbortSignal | undefined
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, _gate: unknown, signal: AbortSignal) => {
        scope = signal
        await new Promise(() => {})
      },
    )
    await render("/claim/taga")
    await click("Retry")
    expect(scope?.aborted).toBe(false)
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()
    await act(async () => close!.click())
    expect(scope?.aborted).toBe(true)
    expect(h.runDetectionTick).not.toHaveBeenCalled()
  })
})

describe("pending step — the whole surface pins the record's tag", () => {
  it("route handle for another tag feeds nothing: heading, urgency, prefill, and the re-publish target", async () => {
    await seedRecord({
      broadcast: false,
      fundedAt: Date.now(),
      startTime: Date.now() - 6 * 60_000,
    })
    await render("/claim/tagb")

    expect(container.textContent).toContain("@taga")
    expect(container.textContent).toContain("@taga is taking longer than usual")
    expect(container.textContent).not.toContain("tagb")

    await click("Retry")
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })
})

describe("pending step — an escalated unpublished claim keeps its retry", () => {
  it("the route Home leads to still offers Retry, and one click runs a forced tick", async () => {
    await seedRecord({ broadcast: false, retries: 3, startTime: Date.now() - 3_600_000 })
    await render("/claim/taga")
    expect(button("Retry")).toBeTruthy()
    await click("Retry")
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick.mock.calls[0][1]).toMatchObject({ force: true })
  })
})

describe("pending step — an unbroadcast claim re-publishes beside the check", () => {
  it.each([["no credential", () => new Error("Passkey assertion returned no credential")]])(
    "a missing passkey (%s) renders inline copy, never the error modal",
    async (_name, missing) => {
      await seedRecord({ broadcast: false })
      await render()
      h.reusePasskeyAccount.mockRejectedValue(missing())

      await click("Retry")
      expect(container.textContent).toContain("Couldn't find your passkey")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(h.runDetectionTick).not.toHaveBeenCalled()
    },
  )

  it("a mismatched passkey stops inline with nothing staged and no tick", async () => {
    await seedRecord({ broadcast: false })
    await render()
    h.reusePasskeyAccount.mockRejectedValue(new PasskeyMismatchError())

    await click("Retry")
    expect(container.textContent).toContain("isn't the passkey this claim was started with")
    expect(sessionAccount()).toBe(h.obsidionAccount)
    expect(h.runDetectionTick).not.toHaveBeenCalled()
    expect(h.showReportableError).not.toHaveBeenCalled()
  })
})

describe("pending step — escape, custody, and background closes", () => {
  it("a paid tag has no exit at all: mid-purchase, leaving strands it", async () => {
    await seedRecord()
    await render()
    expect(button("Start over")).toBeUndefined()
    expect(button("Log out")).toBeUndefined()
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
  })

  it("a lost race keeps terms another open record is priced by", async () => {
    // One key holds one registration's terms; the restart must not take a live one's floor with it.
    const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000ab"
    await getPendingStore().upsert(
      OTHER_ACCOUNT,
      {},
      baseRecord({ tag: "otherta", startTime: Date.now() - 60_000 }),
    )
    await seedRecord()
    saveRegistrationTerms({
      account: OTHER_ACCOUNT,
      tag: "otherta",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: REDUCED_FEE,
      minDeposit: String(10n * 10n ** 18n),
      feeWaived: true,
    })
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "failed_taken")
    })

    expect(loadRegistrationTerms(OTHER_ACCOUNT, "otherta")?.feeWaived).toBe(true)
  })

  it("a background confirm without a wallet identity steers to enter, never fabricating one", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600)
    })
    expect(h.navigate).toHaveBeenCalledWith("/enter", { replace: true })
    expect(loadWalletIdentity()).toBeNull()
  })

  it("a held tick that loses to a needs_recovery close never fabricates the identity", async () => {
    await seedRecord({ broadcast: false })
    await render()
    let release!: (outcome: "pending") => void
    h.runDetectionTick.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await click("Retry")
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)

    // A background tick settles needs_recovery while ours is held: identity retracted, record
    // closed confirmed — the ambiguous phase must never be read as a win.
    await act(async () => {
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
      applyIdentityOutcome("needs_recovery")
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => release("pending"))

    expect(loadWalletIdentity()).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/enter", { replace: true })
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
  })

  it("terminal steering lands on a claim landing whose tag input is editable", async () => {
    h.realNavigation = true
    h.useRealLandingStep = true
    await seedRecord()
    await render("/claim/taga")
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "failed_terminal")
      return "failed"
    })
    await clickCheck()

    const input = container.querySelector("input")
    expect(input).toBeTruthy()
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
      .set!
    await act(async () => {
      setValue.call(input!, "freshtag")
      input!.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("freshtag")
  })
})

describe("pending step — a resumed signup's wallet entry", () => {
  const entries = () => h.fireEvent.mock.calls.filter(([name]) => name === "wallet_entered")
  const confirmOnTick = () =>
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
      return "confirmed"
    })

  it("reports the entry once when a reloaded registration confirms", async () => {
    await seedRecord({ broadcast: false })
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")

    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    // A record names no deployment, so it never vouches that the account is current here.
    expect(upgradeLock(L2_ADDRESS).state === "released").toBe(false)
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toEqual([["wallet_entered", { entry: "link" }]])
  })

  it("a registration entered while pending sends no second entry when it confirms", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render("/claim/taga")
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
    expect(entries()).toEqual([["wallet_entered", { entry: "link" }]])

    h.navigate.mockClear()
    await act(async () => {
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600)
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toHaveLength(1)
  })

  it("resuming a registration after logging out of it is a return, not a second entry", async () => {
    await seedRecord({ broadcast: false })
    waivedTerms()
    await render("/claim/taga")
    await click("Enter now, deposit later")
    expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
    expect(entries()).toHaveLength(1)

    // Back on the pending sheet, logging out drops the identity and keeps the registration.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render("/claim/taga")
    await click("Log out")
    expect(loadWalletIdentity()).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    h.navigate.mockClear()
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(entries()).toHaveLength(1)
  })

  it("another account's entry does not hold back this account's first", async () => {
    const OTHER_L2 = `0x${"aa".repeat(32)}`
    saveWalletIdentity({ address: OTHER_L2, claimedAt: 1 })
    expect(await firstWalletEntry(OTHER_L2)).toBe(true)
    await seedRecord({ broadcast: false })
    await render("/claim/taga")
    confirmOnTick()
    await click("Retry")

    expect(entries()).toEqual([["wallet_entered", { entry: "link" }]])
  })

  it("a funded registration its deposit admits enters from two effects at once, reporting once", async () => {
    await seedRecord({ phase: "funded", fundedAt: 1, broadcast: true })
    const { recordDepositAdmission } = await import("../../../src/features/identity/admission")
    expect(recordDepositAdmission(getPendingStore().current()!, 10n ** 20n)).toBe(true)
    await render("/claim/taga")

    expect(h.navigate.mock.calls.filter(([to]) => to === "/").length).toBeGreaterThan(1)
    expect(entries()).toEqual([["wallet_entered", { entry: "link" }]])
  })

  it("a funded record whose identity save fails keeps a retry that enters once saving works", async () => {
    await seedRecord({ phase: "funded", fundedAt: 1, broadcast: true })
    let refuse = true
    let attempts = 0
    testWalletDbs().onApply = (_version, ops) => {
      if (!ops.some(([key]) => key === "webwallet.identity")) return
      attempts++
      if (refuse) throw new Error("disk")
    }
    await render("/claim/taga")
    await act(async () => {})
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
    expect(button("Retry entering wallet")).toBeDefined()
    // The failed entry is not tried again on its own.
    expect(attempts).toBe(1)

    refuse = false
    await click("Retry entering wallet")
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
    expect(loadWalletIdentity()?.handle).toBe("taga")
  })
})

describe("pending step — the status check runs itself", () => {
  it("a failed check it runs by itself waits for the next one; a failed click still reports", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seedRecord()
    await render()
    const failed = new Error("HTTP request failed.")
    h.runDetectionTick.mockRejectedValueOnce(failed)
    h.buildWebDetectionDeps.mockRejectedValueOnce(failed)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(48_050)
    })
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("Last checked")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_000)
    })
    expect(container.textContent).toContain("Last checked 0s ago")
    h.runDetectionTick.mockRejectedValueOnce(failed)
    await clickCheck()
    expect(h.showReportableError).toHaveBeenCalledWith(failed, "registration:deposit")
    warn.mockRestore()
  })

  it("a failed tick that a landed deposit nudges stays quiet", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await seedRecord()
    await render()
    h.runDetectionTick.mockRejectedValueOnce(new Error("HTTP request failed."))
    h.balance = 15n * 10n ** 18n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.showReportableError).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("pending step: the waiting block under the address", () => {
  const block = () => container.querySelector(".ww-deposit-sheet__live")
  const pill = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="deposit-check-again"]')
  const line = () => container.querySelector('[data-testid="deposit-balance"]')?.textContent
  const blockButton = (label: string) =>
    Array.from(block()?.querySelectorAll("button") ?? []).find((b) => b.textContent === label)

  it("waits with the balance at the address, and the pill runs the step's check", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    expect(block()!.textContent).toContain("Waiting for deposit")
    expect(line()).toBe(`Balance at this address: ${seen(0n)}`)
    expect(blockButton("Retry")).toBeUndefined()
    const calls = h.runDetectionTick.mock.calls.length
    await act(async () => pill()!.click())
    expect(pill()!.disabled).toBe(true)
    expect(h.runDetectionTick.mock.calls.length).toBe(calls + 1)
    expect(h.runDetectionTick.mock.calls[calls][1]).toMatchObject({ force: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(pill()!.textContent).toBe("Checked")
    expect(line()).toBe(`Balance at this address: ${seen(0n)} · Last checked 0s ago`)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(line()).toContain("Last checked 3s ago")
    expect(pill()!.textContent).toBe("Check again")
    expect(pill()!.disabled).toBe(false)
  })

  it("the pill stays busy until its read of the address lands, past the step's check", async () => {
    vi.useFakeTimers()
    await seedRecord()
    await render()
    let land!: (balance: bigint) => void
    h.balanceRead = new Promise((resolve) => (land = resolve))
    await act(async () => pill()!.click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(pill()!.disabled).toBe(true)
    expect(pill()!.textContent).toContain("Check again")
    h.balanceRead = undefined
    await act(async () => {
      land(0n)
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pill()!.disabled).toBe(false)
    expect(pill()!.textContent).toBe("Checked")
    expect(line()).toBe(`Balance at this address: ${seen(0n)} · Last checked 0s ago`)
  })
})

describe("pending step — the check control is the only affordance", () => {
  it.each([["swept before any funded stamp", { sweptAt: Date.now() }]])(
    "a record %s says the deposit is in and never asks for it again",
    async (_, over) => {
      await seedRecord(over)
      await render()
      expect(container.textContent).toContain("Deposit received")
      expect(container.textContent).toContain("Your deposit is in")
      expect(container.textContent).not.toContain("Send at least")
      expect(container.querySelector('[aria-label^="Copy deposit address"]')).toBeNull()
    },
  )
})

describe("pending step — urgency and wrong-chain states", () => {
  it("a record awaiting its deposit says what to do, and never ages into urgency", async () => {
    await seedRecord({ startTime: Date.now() - 60 * 60_000 })
    await render()
    expect(container.textContent).toContain("@taga is reserved for you")
    expect(container.textContent).not.toContain("taking longer than usual")
  })

  it("the urgency copy flips in place once a funded record ages past the threshold", async () => {
    vi.useFakeTimers()
    await seedRecord({ fundedAt: Date.now(), startTime: Date.now() - 4.5 * 60_000 })
    await render()
    expect(container.textContent).not.toContain("taking longer than usual")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(container.textContent).toContain("@taga is taking longer than usual")
  })

  it("a wrong-chain record explains itself instead of offering the retry", async () => {
    await seedRecord({ l1ChainId: 1 })
    await render()
    expect(container.textContent).toContain("different network")
    expect(button("Register @taga")).toBeUndefined()
    expect(checkControl()).toBeNull()
  })
})

describe("check status — ordering fix and custody heuristic", () => {
  it("consults the terminal phase before the stored-hash success heuristic", async () => {
    // A promoted hash on a record a background tick closed failed must not read as success.
    await seedRecord({ fundedAt: Date.now() })
    await render()
    h.runDetectionTick.mockImplementation(async () => {
      await getPendingStore().close(ACCOUNT, "failed_taken")
      return "pending"
    })
    await clickCheck()

    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
    expect(loadWalletIdentity()).toBeNull()
    expect(container.textContent).toContain("landing-signin")
  })

  it("custody on a reloaded tab enters on the record's identity, marked pending", async () => {
    await seedRecord({ fundedAt: Date.now() })
    await render()
    await clickCheck()

    expect(h.runDetectionTick.mock.calls[0][1]).toEqual({
      force: true,
      expectedRecord: { account: ACCOUNT, nameHash: NAME_HASH },
    })
    expect(loadWalletIdentity()).toMatchObject({
      handle: "taga",
      address: L2_ADDRESS,
      pending: true,
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })
})

describe("signup modals — chained create-then-claim (ULT-667)", () => {
  it("custody completes the signup: identity first, then All set! and the wallet", async () => {
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    expect(container.textContent).toContain("@taga.zk.money")
    // Deposit runs the passkey ceremony itself: no explainer click in between.
    await clickDeposit()
    expect(h.createAccount).toHaveBeenCalledTimes(1)

    // Identity saved BEFORE "All set!": closing the tab on it loses nothing.
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    // Created here, so no upgrade check ever holds its actions on this version.
    expect(upgradeLock(L2_ADDRESS).state === "released").toBe(true)
    // `named` mirrors the identity write: a handle was saved, so this is a named completion.
    expect(h.fireEvent).toHaveBeenCalledWith(
      "onboarding_completed",
      expect.objectContaining({ named: true }),
    )
    expect(enteredWallet()).toBe(true)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("a custody completion whose identity save fails offers a retry that finishes the signup", async () => {
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    let refuse = true
    testWalletDbs().onApply = (_version, ops) => {
      if (refuse && ops.some(([key]) => key === "webwallet.identity")) throw new Error("disk")
    }
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(loadWalletIdentity()).toBeNull()
    expect(enteredWallet()).toBe(false)
    // The create step has no sheet button for it, so the error itself carries the retry.
    const reported = h.showReportableError.mock.calls.find(
      ([, context]) => context === "onboarding:identity",
    )
    const options = reported?.[2] as { retry?: { label: string; run: () => void } } | undefined
    const retry = options?.retry
    expect(retry?.label).toBe("Retry entering wallet")

    refuse = false
    await act(async () => retry!.run())
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga", address: L2_ADDRESS })
    expect(enteredWallet()).toBe(true)
  })

  it("All set! enters the wallet without asking about analytics", async () => {
    h.asked = false
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600))
    })
    expect(button("Share anonymous data")).toBeUndefined()
    expect(h.fireEvent).toHaveBeenCalledWith("wallet_entered", { entry: "link" })
    expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
  })

  it("an already-claimed handle stays on the invitation page with a log-in lead", async () => {
    h.getClaimStatus.mockResolvedValue("claimed")
    await render("/claim/taga")
    await click("landing-signin")
    expect(container.textContent).toContain("taken:taga")
    expect(h.createAccount).not.toHaveBeenCalled()
  })

  it("a closed passkey prompt goes back to the modal with no error, ready to retry", async () => {
    const err = new Error("nope")
    err.name = "NotAllowedError"
    h.createAccount.mockRejectedValueOnce(err)
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).not.toContain("passkey prompt was closed")
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
    expect(h.showReportableError).not.toHaveBeenCalled()

    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await clickDeposit()
    expect(enteredWallet()).toBe(true)
  })

  it("resuming continues the session's own account, even with a previous account's name stored", async () => {
    // The device entered account A and still holds its named identity; the session pointers and
    // the proved cache belong to the unfinished account B whose signup is being picked back up.
    saveWalletIdentity({ handle: "alice", address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    walletStorage.removeItem(`webwallet.version/${L2_ADDRESS.toLowerCase()}`)
    const recoverFromCache = vi.fn(async () => ({
      credentialId: "cred-B",
      expectedAddress: L2_ADDRESS,
    }))
    h.getAuthService.mockReturnValue({ recoverFromCache, clear: vi.fn(), lockOut: vi.fn() })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()

    expect(recoverFromCache).toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-B" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(h.createAccount).not.toHaveBeenCalled()
    // An account signed back in to may hold funds on an old version: no check skipped for it.
    expect(upgradeLock(L2_ADDRESS).state === "released").toBe(false)
    // No bounce back to sign-in: that is the loop this closes.
    expect(h.navigate).not.toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
  })

  it("resuming with no session key still continues a stored nameless identity", async () => {
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-root",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      expect.anything(),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(h.createAccount).not.toHaveBeenCalled()
  })

  it("outside resume a nameless identity still goes before the session key", async () => {
    saveWalletIdentity({ address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    const recoverFromCache = vi.fn(async () => ({
      credentialId: "cred-B",
      expectedAddress: L2_ADDRESS,
    }))
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-root",
      recoverFromCache,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(recoverFromCache).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      `0x${"aa".repeat(32)}`,
      expect.anything(),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })

  it("resuming with no key to recover from goes to the sign-in screen rather than minting a second one", async () => {
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
  })

  it("a name the server refuses returns to the field with the reason, keeping the resume path", async () => {
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => ({ credentialId: "cred-held", expectedAddress: L2_ADDRESS }),
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockRejectedValue(new NameTakenError("reserved", "taga"))
    await render("/claim/taga?resume=1")
    await click("landing-signin")
    await clickDeposit()

    expect(container.textContent).toContain("another account's signup")
    // Not the retry modal: resubmitting the same name reaches the same refusal.
    expect(container.textContent).not.toContain("Try again")
    expect(h.navigate).toHaveBeenCalledWith("/claim?resume=1", { replace: true })
  })

  it("a session still holding a key for a recorded passkey reuses that account instead of minting", async () => {
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => ({ credentialId: "cred-held", expectedAddress: L2_ADDRESS }),
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-held" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(enteredWallet()).toBe(true)
  })

  it("an ordinary signup never adopts a cached key a payment link's signup bound", async () => {
    const { saveTicketSignupAccount } = await import(
      "../../../src/features/paylink/ticketSignupAccount"
    )
    saveTicketSignupAccount("localhost", "some-link", {
      credentialId: "cred-held",
      l2Address: L2_ADDRESS,
      tag: "taglink",
    })
    h.getAuthService.mockReturnValue({
      recoverFromCache: async () => ({ credentialId: "cred-held", expectedAddress: L2_ADDRESS }),
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
    expect(h.createAccount).toHaveBeenCalled()
  })

  it("a nameless identity reuses the session's passkey, not the newest root on the browser", async () => {
    const { setActiveCredentialId, setActiveStorageId } = await import(
      "../../../src/platform/storage/activeStorage"
    )
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    setActiveStorageId("s")
    setActiveCredentialId("cred-bound")
    walletStorage.removeItem(`webwallet.version/${L2_ADDRESS.toLowerCase()}`)
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-newer",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(upgradeLock(L2_ADDRESS).state === "released").toBe(false)
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { credentialId: "cred-bound" },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })

  it("a nameless identity under a session with no passkey opens the chooser", async () => {
    const { clearActiveCredentialId, setActiveStorageId } = await import(
      "../../../src/platform/storage/activeStorage"
    )
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    setActiveStorageId("s")
    clearActiveCredentialId()
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-newer",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
      h.aztec.obsidionWallet,
      L2_ADDRESS,
      { discover: true, chooser: true },
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
  })

  it("a policy refusal on create shows the refusal in the modal with a retry", async () => {
    const { PhoneRequiredError } = await import("@obsidion/passkey-web")
    const refusal = new PhoneRequiredError({ providerName: "Windows Hello" })
    h.createAccount.mockRejectedValueOnce(refusal)
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
    expect(refused?.dataset.reason).toBe("PhoneRequiredError")
    expect(container.textContent).toContain("Use your phone")
    expect(refused?.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
    expect(container.textContent).not.toContain("passkey prompt was closed")
    // Refused before any passkey was written: nothing to clean up.
    expect(refused?.querySelector('[data-testid="passkey-leftover"]')).toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    // The card's retry is the only way to try again: the sheet's own button steps aside.
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(false)

    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await click("Try again")
    expect(h.createAccount).toHaveBeenCalledTimes(2)
    expect(enteredWallet()).toBe(true)
  })

  it("a refusal another attempt cannot fix hides Deposit and offers Start over", async () => {
    const { RotatedCredentialError } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(new RotatedCredentialError())
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const refused = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
    expect(refused?.dataset.reason).toBe("RotatedCredentialError")
    expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(false)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="create-start-over"]')!.click(),
    )
    expect(container.textContent).toContain("landing-signin")
    expect(container.querySelector('[data-testid="create-refused"]')).toBeNull()
    // The next attempt starts clean: the refusal that ended the last one hides nothing now.
    await click("landing-signin")
    expect(buttons().some((b) => b.textContent?.startsWith("Deposit"))).toBe(true)
  })

  it("on a laptop the create step shows the phone steps until Continue, and the X releases the gate", async () => {
    const cancel = vi.fn()
    let opened = false
    h.gateHook = () => ({
      gate: () => {
        opened = true
        return new Promise<never>(() => {})
      },
      state: opened ? { kind: "awaiting-action", proceed: () => {} } : { kind: "idle" },
      cancel,
      dismiss: () => {},
    })
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    // The source stage answers first (no held key here), then the gate opens.
    await settleReads()
    expect(container.querySelector('[data-testid="phone-steps"]')).not.toBeNull()
    // The sign-up sheet: where the new passkey will live, not the sign-in copy.
    expect(container.textContent).toContain("Where should your passkey live?")
    expect(container.textContent).not.toContain("signed up with")
    expect(h.createAccount).not.toHaveBeenCalled()

    // No Cancel: the sheet's X closes it, releasing the gate on the way out.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    })
    expect(cancel).toHaveBeenCalled()
    expect(container.querySelector("dialog")).toBeNull()
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(getPendingStore().current()).toBeNull()
  })

  it("a failed claim after passkey lands on the claim retry modal", async () => {
    h.claimTag.mockRejectedValueOnce(new Error("down"))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).toContain("claim-modal")
    expect(container.textContent).toContain("Couldn't claim your tag")
    expect(h.createAccount).toHaveBeenCalledTimes(1)
    expect(h.fireEvent).toHaveBeenCalledWith("onboarding_failed", { step: "claim", code: "err" })
  })

  it("closing the claim spinner stops the wait; a landed op still completes truthfully", async () => {
    let release!: (outcome: unknown) => void
    h.claimTag.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    expect(container.textContent).toContain("Preparing deposit address")

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    })
    expect(container.textContent).not.toContain("Preparing deposit address")

    // The op has no client-side abort — a submission that lands anyway surfaces the true outcome.
    await act(async () =>
      release({ kind: "custody", confirmed: true, oxideAccount: ACCOUNT, claim: CLAIM }),
    )
    expect(enteredWallet()).toBe(true)
    expect(loadWalletIdentity()).toMatchObject({ handle: "taga" })
  })
})

describe("signup in an app's built-in browser", () => {
  const UA = {
    android:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.0.0 Mobile Safari/537.36",
    // Chrome itself: a browser the in-app rule misses, so a request runs and can fail there.
    androidChrome:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
    // A Chrome below the floor, which is let through only where its brands name Google Chrome.
    androidChromeStale:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
    iosX: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
    laptop:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  }
  const startUrl = window.location.href
  const unsupported = () =>
    new DOMException("Error connecting to Web Authentication service", "NotSupportedError")
  const closed = () => new DOMException("closed", "NotAllowedError")
  // jsdom's DOMException is not an Error, and the closed-prompt line is shown only for an Error.
  const closedError = () => Object.assign(new Error("closed"), { name: "NotAllowedError" })
  const refused = () => container.querySelector<HTMLElement>('[data-testid="create-refused"]')
  const cta = () => buttons().find((b) => b.textContent?.startsWith("Deposit"))
  const events = (name: string) =>
    h.fireEvent.mock.calls.filter(([event]) => event === name).map(([, props]) => props)

  const notice = () => container.querySelector<HTMLElement>('[data-testid="create-in-app-notice"]')
  const escape = () => container.querySelector<HTMLElement>('[data-testid="open-in-browser"]')

  let ua: { mockReturnValue: (value: string) => unknown; mockRestore: () => void } | undefined
  /** The sheet as a visitor in this user agent first sees it, before any tap on it. */
  const toSheet = async (userAgent: string, path = "/claim/taga") => {
    ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    window.history.replaceState(null, "", path)
    await render(path)
    await click("landing-signin")
  }
  /** A signup at `path` in a browser with this user agent, up to its passkey request. */
  const toCreate = async (userAgent: string, path = "/claim/taga") => {
    await toSheet(userAgent, path)
    await clickDeposit()
  }
  /** A granted-tag link with the campaign configured, so Back has somewhere real to go. */
  const onGrantLink = async (run: (assign: ReturnType<typeof vi.fn>) => Promise<void>) => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    h.config.campaignUrl = "https://launch.test.invalid"
    const assign = vi.fn()
    const real = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, assign, href: real.href, origin: real.origin, pathname: "/claim/taga" },
    })
    try {
      await run(assign)
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real })
      h.config.campaignUrl = ""
    }
  }

  beforeEach(() => {
    // A visitor who has never made a passkey here: the card's case. The fixtures otherwise
    // record one by default, and every case that means an account is here says so.
    h.hasRootBreadcrumb = false
  })

  afterEach(() => {
    ua?.mockRestore()
    ua = undefined
    window.history.replaceState(null, "", startUrl)
  })

  it("in an iPhone app, the sheet opens on the card: no passkey button, no terms, a Back", async () => {
    await onGrantLink(async (assign) => {
      await toSheet(UA.iosX)
      expect(notice()?.textContent).toContain("Passkeys don't work in this app's browser")
      expect(cta()).toBeUndefined()
      expect(container.textContent).not.toContain("Deposit")
      // X's app drops the link: the app's own menu leads, Copy link follows.
      expect(container.querySelector('[data-testid="open-in-browser-link"]')).toBeNull()
      expect(escape()?.textContent).toContain("Tap ⋮ next to the web address")
      expect(escape()?.textContent).toContain("Copy link")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="create-in-app-back"]')).not.toBeNull()
      await click("Back")
      expect(assign).not.toHaveBeenCalled()
      expect(h.navigate).toHaveBeenCalledWith("/claim/taga", { replace: true })
    })
  })

  it("the card's report carries the user agent", async () => {
    await toSheet(UA.iosX)
    await act(async () =>
      notice()!.querySelector<HTMLElement>('[data-testid="passkey-report"]')!.click(),
    )
    expect(h.showReportableError).toHaveBeenCalledWith(
      expect.objectContaining({ message: UA.iosX }),
      "onboarding",
      { title: "In-app browser notice" },
    )
  })

  it("a fresh visit gets the card whatever the address claims", async () => {
    await toSheet(UA.iosX, "/claim/taga?resume=1")
    expect(notice()).not.toBeNull()
    expect(cta()).toBeUndefined()
  })

  it("a browser with a root passkey record and no wallet identity still gets the after-failure card on a closed iPhone sheet", async () => {
    h.hasRootBreadcrumb = true
    h.createAccount.mockRejectedValueOnce(closed())
    await toCreate(UA.iosX)
    expect(notice()).toBeNull()
    expect(refused()?.dataset.reason).toBe("InAppBrowser")
    expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
    expect(cta()).toBeUndefined()
    expect(container.querySelector('[data-testid="create-start-over"]')).not.toBeNull()
  })

  it("the credential the session was entered with exempts on its own", async () => {
    setActiveCredentialId("cred-held")
    await toSheet(UA.android)
    expect(notice()).toBeNull()
    expect(cta()).toBeDefined()
  })

  it("a create refused as not supported shows the card and Chrome, and the sheet's own button stays the retry", async () => {
    h.createAccount.mockRejectedValueOnce(unsupported())
    await toCreate(UA.androidChrome)
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(container.textContent).toContain("open it in your phone's browser")
    expect(
      container.querySelector('[data-testid="open-in-browser-link"]')!.getAttribute("href"),
    ).toBe(
      `intent://${window.location.host}/claim/taga#Intent;scheme=http;package=com.android.chrome;end`,
    )
    expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
    expect(container.querySelector('[data-testid="create-start-over"]')).not.toBeNull()
    expect(container.textContent).not.toContain("Couldn't create your passkey")
    expect(cta()?.dataset.style).toBe("dark")
    expect(refused()?.querySelector('[data-testid="passkey-leftover"]')).toBeNull()
    expect(h.showReportableError).not.toHaveBeenCalled()
    expect(events("action_failed")).toEqual([{ action: "create_account", code: "err" }])
    expect(events("onboarding_failed")).toEqual([{ step: "account", code: "err" }])

    h.fireEvent.mockClear()
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await clickDeposit()
    expect(h.createAccount).toHaveBeenCalledTimes(2)
    expect(events("registration_terms_accepted")).toHaveLength(1)
  })

  it("a not-supported failure after the passkey was written links the cleanup entry beside the way out", async () => {
    const { markPasskeyWritten } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(markPasskeyWritten(unsupported()))
    await toCreate(UA.androidChrome)
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(escape()).not.toBeNull()
    expect(
      refused()?.querySelector('[data-testid="passkey-leftover"] a')?.getAttribute("href"),
    ).toBe("https://docs.zk.money/docs/passkeys#leftover-passkey")
  })

  it("the same failure on a laptop has no way out, and the sheet's button keeps its usual look", async () => {
    h.createAccount.mockRejectedValueOnce(unsupported())
    await toCreate(UA.laptop)
    expect(refused()?.dataset.reason).toBe("NotSupportedError")
    expect(container.querySelector('[data-testid="open-in-browser"]')).toBeNull()
    expect(cta()?.dataset.style).toBe("gradient")
  })

  it("a closed follow-up prompt, after the passkey was written, gets the card with the cleanup link", async () => {
    const { markPasskeyWritten } = await import("@obsidion/passkey-web")
    h.createAccount.mockRejectedValueOnce(markPasskeyWritten(closedError()))
    await toCreate(UA.laptop)
    expect(refused()?.dataset.reason).toBe("NotAllowedError")
    expect(refused()?.querySelector("h2")?.textContent).toBe("The passkey prompt was closed")
    expect(refused()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The passkey prompt was closed before it finished. Try again when you're ready.",
    )
    expect(
      refused()?.querySelector('[data-testid="passkey-leftover"] a')?.getAttribute("href"),
    ).toBe("https://docs.zk.money/docs/passkeys#leftover-passkey")
    expect(container.querySelector('[data-testid="create-retry"]')).not.toBeNull()
  })

  it("a browser that already holds an account gets no card and keeps the create error: that account can't travel", async () => {
    h.hasRootBreadcrumb = true
    saveWalletIdentity({ handle: "alice", address: `0x${"aa".repeat(32)}`, claimedAt: 1 })
    h.createAccount.mockRejectedValueOnce(unsupported())
    await toSheet(UA.android)
    expect(notice()).toBeNull()
    await clickDeposit()
    expect(h.createAccount).toHaveBeenCalledTimes(1)
    expect(refused()).toBeNull()
    expect(container.textContent).toContain("Couldn't create your passkey")
  })
})

describe("modal overlay — one node for the whole step sequence (ULT-803)", () => {
  const overlay = () => container.querySelector(".ww-modal-overlay")
  const overlayCount = () => container.querySelectorAll(".ww-modal-overlay").length

  it("create → allset keeps the same overlay node", async () => {
    let release!: (outcome: unknown) => void
    h.claimTag.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    await render("/claim/taga")
    await click("landing-signin")
    await clickDeposit()
    const node = overlay()
    expect(node).not.toBeNull()

    await act(async () =>
      release({ kind: "custody", confirmed: true, oxideAccount: ACCOUNT, claim: CLAIM }),
    )
    expect(enteredWallet()).toBe(true)
    expect(overlayCount()).toBe(1)
    expect(overlay()).toBe(node)
  })
})

describe("LostRegistrationNoticeCard", () => {
  const renderCard = () =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <LostRegistrationNoticeCard />
        </MemoryRouter>,
      )
    })

  it("terminal failure copy is generic-honest and steers back to claiming", async () => {
    await seedRecord()
    await getPendingStore().close(ACCOUNT, "failed_terminal")
    await renderCard()

    expect(container.textContent).toContain("pick another tag, or try this one again later")
    expect(container.textContent).not.toContain("different tag")
    await click("Start over")
    expect(h.navigate).toHaveBeenCalledWith("/claim")
  })

  it("needs_recovery steers to enter, never to a new claim", async () => {
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    applyIdentityOutcome("needs_recovery")
    await renderCard()

    expect(container.textContent).toContain("Enter with your passkey")
    await click("Enter with your passkey")
    expect(h.navigate).toHaveBeenCalledWith("/enter")
  })
})

describe("reusePasskeyAccount — pre-commit expectedL2Address verification", () => {
  const SECRET = { toString: () => `0x${"33".repeat(32)}` }
  const recovered = () => ({
    candidates: { first: SECRET },
    authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] },
    credentialId: "cred-1",
    pubkey: `0x${"44".repeat(64)}`,
    authenticatorType: "platform",
  })

  it("a matching passkey proceeds to adoption", async () => {
    const commitSecret = vi.fn(async () => 1)
    const recordRecoveryMetadata = vi.fn()
    h.getAuthService.mockReturnValue({
      beginRecovery: async () => recovered(),
      recoverFromCache: async () => undefined,
      commitSecret,
      sessionHeld: () => true,
      sessionAddress: async () => undefined,
      markRecordsStale: () => {},
      recordRecoveryMetadata,
    })
    const addWebauthnAccount = vi.fn()
    const storageGet = vi
      .spyOn(AccountStorage, "get")
      .mockReturnValue({ addWebauthnAccount } as never)
    const wallet = {
      deriveAccountAddress: vi.fn(async () => ({ toString: () => L2_ADDRESS })),
      createObsidionAccount: vi.fn(async () => fakeAccount),
    }

    const keys = await realOxideOnboarding.reusePasskeyAccount(
      wallet as never,
      L2_ADDRESS,
      undefined,
      async () => ({ signal: new AbortController().signal, reach: "unknown" as const }),
    )
    expect(keys.account).toBe(fakeAccount)
    expect(commitSecret).toHaveBeenCalledTimes(1)
    expect(recordRecoveryMetadata).toHaveBeenCalledTimes(1)
    expect(addWebauthnAccount).toHaveBeenCalledTimes(1)
    storageGet.mockRestore()
  })
})

describe("buildRetrySignDeps — the rebuild's sign half", () => {
  // The install's credential id is read from the stored passkey record.
  const storedCredential = () =>
    vi.spyOn(AccountStorage, "get").mockReturnValue({
      getWebAuthnDataForCurrentAccount: async () => ({ credentialId: "cred-alice" }),
    } as never)
  afterEach(() => vi.restoreAllMocks())

  it("builds against a test-mode account-service too", async () => {
    storedCredential()
    const deps = await realOxideOnboarding.buildRetrySignDeps(
      "alice",
      fakeKeys as never,
      {
        ...h.config,
        accountServiceTestMode: true,
      } as never,
      "0xnet",
    )
    expect(deps.accountService).toBeDefined()
  })
})

describe("pending step — the deposit gate (registration-fee.md Campaign)", () => {
  it.each([
    { phase: "awaiting_deposit" as const, balance: 5n * 10n ** 18n },
    { phase: "funded" as const, balance: 0n },
  ])("keeps original deposit status after a quote mismatch: %s", async ({ phase, balance }) => {
    await seedRecord({
      phase,
      broadcast: false,
      ...(phase === "funded" ? { fundedAt: Date.now() } : {}),
    })
    const original = getPendingStore().current()!
    h.balance = balance
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "5000000000000000000",
      minDeposit: "10000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    await render("/claim/taga")
    await settleReads()
    expect(container.querySelector('[aria-label="Existing deposit status"]')).not.toBeNull()
    expect(container.textContent).toContain(original.sipaAddress)
    expect(checkControl()).not.toBeNull()
    expect(termsValue("total")).not.toBe(ask("standard"))
    expect(container.textContent).not.toContain("Return to the campaign")
    expect(button("Retry earned price")).toBeUndefined()
    if (balance >= 5n * 10n ** 18n) {
      expect(h.navigate).toHaveBeenCalledWith("/", { replace: true })
      expect(loadWalletIdentity()).toMatchObject({
        address: L2_ADDRESS,
        handle: "taga",
        pending: true,
      })
      expect(getPendingStore().current()?.phase).toBe("awaiting_deposit")
      expect(getPendingStore().current()?.fundedAt).toBeUndefined()
    }
    if (balance >= 5n * 10n ** 18n) {
      expect(button("Retry")).toBeUndefined()
      expect(button("Recover deposit")).toBeDefined()
    } else if (phase === "awaiting_deposit") {
      // Nothing reached the address: a retry re-signs the same old-price commitment for nothing.
      expect(button("Retry")).toBeUndefined()
      expect(button("Register at earned price")).toBeDefined()
      expect(h.runDetectionTick).not.toHaveBeenCalled()
    } else {
      await click("Retry")
      expect(h.runDetectionTick).toHaveBeenCalled()
    }
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
    expect(loadRegistrationTerms(ACCOUNT)?.fee).toBe("5000000000000000000")
  })

  // The earned ask carries headroom over the earned floor; only a floor that outgrew the ask is a
  // mismatch, and the deposit panel stands for everything under it.
  it.each([
    { minDeposit: String(RANDOM.min), mismatch: false },
    { minDeposit: String(RANDOM_ASK), mismatch: true },
  ])("reads a signed earned floor against the earned ask: %s", async ({ minDeposit, mismatch }) => {
    await seedRecord({ phase: "awaiting_deposit", broadcast: false })
    h.balance = 0n
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: String(RANDOM.fee),
      minDeposit,
      feeWaived: true,
      earnedExpected: true,
    })
    await render("/claim/taga")
    await settleReads()
    const mismatched = container.querySelector('[aria-label="Existing deposit status"]') !== null
    expect(mismatched).toBe(mismatch)
    if (mismatch) expect(termsValue("total")).toBeUndefined()
    else expect(termsValue("total")).toBe(ask("earned_tag"))
  })

  it("reopens admitted registration refund through real navigation and preserves wallet access", async () => {
    h.realNavigation = true
    await seedRecord({ broadcast: false, retries: 3, startTime: Date.now() - 30 * 60_000 })
    const original = getPendingStore().current()!
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 1,
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    const savedTerms = loadRegistrationTerms(ACCOUNT)
    const { recordDepositAdmission } = await import("../../../src/features/identity/admission")
    const { SecureNameNoticeCard } = await import(
      "../../../src/features/onboarding/SecureNameNoticeCard"
    )
    recordDepositAdmission(original, 5n * 10n ** 18n)
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route
              path="/"
              element={
                <div data-testid="wallet-home">
                  <SecureNameNoticeCard ask={() => null} />
                </div>
              }
            />
            <Route path="/claim/:handle?" element={<OnboardingScreen />} />
          </Routes>
        </MemoryRouter>,
      ),
    )
    const openRecovery = () =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>("[data-testid='registration-pending-notice']")!
          .click(),
      )
    await openRecovery()
    await settleReads()
    expect(container.textContent).toContain("Recover deposit for @taga")
    expect(container.textContent).toContain(original.sipaAddress)
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeDefined()
    expect(button("Refresh deposit amount")).toBeUndefined()
    await clickCheck()
    expect(h.runDetectionTick).toHaveBeenCalled()
    expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
    expect(loadRegistrationTerms(ACCOUNT)).toEqual(savedTerms)
    await click("Back to wallet")
    expect(container.querySelector("[data-testid='registration-pending-notice']")).not.toBeNull()
    await openRecovery()
    expect(button("Recover deposit")).toBeDefined()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
    )
    expect(container.querySelector("[data-testid='registration-pending-notice']")).not.toBeNull()
    await openRecovery()
    vi.useFakeTimers()
    await act(async () => {
      saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1 })
      await getPendingStore().close(ACCOUNT, "confirmed")
    })
    await act(async () => vi.advanceTimersByTimeAsync(1_600))
    expect(container.querySelector("[data-testid='wallet-home']")).not.toBeNull()
    expect(container.textContent).not.toContain("Registration is still pending")
  })

  it("refunds the old deposit before opening a new earned-price address, with a manual completion action", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission } = await import("../../../src/features/identity/admission")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    const deposit = await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "broadcast" },
      {
        networkId: "0xnet",
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    recordDepositAdmission(original, 5n * 10n ** 18n)
    h.l1.account = ACCOUNT
    h.prepareRefund.mockResolvedValue(deposit)
    h.recoverDeposit.mockImplementation(async () => {
      await rail.upsert(original.sipaAddress as Hex, {
        phase: "recovered",
        recoveryTxHash: NAME_HASH,
      })
      return NAME_HASH
    })
    const newAddress = "0x00000000000000000000000000000000000000c9"
    h.claimTag.mockImplementation(async () => {
      expect(rail.get(original.sipaAddress as Hex)?.phase).toBe("recovered")
      await getPendingStore().upsert(ACCOUNT, {
        sipaAddress: newAddress,
        fee: TERMS.fee,
        broadcast: false,
        replaced: { sipaAddress: original.sipaAddress, refunded: true, broadcastSpent: true },
      })
      return {
        kind: "pending",
        oxideAccount: ACCOUNT,
        claim: { ...CLAIM, terms: TERMS },
      }
    })
    await render("/claim/taga?recovery=1")
    await click("Recover deposit")
    expect(container.textContent).toContain("Recovery requires ETH for gas")
    expect(h.claimTag).not.toHaveBeenCalled()
    await click(`Recover to ${shortL1Addr(ACCOUNT)}`)
    expect(container.textContent).toContain("Deposit recovered")
    expect(getPendingStore().current()?.sipaAddress).toBe(original.sipaAddress)
    await click("Done")
    await click("Register at earned price")
    expect(h.claimTag).toHaveBeenCalledWith(
      "taga",
      fakeKeys,
      h.config,
      h.aztec.obsidionWallet,
      undefined,
      true,
      expect.objectContaining({ sipaAddress: original.sipaAddress }),
    )
    expect(getPendingStore().current()?.sipaAddress).toBe(newAddress)
    expect(loadRegistrationTerms(ACCOUNT)).toMatchObject({
      fee: TERMS.fee,
      minDeposit: String(RANDOM.min),
    })
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Back to wallet")).toBeDefined()
    expect(button("Retry")).toBeUndefined()
    h.navigate.mockClear()
    await act(async () => {
      await getPendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    expect(h.navigate).not.toHaveBeenCalled()
    expect(button("Sweep manually")).toBeDefined()
    expect(container.textContent).toContain("The new address has received your deposit")
    await act(async () => {
      recordDepositAdmission(getPendingStore().current()!, 5n * 10n ** 18n)
    })
    await click("Check again")
    expect(h.navigate).not.toHaveBeenCalled()
    expect(button("Sweep manually")).toBeDefined()

    // Confirmed short capacity holds the action and says so beside it, not "choose Sweep manually".
    h.processing.current = {
      reason: {
        kind: "capacity",
        availableAtomic: 0n,
        refill: { status: "unknown" },
        decimals: 18,
        observedAt: Date.now(),
      },
      blocker: { kind: "capacity", observedAt: Date.now(), zeroCapacity: true },
    }
    await click("Check again")
    expect(container.textContent).toContain(
      "Sweep manually finishes registration once network capacity is available.",
    )
    expect(container.textContent).not.toContain("Choose Sweep manually")
    expect(button("Sweep manually")?.disabled).toBe(true)
    expect(
      container.querySelector('[data-testid="deposit-pending-reason"]')?.textContent,
    ).toContain("Waiting for network capacity")
  })

  it("offers the earned-price restart after a sign-out cleared the admission receipt", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission, hasDepositAdmission } = await import(
      "../../../src/features/identity/admission"
    )
    const { signOut } = await import("../../../src/features/identity/signOut")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        networkId: "0xnet",
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      depositAmount: "5000000000000000000",
      earnedExpected: true,
    })
    recordDepositAdmission(original, 5n * 10n ** 18n)
    // The refund emptied the address, so nothing the L1 watcher reads can rewrite the receipt.
    await signOut()
    expect(hasDepositAdmission(original)).toBe(false)
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 2 })
    const newAddress = "0x00000000000000000000000000000000000000c9"
    h.claimTag.mockImplementation(async () => {
      await getPendingStore().upsert(ACCOUNT, {
        sipaAddress: newAddress,
        fee: TERMS.fee,
        broadcast: false,
        replaced: { sipaAddress: original.sipaAddress, refunded: true, broadcastSpent: true },
      })
      return {
        kind: "pending",
        oxideAccount: ACCOUNT,
        claim: { ...CLAIM, terms: TERMS },
      }
    })
    await render("/claim/taga?recovery=1")
    await settleReads()
    expect(container.textContent).toContain("Recover deposit for @taga")
    expect(container.textContent).toContain("The original deposit was recovered")
    expect(container.textContent).toContain(original.sipaAddress)
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeUndefined()
    expect(button("Back to wallet")).toBeUndefined()
    await click("Register at earned price")
    expect(h.claimTag).toHaveBeenCalledWith(
      "taga",
      fakeKeys,
      h.config,
      h.aztec.obsidionWallet,
      undefined,
      true,
      expect.objectContaining({ sipaAddress: original.sipaAddress }),
    )
    expect(getPendingStore().current()?.sipaAddress).toBe(newAddress)
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(container.textContent).toContain("The original deposit was refunded")
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Back to wallet")).toBeDefined()
  })

  it("offers recovery, not the restart, when funds reach a refunded address on the claim route", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        networkId: "0xnet",
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    // Nothing on this route syncs the rail's record; the live balance is what says funds are back.
    h.balance = 2n * 10n ** 17n
    try {
      await render("/claim/taga?recovery=1")
      await settleReads()
      expect(button("Recover deposit")).toBeDefined()
      expect(button("Register at earned price")).toBeUndefined()
      expect(container.textContent).toContain("Recover it to your Ethereum wallet first")
      expect(h.claimTag).not.toHaveBeenCalled()
    } finally {
      h.balance = 0n
    }
  })

  it("keeps a paid registration on its own terms after a recovery: no earned restart", async () => {
    await seedRecord({ fee: String(PAID.fee), broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        networkId: "0xnet",
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "10",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: String(PAID.min),
      feeWaived: false,
    })
    await render("/claim/taga?recovery=1")
    await settleReads()
    expect(button("Register at earned price")).toBeUndefined()
    expect(termsValue("total")).toBe(ask("standard"))
    expect(container.textContent).not.toContain("earned price")
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it("offers recovery again for a funded legacy-fee address that holds funds after its refund", async () => {
    await seedRecord({ fee: "0", phase: "funded", fundedAt: 1, broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    const { webStorage } = await import("../../../src/platform/storage/WebStorageAdapter")
    const { recordDepositAdmission } = await import("../../../src/features/identity/admission")
    const rail = SIPADepositStore.get(webStorage)
    await rail.load()
    await rail.upsert(
      original.sipaAddress as Hex,
      { phase: "recovered", recoveryTxHash: NAME_HASH },
      {
        networkId: "0xnet",
        recipientL2Address: L2_ADDRESS,
        tokenAddress: original.depositToken,
        tokenSymbol: "DAI",
        l1ChainId: original.l1ChainId,
        messageSecret: NAME_HASH,
        recoveryAddress: ACCOUNT,
        recipientHash: NAME_HASH,
        amount: "5",
        startTime: 1,
      },
    )
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "0",
      minDeposit: "5000000000000000000",
      feeWaived: true,
      earnedExpected: true,
    })
    recordDepositAdmission(original, 5n * 10n ** 18n)
    h.skim = 5n * 10n ** 17n
    h.balance = 2n * 10n ** 17n
    try {
      await render("/claim/taga?recovery=1")
      await settleReads()
      expect(button("Recover deposit")).toBeDefined()
      expect(button("Register at earned price")).toBeUndefined()
      expect(h.claimTag).not.toHaveBeenCalled()
    } finally {
      h.skim = 0n
      h.balance = 0n
    }
  })

  it("replaces an old-price address nothing was sent to with one at the earned price, with a manual completion action", async () => {
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    const original = getPendingStore().current()!
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    const newAddress = "0x00000000000000000000000000000000000000c9"
    let ledgerHeld: boolean | undefined
    h.claimTag.mockImplementation(async () => {
      // No broadcast of the old address may start while the replacement decides on the rail.
      ledgerHeld = userFlowActive()
      // The old address was broadcast, so the rail's one use is gone.
      await getPendingStore().upsert(ACCOUNT, {
        sipaAddress: newAddress,
        fee: TERMS.fee,
        broadcast: false,
        replaced: { sipaAddress: original.sipaAddress, refunded: false, broadcastSpent: true },
      })
      return {
        kind: "pending",
        oxideAccount: ACCOUNT,
        claim: { ...CLAIM, terms: TERMS },
      }
    })
    await render("/claim/taga")
    await settleReads()
    expect(container.textContent).toContain("Nothing was sent to the original address")
    expect(container.textContent).toContain(original.sipaAddress)
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeUndefined()
    await click("Register at earned price")
    expect(h.claimTag).toHaveBeenCalledWith(
      "taga",
      fakeKeys,
      h.config,
      h.aztec.obsidionWallet,
      undefined,
      true,
      undefined,
      expect.objectContaining({ sipaAddress: original.sipaAddress, broadcast: true }),
    )
    expect(ledgerHeld).toBe(true)
    expect(h.runDetectionTick).not.toHaveBeenCalled()
    expect(getPendingStore().current()?.sipaAddress).toBe(newAddress)
    expect(loadRegistrationTerms(ACCOUNT)).toMatchObject({ fee: TERMS.fee })
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(container.textContent).toContain(
      `Fund this new address with the earned ${ask(
        "earned_tag",
      )} total, then choose Sweep manually`,
    )
    expect(container.textContent).not.toContain("The original deposit was refunded")
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Retry")).toBeUndefined()
    // No deposit was refunded, so nothing bought wallet entry.
    expect(button("Back to wallet")).toBeUndefined()
    expect(button("Enter now, deposit later")).toBeDefined()
  })

  it("owes nothing for an old-price address a payment link would fund, while it is to be replaced", async () => {
    resetBroadcastsForTests()
    await seedRecord({ fee: "10000000000000000000", broadcast: false, retries: 3 })
    const original = getPendingStore().current()!
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
      paylinkFunded: true,
      paylinkId: "id:paylink-frag",
    })
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: (2n * 10n ** 18n).toString(),
      schedule: { fee: (10n ** 18n / 2n).toString(), minDeposit: "0" },
      amount: (20n * 10n ** 18n).toString(),
    })
    await render("/claim/taga")
    await settleReads()
    expect(button("Register at earned price")).toBeDefined()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(getBroadcastLedger().get(original.sipaAddress)).toBeNull()
  })

  it("stops a replacement whose old address has a broadcast still undecided, to be asked for again", async () => {
    resetBroadcastsForTests()
    await seedRecord({ fee: "10000000000000000000", broadcast: false, retries: 3 })
    const original = getPendingStore().current()!
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: original.fee,
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    // An earlier page sent the old address's broadcast; the chain has not decided it.
    await getBroadcastLedger().enqueue({
      address: original.sipaAddress,
      kind: "registration",
      scope: null,
      source: { type: "registration", account: ACCOUNT },
      txHash: `0x${"aa".repeat(32)}`,
    })
    await render("/claim/taga")
    await settleReads()
    vi.useFakeTimers()
    try {
      await act(async () => {
        button("Register at earned price")!.click()
        await vi.advanceTimersByTimeAsync(60_001)
      })
      expect(container.textContent).toContain("The original address is still being published")
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(userFlowActive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a replacement whose session died past its checkpoint still completes manually after a reload", async () => {
    const original = "0x00000000000000000000000000000000000000c3"
    // What the checkpoint left behind: the record and its quote, no session result.
    await seedRecord({
      fee: REDUCED_FEE,
      broadcast: false,
      replaced: { sipaAddress: original, refunded: false, broadcastSpent: true },
    })
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: REDUCED_FEE,
      minDeposit: String(RANDOM.min),
      feeWaived: true,
      earnedExpected: true,
    })
    await render("/claim/taga")
    await settleReads()
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(container.textContent).not.toContain("request a new one")
    expect(container.textContent).toContain(
      `Fund this new address with the earned ${ask(
        "earned_tag",
      )} total, then choose Sweep manually`,
    )
    // Never broadcast, yet shown: only a manual sweep registers it.
    expect(container.querySelector('[aria-label^="Copy deposit address"]')).not.toBeNull()
    expect(button("Sweep manually")).toBeDefined()
    expect(button("Retry")).toBeUndefined()
    expect(button("Register at earned price")).toBeUndefined()
    expect(button("Back to wallet")).toBeUndefined()
  })

  it("offers recovery for a deposit short of admission at an old-price address", async () => {
    // A legacy 10 + 5 quote: the old price itself is the point.
    await seedRecord({ fee: "10000000000000000000", broadcast: true, retries: 3 })
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, pending: true, claimedAt: 1 })
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: 4102444800,
      fee: "10000000000000000000",
      minDeposit: "5000000000000000000",
      feeWaived: false,
      earnedExpected: true,
    })
    // Admission is the earned ask, so anything under it is short.
    const short = RANDOM_ASK / 2n
    h.balance = short
    await render("/claim/taga")
    await settleReads()
    expect(container.textContent).toContain("Recover deposit for @taga")
    expect(container.textContent).toContain(`Deposit detected: ${seen(short)}`)
    expect(container.textContent).not.toContain("Your wallet is open")
    expect(termsValue("total")).toBeUndefined()
    expect(button("Recover deposit")).toBeDefined()
    expect(button("Register at earned price")).toBeUndefined()
    expect(h.claimTag).not.toHaveBeenCalled()
  })

  it("routes a paid pending registration to passkey recovery when wallet entry has no root breadcrumb", async () => {
    await seedRecord()
    h.hasRootBreadcrumb = false
    h.balance = 5n * 10n ** 18n
    saveRegistrationTerms({ account: ACCOUNT, tag: "taga", deadline: 0, earnedExpected: true })
    await render("/claim/taga")
    await settleReads()
    expect(h.navigate).toHaveBeenCalledWith("/enter?handle=taga", { replace: true })
    expect(h.navigate).not.toHaveBeenCalledWith("/", { replace: true })
    expect(loadWalletIdentity()).toMatchObject({ address: L2_ADDRESS, pending: true })
    expect(container.textContent).not.toContain("Send at least")
  })
})

describe("pending step — deposit feedback", () => {
  it("asks the full deposit before the schedule read lands, and acknowledges one that arrives", async () => {
    vi.useFakeTimers()
    h.scheduleFails = true
    await seedRecord()
    unsignedTerms()
    await render()
    // The asked total is a constant, so it is there from the first paint; the split it covers is not.
    expect(termsValue("total")).toBe(ask("standard"))
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)

    h.balance = PAID_ASK / 2n
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    // Under the ask with no floor to weigh it against: no verdict, so the panel keeps asking.
    expect(container.textContent).not.toContain("Deposit received")

    h.balance = PAID_ASK
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    // The whole ask covers any floor it was priced to, so the panel reports it.
    expect(container.textContent).toContain(`Deposit received: ${seen(PAID_ASK)}`)
    h.balance = 0n
  })

  it("a deposit short of the quote prices the top-up and keeps the address, no celebration", async () => {
    vi.useFakeTimers()
    h.amounts = { ...PAID }
    await seedRecord()
    unsignedTerms()
    await render()

    const partial = PAID_ASK / 2n
    h.balance = partial
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    // The ask is the quoted deposit; the top-up is priced to it, not to the chain's own floor.
    expect(summary()).toContain(`${seen(partial)} of ${ask("standard")} received. Send at least`)
    expect(summary()).toContain(due(askedTotal("standard") - partial))
    expect(container.textContent).not.toContain("Deposit received")
    expect(container.textContent).not.toContain("Confirming your name")
    await act(async () => {
      buttons()
        .find((b) => b.textContent?.startsWith("Connect your wallet"))!
        .click()
    })
    expect(h.l1.connect).toHaveBeenCalledTimes(1)

    h.balance = PAID_ASK
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500)
    })
    expect(container.textContent).toContain(`Deposit received: ${seen(PAID_ASK)}`)
    h.balance = 0n
    h.amounts = { min: 0n, fee: 0n }
  })
})

describe("pending step — a reload with no signed quote left", () => {
  it("a stored expectation quotes the earned ask without inventing a signed waiver", async () => {
    // The record outlives the quote: freshClaim is memory-only and the stored copy can be absent.
    // Reading that as "you pay" reprices a free tag at the full total.
    h.amounts = { ...PAID }
    await seedRecord()
    saveRegistrationTerms({ account: ACCOUNT, tag: "taga", deadline: 0, earnedExpected: true })
    await render("/claim/taga")
    await settleReads()
    // A waiver is the signature's to name: nothing writes `feeWaived` for a schedule nothing signed.
    expect(loadRegistrationTerms(ACCOUNT, "taga")?.feeWaived).toBeUndefined()
    // No quote to disagree with, and the stamped deadline 0 is unknown, not lapsed: the address
    // and the reservation stand, and the expectation alone quotes the earned ask.
    expect(termsValue("tag-price")).toBe("Waived")
    expect(termsValue("total")).toBe(ask("earned_tag"))
    expect(termsValue("total")).not.toBe(ask("standard"))
    expect(container.textContent).not.toContain("Original deposit address")
    expect(container.textContent).not.toContain(`Refresh the deposit for @taga`)
    expect(button("Enter now, deposit later")).toBeTruthy()
    expect(checkControl()).not.toBeNull()
    expect(getPendingStore().current()?.sipaAddress).toBe(
      "0x00000000000000000000000000000000000000c3",
    )
  })

  it("drops the split once the controller answers a fee this address is not committed to", async () => {
    // The schedule landed and prices another fee, so it cannot price this record and no further
    // read will: the rows it prices go, rather than holding a placeholder for good.
    h.amounts = { min: 5n * 10n ** 18n, fee: 7n * 10n ** 18n }
    await seedRecord({ fee: String(5n * 10n ** 18n) })
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(h.scheduleReads).toBeGreaterThan(0)
    expect(termsValue("total")).toBe(ask("standard"))
    for (const row of ["tag-price", "network-funding", "opening-balance"]) {
      expect(termsValue(row)).toBeUndefined()
    }
  })

  /** Virtual time, since the surfaces here retry their reads on a slow cadence. */
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it("a deployment that takes no registration says so, asks nothing, and re-reads no more", async () => {
    vi.useFakeTimers()
    // The registry answers zero for both immutables — an answer, not a read still outstanding.
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await tick(10)
    const reads = h.scheduleReads
    expect(reads).toBeGreaterThan(0)
    expect(paused()).toContain(REGISTRATIONS_PAUSED_NOTICE)
    // No figure and no address: a deposit sent now could not be swept.
    expect(termsValue("total")).toBeUndefined()
    expect(container.textContent).not.toContain("0x000000...0000c3")

    await tick(CHAIN_READ_RETRY_MS + 1_000)
    expect(h.scheduleReads).toBe(reads)
  })

  it("says the same, holding the name, where the schedule's fee sits under the relayer's sweep fee", async () => {
    // Nothing at the address could fund the sweep, so the deposit is never asked for.
    h.amounts = { min: 5n * 10n ** 18n, fee: 10n ** 17n }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await settleReads()
    expect(paused()).toContain(REGISTRATIONS_PAUSED_NOTICE)
    expect(termsValue("total")).toBeUndefined()
    expect(container.textContent).not.toContain("Send the deposit to the address below")
    // The notice stands once, with the check control beside it rather than inside its sentence.
    expect(container.textContent!.split(REGISTRATIONS_PAUSED_NOTICE)).toHaveLength(2)
    expect(checkControl()).not.toBeNull()
  })

  it("a schedule read that failed keeps checking, and prices the rows once one lands", async () => {
    vi.useFakeTimers()
    h.scheduleFails = true
    h.amounts = { ...PAID }
    await seedRecord()
    unsignedTerms()
    await render("/claim/taga")
    await tick(2_000)
    // Unread is not an answer: the row holds and the cadence keeps asking.
    expect(termsValue("tag-price")).toBe(DEPOSIT_TERMS_PENDING)
    const reads = h.scheduleReads

    h.scheduleFails = false
    await tick(CHAIN_READ_RETRY_MS + 1_000)
    expect(h.scheduleReads).toBeGreaterThan(reads)
    expect(termsValue("tag-price")).toBe(usd(PAID.fee - h.skim))
  })
})

describe("pending step — a quote past its deadline", () => {
  const auth = {
    clear: vi.fn(),
    lockOut: vi.fn(),
    rootCredentialId: vi.fn(async () => undefined as string | undefined),
  }
  const expiredTerms = () =>
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) - 60,
      feeWaived: false,
    })
  beforeEach(() => {
    auth.clear.mockClear()
    h.getAuthService.mockReturnValue(auth)
  })

  it("offers the refresh, hides the address, and never says the name was lost", async () => {
    await seedRecord()
    expiredTerms()
    await render()
    expect(container.textContent).toContain(`Refresh the deposit for @taga`)
    // The deadline is the claim signature's; the 7-day hold is not what ran out.
    expect(container.textContent).not.toContain("reservation")
    expect(container.textContent).not.toContain(
      `Send at least ${ask("standard")} to claim your tag`,
    )
    expect(button("Refresh deposit amount")).toBeTruthy()
    expect(button("Register @taga")).toBeUndefined()
  })

  it("a still-free name is re-claimed through the re-broadcast branch, with the new deadline kept", async () => {
    h.amounts = { ...PAID }
    await seedRecord()
    expiredTerms()
    await render()
    h.getClaimStatus.mockResolvedValue("reserved")
    h.tuple = { registry: "0x00000000000000000000000000000000000000e4" }
    const freshDeadline = String(Math.floor(Date.now() / 1000) + 7200)
    h.buildRetrySignDeps.mockReturnValue({
      accountService: { signDomain: vi.fn(async () => nameClaim({ deadline: freshDeadline })) },
    })
    h.runDetectionTick.mockImplementation(async (deps: { getSignDeps: () => Promise<any> }) => {
      const sign = await deps.getSignDeps()
      await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
      await getPendingStore().upsert(ACCOUNT, { broadcast: true })
      return "pending"
    })

    await click("Refresh deposit amount")
    expect(h.runDetectionTick).toHaveBeenCalledTimes(1)
    expect(h.runDetectionTick.mock.calls[0][1]).toMatchObject({ force: true })
    expect(loadRegistrationTerms(ACCOUNT)?.deadline).toBe(Number(freshDeadline))
    expect(getPendingStore().current()?.broadcast).toBe(true)
    expect(container.textContent).not.toContain(`Refresh the deposit for @taga`)
    expect(summary()).toContain(
      `Send at least ${ask("standard")} to claim your tag and activate your account.`,
    )
  })

  it("a name the registry now shows as someone else's ends the attempt: record closed, fresh start", async () => {
    await seedRecord()
    expiredTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render()
    h.getClaimStatus.mockResolvedValue("claimed")

    await click("Refresh deposit amount")
    expect(getPendingStore().current()).toBeNull()
    expect(getPendingStore().list()[0]?.phase).toBe("failed_taken")
    expect(auth.lockOut).toHaveBeenCalledTimes(1)
    expect(loadWalletIdentity()).toBeNull()
    expect(container.textContent).toContain("taken:taga")
    expect(h.runDetectionTick).not.toHaveBeenCalled()
  })
})

describe("pending step — log out", () => {
  it("leaves the deposit screen for the landing without touching the record, even with custody", async () => {
    await seedRecord({ fundedAt: Date.now() })
    waivedTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render("/claim/taga")

    await click("Log out")
    expect(container.textContent).toContain("landing-signin")
    expect(loadWalletIdentity()).toBeNull()
    expect(getPendingStore().current()?.fundedAt).toBeDefined()
    // The terms describe the record, and go with it, not with the session.
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({ feeWaived: true })
    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
  })

  it("drops terms once the record they priced is closed", async () => {
    await seedRecord()
    waivedTerms()
    saveWalletIdentity({ handle: "taga", address: L2_ADDRESS, claimedAt: 1, pending: true })
    await render("/claim/taga")
    await getPendingStore().close(ACCOUNT, "failed_terminal")

    await click("Log out")
    expect(loadRegistrationTerms(ACCOUNT, "taga")).toBeNull()
  })
})

describe("the wallet owns signup", () => {
  const withStubbedAssign = async (run: (assign: ReturnType<typeof vi.fn>) => Promise<void>) => {
    h.config.campaignUrl = "https://launch.test.invalid"
    const assign = vi.fn()
    const real = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, assign, href: real.href, origin: real.origin, pathname: "/claim" },
    })
    try {
      await run(assign)
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real })
      h.config.campaignUrl = ""
    }
  }

  it("a bare visit lands on the wallet's own landing, with no tag to type", async () => {
    await withStubbedAssign(async (assign) => {
      await render("/claim")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(container.textContent).toContain("Create Account")
      expect(container.textContent).not.toContain("landing-signin")
    })
  })

  it("runs an Create Account tapped while the wallet started, once, busy from its first frame", async () => {
    await withStubbedAssign(async () => {
      setPreBootCreate(true)
      let land!: (draw: Awaited<ReturnType<typeof h.drawTag>>) => void
      h.drawTag.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
      try {
        await render("/claim")
        expect(button("Cancel")).toBeDefined()
        expect(container.textContent).not.toContain("I already have an account")
        expect(h.drawTag).toHaveBeenCalledTimes(1)
        expect(peekPreBootCreate()).toBe(false)
        await act(async () =>
          land({ tag: "brisk-otter", nameHash: NAME_HASH, grantToken: "draw-token", expiresAt: 0 }),
        )
        await settleReads()
        expect(h.drawTag).toHaveBeenCalledTimes(1)
        expect(sessionStorage.getItem("obsidion.drawn-offer")).toBe("brisk-otter")
        // A push, as for a tap after boot, so browser Back returns to the landing.
        expect(h.navigate).toHaveBeenCalledWith("/")
      } finally {
        setPreBootCreate(false)
      }
    })
  })

  const DraftHome = (props: Parameters<typeof OnboardingScreen>[0]) => (
    <OnboardingScreen {...props} embedded draftTag="brisk-otter" />
  )

  it("Back from Home drops the drawn tag, so the gate returns to the landing", async () => {
    sessionStorage.setItem("obsidion.drawn-offer", "brisk-otter")
    await withStubbedAssign(async () => {
      await render("/claim", DraftHome)
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click(),
      )
      expect(sessionStorage.getItem("obsidion.drawn-offer")).toBeNull()
      expect(h.createAccount).not.toHaveBeenCalled()
    })
  })

  it("keeps the drawn tag from Home, then makes the passkey and claims it at the free price", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: { ...CLAIM, terms: TERMS }, oxideAccount: ACCOUNT }
    })
    await withStubbedAssign(async () => {
      await render("/claim", DraftHome)
      expect(container.textContent).toContain("Hi, you’re@brisk-otter")
      expect(h.createAccount).not.toHaveBeenCalled()
      await click("Add passkey")
      await settleReads()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag.mock.calls[0][0]).toBe("brisk-otter")
      // The drawn tag must come back at the free price.
      expect(h.claimTag.mock.calls[0][5]).toBe(true)
      expect(loadWalletIdentity()).toMatchObject({ handle: "brisk-otter", pending: true })
      expect(JSON.parse(walletStorage.getItem("webwallet.registration.route")!)).toEqual({
        tag: "brisk-otter",
        route: "random",
      })
      expect(h.fireEvent).toHaveBeenCalledWith(
        "onboarding_account_created",
        expect.objectContaining({ mode: "create", route: "random" }),
      )
    })
  })

  it("ignores a shuffle that lands after a retried passkey on the kept tag", async () => {
    sessionStorage.setItem("obsidion.drawn-offer", "brisk-otter")
    sessionStorage.setItem("obsidion.name-grant", "draw-token")
    h.createAccount.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
    let land!: (draw: Awaited<ReturnType<typeof h.drawTag>>) => void
    h.drawTag.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
    await withStubbedAssign(async () => {
      await render("/claim", DraftHome)
      await click("Add passkey")
      await settleReads()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-testid="activation-reroll-tag"]')!.click(),
      )
      await click("Add passkey")
      await act(async () =>
        land({
          tag: "late-lynx",
          nameHash: `0x${"e1".repeat(32)}`,
          grantToken: "late-token",
          expiresAt: 0,
        }),
      )
      await settleReads()
      expect(sessionStorage.getItem("obsidion.drawn-offer")).not.toBe("late-lynx")
      expect(sessionStorage.getItem("obsidion.name-grant")).not.toBe("late-token")
      expect(h.claimTag.mock.calls[0]?.[0]).toBe("brisk-otter")
    })
  })

  it("prices its own tag, free for a verified past user", async () => {
    await withStubbedAssign(async () => {
      await render("/claim", DraftHome)
      expect(document.body.textContent).toContain("Used zk.money before?")
      expect(button(`Choose your own · ${PAY_PRICE}`)).toBeDefined()
    })
    act(() => root.unmount())
    root = createRoot(container)
    sessionStorage.setItem(
      "zkm.pastUserVerified",
      JSON.stringify({ account: `0x${"11".repeat(20)}`, proof: "0x", publicInputs: [] }),
    )
    await withStubbedAssign(async () => {
      await render("/claim", DraftHome)
      expect(document.body.textContent).toContain("Verified as past zk.money user")
      await click("Choose your own for free")
      await settleReads()
      expect(
        document.querySelector("dialog[aria-label='Choose your zk.money @tag']"),
      ).not.toBeNull()
      expect(h.createAccount).not.toHaveBeenCalled()
    })
  })

  it("picks its own tag from Home in the name sheet, and names the passkey after it", async () => {
    h.claimTag.mockImplementation(async (tag: string) => {
      await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
      return { kind: "pending", claim: { ...CLAIM, terms: TERMS }, oxideAccount: ACCOUNT }
    })
    await withStubbedAssign(async () => {
      await render("/claim", DraftHome)
      await click(`Choose your own · ${PAY_PRICE}`)
      await settleReads()
      expect(
        document.querySelector("dialog[aria-label='Choose your zk.money @tag']"),
      ).not.toBeNull()
      expect(document.body.textContent).not.toContain("Invite a friend")
      expect(h.createAccount).not.toHaveBeenCalled()

      await act(async () => {
        const input = document.querySelector<HTMLInputElement>("input[aria-label='Your tag']")!
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setValue.call(input, "river")
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await act(async () =>
        [...document.querySelectorAll("button")].find((b) => b.textContent === "Continue")!.click(),
      )
      await settleReads()
      expect(h.createAccount).not.toHaveBeenCalled()
      // A reload at the passkey step keeps the pick and its price.
      act(() => root.unmount())
      root = createRoot(container)
      await render("/claim", DraftHome)
      expect(container.textContent).toContain("Hi, you’re@river")
      // Every choice stays open until the passkey exists.
      expect(button("Shuffle tag")).toBeDefined()
      expect(button(`Choose your own · ${PAY_PRICE}`)).toBeDefined()
      expect(document.body.textContent).toContain("Used zk.money before?")
      await click("Add passkey")
      await settleReads()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag.mock.calls[0][0]).toBe("river")
      // Not the drawn tag: the paid price.
      expect(h.claimTag.mock.calls[0][5]).toBe(false)
      // Home asks for the deposit, so the identity is saved here rather than at a deposit step.
      expect(loadWalletIdentity()).toMatchObject({ handle: "river", pending: true })
      expect(JSON.parse(walletStorage.getItem("webwallet.registration.route")!)).toEqual({
        tag: "river",
        route: "paid",
      })
    })
  })

  it("reports each Create Account click and the drawn tag on the onboarding stream", async () => {
    const onboarding = () =>
      h.fireEvent.mock.calls.filter(([event]) =>
        ["onboarding_create_attempted", "onboarding_tag_drawn", "onboarding_failed"].includes(
          event,
        ),
      )
    h.drawTag.mockRejectedValueOnce(new Error("offline"))
    await withStubbedAssign(async () => {
      await render("/claim")
      await click("Create Account")
      await settleReads()
      await click("Create Account")
      await settleReads()
      expect(onboarding()).toEqual([
        ["onboarding_create_attempted", { attempt: "1" }],
        ["onboarding_failed", { step: "draw", code: "err" }],
        ["onboarding_create_attempted", { attempt: "2+" }],
        ["onboarding_tag_drawn"],
      ])
    })
  })

  it("a failed draw says so and keeps the landing", async () => {
    h.drawTag.mockRejectedValueOnce(new Error("offline"))
    await withStubbedAssign(async () => {
      await render("/claim")
      await click("Create Account")
      await settleReads()
      expect(container.textContent).toContain("Couldn't pick a tag for you")
      expect(container.textContent).toContain("Create Account")
      expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()
    })
  })

  it("a name grant stays in the wallet, including after closing the terms sheet", async () => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(h.routeGrantIsCurrent).toHaveBeenCalledWith("taga", "grant-token")
      expect(container.querySelector('[data-testid="invite-probe"]')?.textContent).toBe("true")

      await click("landing-signin")
      const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      expect(close).not.toBeNull()
      await act(async () => close!.click())

      expect(assign).not.toHaveBeenCalled()
      expect(h.navigate).toHaveBeenCalledWith("/claim/taga", { replace: true })
    })
  })

  it("clears a revoked grant and keeps the visitor on the field", async () => {
    sessionStorage.setItem("obsidion.name-grant", "revoked-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    h.routeGrantIsCurrent.mockResolvedValue(false)
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await settleReads()
      expect(h.routeGrantIsCurrent).toHaveBeenCalledWith("taga", "revoked-token")
      expect(sessionStorage.getItem("obsidion.name-grant")).toBeNull()
      expect(assign).not.toHaveBeenCalled()
      expect(container.textContent).toContain("landing-signin")
    })
  })

  it("keeps the grant when the validation request fails", async () => {
    sessionStorage.setItem("obsidion.name-grant", "grant-token")
    sessionStorage.setItem("obsidion.name-grant-handle", "taga")
    h.routeGrantIsCurrent.mockRejectedValue(new Error("offline"))
    await withStubbedAssign(async (assign) => {
      await render("/claim/taga")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(sessionStorage.getItem("obsidion.name-grant")).toBe("grant-token")
    })
  })

  it("an account this browser entered, still nameless, stays and names itself", async () => {
    // RegisterNameCard's entry: the bare /claim, with the campaign configured.
    const { setActiveCredentialId, setActiveStorageId } = await import(
      "../../../src/platform/storage/activeStorage"
    )
    saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
    setActiveStorageId("s")
    setActiveCredentialId("cred-bound")
    h.getAuthService.mockReturnValue({
      rootCredentialId: async () => "cred-newer",
      recoverFromCache: async () => undefined,
      clear: vi.fn(),
      lockOut: vi.fn(),
    })
    h.claimTag.mockResolvedValue({
      kind: "custody",
      confirmed: true,
      oxideAccount: ACCOUNT,
      claim: CLAIM,
    })
    await withStubbedAssign(async (assign) => {
      await render("/claim")
      await settleReads()
      expect(assign).not.toHaveBeenCalled()
      expect(container.textContent).toContain("landing-signin")

      await click("landing-signin")
      await clickDeposit()
      // The name lands on the account that entered: its passkey is asserted, none is minted.
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.collectOnboardingKeys).not.toHaveBeenCalled()
      expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
        h.aztec.obsidionWallet,
        L2_ADDRESS,
        { credentialId: "cred-bound" },
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Function),
      )
    })
  })

  describe("with a payment link stashed", () => {
    const LINK = "paylink-frag"
    beforeEach(() => {
      sessionStorage.setItem(CLAIM_STASH_KEY, LINK)
      h.viewLink.mockResolvedValue({ flavor: "direct", status: "unclaimed", claimableFrom: 0 })
    })
    const toLinkSignup = () =>
      expect(h.navigate).toHaveBeenCalledWith(`/link#${LINK}`, {
        replace: true,
        state: { receive: "account" },
      })

    it("Create Account with the link still open lands on the link's own signup, never a drawn tag", async () => {
      await withStubbedAssign(async () => {
        await render("/claim")
        await click("Create Account")
        await settleReads()
        expect(h.drawTag).not.toHaveBeenCalled()
        toLinkSignup()
        expect(h.navigate).not.toHaveBeenCalledWith("/")
      })
    })

    it("Create Account draws a tag as before once the link is claimed", async () => {
      h.viewLink.mockResolvedValue({ flavor: "direct", status: "claimed" })
      await withStubbedAssign(async () => {
        await render("/claim")
        await click("Create Account")
        await settleReads()
        expect(h.drawTag).toHaveBeenCalledTimes(1)
        expect(h.navigate).toHaveBeenCalledWith("/")
      })
    })

    it("a tag drawn before the link was stashed gives way to the link's signup", async () => {
      sessionStorage.setItem("obsidion.drawn-offer", "brisk-otter")
      await withStubbedAssign(async () => {
        await render("/claim", DraftHome)
        await settleReads()
      })
      toLinkSignup()
      expect(sessionStorage.getItem("obsidion.drawn-offer")).toBeNull()
      expect(h.createAccount).not.toHaveBeenCalled()
    })
  })
})

describe("pending step — passkey telemetry", () => {
  const events = () => passkeyEvents(h.fireEvent)
  type Gate = (opts?: unknown) => Promise<{ signal: AbortSignal; reach: string }>
  let harness: Awaited<ReturnType<typeof passkeyTelemetryHarness>>
  let pendingStore: typeof getPendingStore
  let renderPage: () => Promise<void>
  const seedPending = (over: Partial<PendingRegistrationRecord> = {}) =>
    pendingStore().upsert(ACCOUNT, {}, baseRecord(over))

  /** The retry's sign-in: past the gate it asks through the tracker and waits for the test. */
  const heldRetry = () => {
    const held: { request?: HeldRequest } = {}
    h.reusePasskeyAccount.mockImplementation(
      async (
        _w: unknown,
        _a: unknown,
        _h: unknown,
        gate: Gate,
        _signal?: AbortSignal,
        own?: PasskeyRequestScope,
      ) => {
        const { signal } = await gate()
        held.request = harness.request("assert", signal, own)
        await held.request.settled
        return fakeKeys
      },
    )
    return held
  }
  /** A gate that passes at once with a signal its cancel aborts; `steps` keeps its steps up once asked. */
  const passingGate = (steps = false) => {
    const controller = new AbortController()
    let asked = false
    h.gateHook = () => ({
      gate: async () => {
        asked = true
        return { signal: controller.signal, reach: "unknown" as const }
      },
      state:
        steps && asked
          ? { kind: "awaiting-action", proceed: () => {}, reach: "unknown", prompt: "phone-steps" }
          : { kind: "idle" },
      cancel: () => controller.abort(),
      dismiss: () => {},
    })
  }
  const leaveAtOnce = (press: () => void) => {
    act(() => {
      press()
      root.unmount()
      pageHide()
    })
    root = createRoot(container)
  }

  beforeEach(async () => {
    // An attempt an earlier test left open ends here, before this test counts anything.
    pageHide()
    h.fireEvent.mockClear()
    // A fresh page load: its own tracker, so attempt numbers and once-per-page events start over.
    vi.resetModules()
    await openHostSession(await pageModules())
    const { OnboardingScreen: Screen } = await import(
      "../../../src/features/onboarding/OnboardingScreen"
    )
    ;({ getPendingStore: pendingStore } = await import(
      "../../../src/features/onboarding/webRegistration"
    ))
    await pendingStore().load()
    harness = await passkeyTelemetryHarness()
    renderPage = () => render("/claim", Screen)
  })

  it("Cancel at the retry's steps during its request sends one cancel, and nothing once the screen and page go", async () => {
    passingGate(true)
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(held.request).toBeDefined()
    leaveAtOnce(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="phone-steps-cancel"]')!.click(),
    )
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "onboarding",
        outcome: "cancelled",
        reason: "in_app_cancel",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("the record moving on while the retry's request is pending sends nothing for it", async () => {
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(held.request).toBeDefined()
    await act(async () => {
      await pendingStore().upsert(ACCOUNT, { phase: "funded", fundedAt: Date.now() })
    })
    await act(async () => held.request!.reject(new DOMException("closed", "NotAllowedError")))
    act(() => pageHide())
    expect(events()).toEqual([])
  })

  it("the record failing while the retry waits at the phone steps sends nothing", async () => {
    let asked = false
    let rejectGate: (error: Error) => void = () => {}
    h.gateHook = () => ({
      gate: () => {
        asked = true
        return new Promise<{ signal: AbortSignal; reach: "unknown" }>(
          (_, reject) => (rejectGate = reject),
        )
      },
      state: asked
        ? { kind: "awaiting-action", proceed: () => {}, reach: "unknown", prompt: "phone-steps" }
        : { kind: "idle" },
      cancel: () => {},
      dismiss: () => rejectGate(new GateCancelledError()),
    })
    h.reusePasskeyAccount.mockImplementation(
      async (_w: unknown, _a: unknown, _h: unknown, gate: Gate) => {
        await gate()
        return fakeKeys
      },
    )
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    expect(container.querySelector('[data-testid="phone-steps"]')).not.toBeNull()
    await act(async () => {
      await pendingStore().close(ACCOUNT, "failed_terminal")
    })
    await settleReads()
    act(() => pageHide())
    expect(events()).toEqual([])
  })

  it("a second Retry while the first is asking starts nothing, and one attempt is sent", async () => {
    const held = heldRetry()
    await seedPending({ broadcast: false })
    await renderPage()
    await click("Retry")
    const busyRetry = button("Confirm your passkey…")
    expect(busyRetry?.disabled).toBe(true)
    await act(async () => busyRetry!.click())
    expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
    await act(async () => held.request!.answer())
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({ outcome: "succeeded", prompts: "1", attempt: "1" }),
    ])
  })

  it("a ticket signup resuming on its bound passkey reports a sign-in, not a creation", async () => {
    screenProps = { ticketSignup: true }
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: String(2n * 10n ** 18n),
      schedule: { fee: String(10n ** 18n / 2n), minDeposit: "0" },
      memo: "Pizza dinner",
    })
    saveTicketSignupAccount("localhost", "id:paylink-frag", {
      credentialId: "ticket-a",
      l2Address: L2_ADDRESS,
      tag: "taga",
    })
    passingGate()
    h.reusePasskeyAccount.mockImplementation(
      async (
        _w: unknown,
        _a: unknown,
        _h: unknown,
        gate: Gate,
        _signal?: AbortSignal,
        own?: PasskeyRequestScope,
      ) => {
        await gate()
        await harness.answered("assert", own)
        return fakeKeys
      },
    )
    await renderPage()
    await click("Continue with your passkey")
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "onboarding",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })

  it("claiming the payment from the pending step recovers the passkey and reports it", async () => {
    screenProps = { ticketSignup: true }
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: String(2n * 10n ** 18n),
      schedule: { fee: String(10n ** 18n / 2n), minDeposit: "0" },
      memo: "Pizza dinner",
      amount: String(20n * 10n ** 18n),
    })
    await seedPending()
    saveRegistrationTerms({
      account: ACCOUNT,
      tag: "taga",
      deadline: Math.floor(Date.now() / 1000) + 7200,
      fee: String(10n ** 18n / 2n),
      minDeposit: "0",
      feeWaived: true,
      paylinkFunded: true,
      paylinkId: "id:paylink-frag",
    })
    passingGate()
    h.reusePasskeyAccount.mockImplementation(
      async (
        _w: unknown,
        _a: unknown,
        _h: unknown,
        gate: Gate,
        _signal?: AbortSignal,
        own?: PasskeyRequestScope,
      ) => {
        await gate()
        await harness.answered("assert", own)
        return fakeKeys
      },
    )
    await renderPage()
    await settleReads()
    await click("Claim your payment")
    await settleReads()
    expect(events()).toEqual([
      expect.objectContaining({
        ceremony: "sign_in",
        flow: "onboarding",
        outcome: "succeeded",
        prompts: "1",
        attempt: "1",
      }),
    ])
  })
})

describe("deposit terms step — before any passkey prompt", () => {
  it("closes paid terms from outside, Escape or the X before creating an account", async () => {
    await render("/claim/taga")
    await click("landing-signin")
    expect(container.textContent).toContain("Get instant access")
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()

    // An outside click closes it like the X.
    const dialog = container.querySelector("dialog")!
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(container.querySelector("dialog")).toBeNull()
    expect(h.navigate).toHaveBeenCalledWith("/claim", { replace: true })
    expect(h.createAccount).not.toHaveBeenCalled()
    expect(h.claimTag).not.toHaveBeenCalled()
    expect(getPendingStore().current()).toBeNull()

    await click("landing-signin")
    expect(container.textContent).toContain("Get instant access")
  })

  it("a link stashed for an ordinary claim on Home leaves the signup on its own schedule", async () => {
    sessionStorage.setItem(CLAIM_STASH_KEY, "paylink-frag")
    h.amounts = { ...PAID }
    try {
      await render("/claim/taga")
      await click("landing-signin")
      await settleReads()
      const text = container.textContent!
      expect(text).toContain("Get instant access")
      expect(text).toContain(`Total to send${ask("standard")}`)
      expect(text).not.toContain("This payment covers your account")
      expect(text).not.toContain("Welcome")
      expect(button(`Deposit ${ask("standard")}`)).toBeTruthy()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
    } finally {
      h.amounts = { min: 0n, fee: 0n }
    }
  })

  describe("a ticket-funded signup (the link pays for the account)", () => {
    const ONE = 10n ** 18n
    /** The signer marks a ticket's terms as such; a reduced flag alone is an earned tag. */
    const TICKET_CLAIM = {
      ...WAIVED_CLAIM,
      terms: { ...WAIVED_CLAIM.terms, reduced: true, ticket: true },
    }
    beforeEach(() => {
      screenProps = { ticketSignup: true }
    })
    /** The phone CTA for the default 20.00 DAI note. */
    const TICKET_CTA = "Claim @taga and 20.00 DAI"
    /** The visitor page stashes the note's amount with every new ticket signup; `null` omits it. */
    const ticketStash = (
      over: { fragment?: string; amount?: bigint | null; threshold?: bigint } = {},
    ) =>
      stashTicketSignup({
        fragment: over.fragment ?? "paylink-frag",
        threshold: (over.threshold ?? 2n * ONE).toString(),
        schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
        memo: "Pizza dinner",
        ...(over.amount !== null ? { amount: (over.amount ?? 20n * ONE).toString() } : {}),
      })
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
      .set!
    const typeTag = (tag: string) =>
      act(async () => {
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Your tag"]')
        if (!input) throw new Error("no tag field")
        setValue.call(input, tag)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
    /** The welcome step: the card's welcome on a phone, the creation sheet on a laptop. */
    const expectWelcomeStep = () =>
      expect(
        container.textContent!.includes("Welcome taga!") ||
          container.querySelector('[data-testid="phone-steps"]') !== null,
      ).toBe(true)
    /** Tag step → welcome step → the ceremony's CTA. */
    const walkToPasskey = async () => {
      await render("/claim")
      if (container.querySelector('input[aria-label="Your tag"]')) {
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        expectWelcomeStep()
      }
      expect(container.textContent).not.toContain("Deposit")
      // A phone's tag step already started the passkey.
      const cta = ["Continue with your passkey", "Continue", TICKET_CTA].find((l) => button(l))
      if (cta) await click(cta)
    }
    const pendingClaim = (claim: unknown, recordOver: Partial<PendingRegistrationRecord> = {}) =>
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, ...recordOver }))
        return { kind: "pending", claim, oxideAccount: ACCOUNT }
      })

    describe("with no ticket for the link (it pays the name's own price)", () => {
      /** The visitor page's marker for a link with no ticket: the typed name's own schedule. */
      const paidStash = (amount = 20n * ONE) =>
        stashTicketSignup({
          fragment: "paylink-frag",
          paid: true,
          schedule: { fee: String(425n * 10n ** 16n), minDeposit: String(15n * 10n ** 16n) },
          amount: amount.toString(),
        })
      const DEPOSIT_LINK = {
        fragment: "paylink-frag",
        amount: 20n * ONE,
        proverTip: 10n ** 18n,
        speed: "faster",
      }
      const STANDARD_CLAIM = { ...CLAIM, terms: { ...WAIVED_CLAIM.terms!, reduced: false } }

      it("picks any name at its price on the same modal, and the link pays it with the tip", async () => {
        paidStash()
        h.claimTag.mockImplementation(async (tag: string) => {
          await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
          return {
            kind: "pending",
            claim: STANDARD_CLAIM,
            oxideAccount: ACCOUNT,
            depositLink: DEPOSIT_LINK,
          }
        })
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        const cta = ["Continue with your passkey", "Continue", TICKET_CTA].find((l) => button(l))
        if (cta) await click(cta)
        await settleReads()
        // No ticket is redeemed: the link pays the deposit, with the tip its split committed.
        expect((h.claimTag.mock.calls[0] as unknown[]).slice(8)).toEqual([null, DEPOSIT_LINK])
        expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
          paylinkFunded: true,
          paylinkDeposit: true,
          paylinkId: "id:paylink-frag",
          proverTip: String(10n ** 18n),
        })
        expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])?.activation.state).toBe(
          "ready",
        )
        expect(enteredWallet()).toBe(true)
      })

      it("a quote the link cannot cover enters at the name's price, and Home claims the link as any other", async () => {
        paidStash()
        h.claimTag.mockImplementation(async (tag: string) => {
          await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
          return { kind: "pending", claim: STANDARD_CLAIM, oxideAccount: ACCOUNT }
        })
        await walkToPasskey()
        await settleReads()
        expect(loadRegistrationTerms(ACCOUNT, "taga")).not.toHaveProperty("paylinkId")
        expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()
        expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
        expect(enteredWallet()).toBe(true)
      })
    })

    it("shows the ticket's tag free though its fee is above the live sweep fee", async () => {
      ticketStash({ amount: 20n * ONE })
      const skim = h.skim
      h.skim = ONE / 4n
      try {
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        expect(
          container.querySelector('[data-testid="paylink-signup-tag-price"]')?.textContent,
        ).toBe("Free with ticket")
      } finally {
        h.skim = skim
      }
    })

    it("prices the split at the tip it commits, keeps that tip for the terms, and at Standard while it is quoted", async () => {
      ticketStash({ amount: 20n * ONE })
      const split = (id: string) =>
        container.querySelector(`[data-testid="paylink-signup-${id}"]`)?.textContent ?? ""
      try {
        splitTip.value = 0n
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        const kept = parseFloat(split("balance-after"))
        const fee = parseFloat(split("network-fee"))
        expect(JSON.parse(sessionStorage.getItem(TICKET_STASH_KEY)!).proverTip).toBe("0")

        splitTip.value = 10n ** 18n
        await render("/claim")
        expect(parseFloat(split("balance-after"))).toBeCloseTo(kept - 1)
        expect(parseFloat(split("network-fee"))).toBeCloseTo(fee + 1)
        expect(JSON.parse(sessionStorage.getItem(TICKET_STASH_KEY)!).proverTip).toBe(
          (10n ** 18n).toString(),
        )

        // The quote refines the split once it answers; until then nothing holds on it.
        splitTip.value = undefined
        await render("/claim")
        expect(parseFloat(split("network-fee"))).toBeCloseTo(fee)
        expect(parseFloat(split("balance-after"))).toBeCloseTo(kept)
      } finally {
        splitTip.value = 10n ** 18n
      }
    })

    describe("after the tag, before and after the passkey", () => {
      const claimCta = () => buttons().find((b) => /^Claim (@|tag)/.test(b.textContent ?? ""))

      it("enables the claim before the tip quote answers, and a passkey then commits Standard", async () => {
        ticketStash({ amount: 20n * ONE })
        pendingClaim(TICKET_CLAIM)
        try {
          splitTip.value = undefined
          await render("/claim")
          await typeTag("taga")
          await settleReads()
          expect(claimCta()?.disabled).toBe(false)
          await walkToPasskey()
          expect(h.createAccount).toHaveBeenCalledTimes(1)
          expect(JSON.parse(sessionStorage.getItem(TICKET_STASH_KEY)!)).toMatchObject({
            proverTip: "0",
            speed: "standard",
          })
          expect(h.claimTag.mock.calls[0]?.[8]).toMatchObject({ proverTip: "0", speed: "standard" })
        } finally {
          splitTip.value = 10n ** 18n
        }
      })

      it("names each stage of the claim after the passkey instead of one label", async () => {
        ticketStash({ amount: 20n * ONE })
        let stage!: (s: string) => void
        h.claimTag.mockImplementationOnce(
          (_tag: string, _keys: unknown, _config: unknown, _wallet: unknown, onStage: never) => {
            stage = onStage
            return new Promise(() => {})
          },
        )
        await walkToPasskey()
        const text = () => container.textContent ?? ""
        expect(text()).toContain("Checking your payment…")
        await act(async () => stage("claim"))
        expect(text()).toContain("Checking your payment…")
        await act(async () => stage("ticket_prove"))
        expect(text()).toContain("Proving your ticket…")
        await act(async () => stage("reserve"))
        expect(text()).toContain("Reserving @taga…")
        await act(async () => stage("derive"))
        expect(text()).toContain("Setting up @taga…")
        expect(text()).not.toContain("Using your paylink")
        // Analytics keeps the registration session's own stages.
        const stages = h.fireEvent.mock.calls
          .filter(([event]) => event === "onboarding_oxide_stage")
          .map(([, props]) => (props as { stage: string }).stage)
        expect(stages).toEqual(["claim", "derive"])
      })

      it("says when the network fee stays unread, and reads it again on Try again", async () => {
        ticketStash({ amount: 20n * ONE })
        const skim = h.skim
        vi.useFakeTimers()
        try {
          h.skim = undefined as unknown as bigint
          await render("/claim")
          await typeTag("taga")
          expect(claimCta()?.disabled).toBe(true)
          expect(container.textContent).not.toContain("network fee…")
          await act(async () => void (await vi.advanceTimersByTimeAsync(CHAIN_READ_RETRY_MS + 50)))
          expect(container.textContent).toContain("Still checking the network fee…")
          for (let tick = 1; tick < CHAIN_READ_RETRIES; tick++) {
            await act(async () => void (await vi.advanceTimersByTimeAsync(CHAIN_READ_RETRY_MS)))
          }
          expect(container.textContent).toContain("Couldn't check the network fee.")
          expect(claimCta()?.disabled).toBe(true)

          h.skim = skim
          await click("Try again")
          expect(container.textContent).not.toContain("network fee")
          expect(claimCta()?.disabled).toBe(false)
        } finally {
          h.skim = skim
        }
      })
    })

    describe("the threshold, before any passkey", () => {
      /** The CTA on either posture: a laptop's creation sheet, a phone's card. */
      const passkeyCta = () =>
        button("Continue") ??
        buttons().find((b) => b.textContent?.startsWith("Claim @taga and ")) ??
        button("Create another passkey")
      const walkToWelcome = async () => {
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        expectWelcomeStep()
      }
      /** A held split keeps the tag step's claim button disabled, on either posture. */
      const walkToTag = async () => {
        await render("/claim")
        await typeTag("taga")
        await settleReads()
      }
      const claimCta = () => buttons().find((b) => /^Claim (@|tag)/.test(b.textContent ?? ""))
      const PHONE_UA =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

      it.each(["laptop"])(
        "a note below the threshold that covers the deposit opens no passkey (%s)",
        async (posture) => {
          const ua =
            posture === "phone"
              ? vi.spyOn(navigator, "userAgent", "get").mockReturnValue(PHONE_UA)
              : undefined
          try {
            // 4 covers the 2.61 burn at the 0.5 cut; the threshold asks for 5.
            ticketStash({ amount: 4n * ONE, threshold: 5n * ONE })
            pendingClaim(TICKET_CLAIM)
            await walkToTag()
            expect(container.textContent).toContain(
              "This payment is below the 5 DAI minimum for a new account.",
            )
            expect(container.textContent).not.toContain("cannot cover the account deposit")
            expect(claimCta()?.disabled).toBe(true)
            await act(async () => claimCta()!.click())
            expect(h.createAccount).not.toHaveBeenCalled()
            expect(h.claimTag).not.toHaveBeenCalled()
            expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toBeNull()
          } finally {
            ua?.mockRestore()
          }
        },
      )

      it("a ticket note that cannot cover the account deposit opens no passkey", async () => {
        ticketStash({ amount: ONE, threshold: ONE / 2n })
        await walkToTag()
        expect(container.textContent).toContain("This payment cannot cover the account deposit.")
        expect(claimCta()?.disabled).toBe(true)
      })

      it("a paid link too small for the name goes on to an ordinary deposit", async () => {
        stashTicketSignup({
          fragment: "paylink-frag",
          paid: true,
          schedule: { fee: String(425n * 10n ** 16n), minDeposit: String(15n * 10n ** 16n) },
          amount: ONE.toString(),
        })
        pendingClaim(CLAIM)
        await walkToWelcome()
        expect(container.textContent).not.toContain("cannot cover the account deposit")
        expect(container.textContent).toContain("so you deposit for it")
        expect(passkeyCta()?.disabled).toBe(false)
        await act(async () => passkeyCta()!.click())
        expect(h.createAccount).toHaveBeenCalledTimes(1)
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      })

      it("a note exactly at the threshold opens the passkey", async () => {
        ticketStash({ amount: 5n * ONE, threshold: 5n * ONE })
        pendingClaim(TICKET_CLAIM)
        await walkToWelcome()
        expect(container.textContent).not.toContain("minimum for a new account")
        expect(passkeyCta()?.disabled).toBe(false)
        await act(async () => passkeyCta()!.click())
        expect(h.createAccount).toHaveBeenCalledTimes(1)
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      })

      it("an unread amount opens no passkey", async () => {
        ticketStash({ amount: null })
        await walkToTag()
        expect(container.textContent).toContain("Couldn't check this payment's amount")
        expect(claimCta()?.disabled).toBe(true)
        await act(async () => claimCta()!.click())
        expect(h.createAccount).not.toHaveBeenCalled()
      })

      it("a retry checks the threshold again instead of trusting the button it came from", async () => {
        // The first attempt is refused at the gate, before any attempt is saved, and the note
        // read since then no longer clears the threshold.
        const gate = vi.fn(async () => {
          updateTicketSignup({ amount: (4n * ONE).toString() })
          throw new ScreenPhoneRequiredError()
        })
        h.gateHook = () => ({ gate, state: { kind: "idle" }, cancel: () => {}, dismiss: () => {} })
        ticketStash({ amount: 20n * ONE, threshold: 5n * ONE })
        await walkToWelcome()
        await act(async () => passkeyCta()!.click())
        await settleReads()
        expect(gate).toHaveBeenCalledTimes(1)
        expect(container.querySelector('[data-testid="create-refused"]')).not.toBeNull()
        expect(container.textContent).toContain("below the 5 DAI minimum")
        expect(container.textContent).not.toContain("cannot cover the account deposit")
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[data-testid="create-retry"]')!.click(),
        )
        expect(gate).toHaveBeenCalledTimes(1)
        expect(h.createAccount).not.toHaveBeenCalled()
        expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toBeNull()
      })

      it("a registration the ticket already bought resumes after the threshold rose past the note", async () => {
        ticketStash({ amount: ONE, threshold: 5n * ONE })
        await seedRecord({ tag: "taga" })
        saveRegistrationTerms({
          account: ACCOUNT,
          tag: "taga",
          deadline: Math.floor(Date.now() / 1000) + 7200,
          fee: String(ONE / 2n),
          minDeposit: "0",
          feeWaived: true,
          paylinkFunded: true,
          paylinkId: "id:paylink-frag",
        })
        await render("/claim")
        await settleReads()
        expect(container.textContent).toContain("@taga")
        expect(container.textContent).not.toContain("minimum for a new account")
        expect(h.createAccount).not.toHaveBeenCalled()
      })
    })

    it("recovers the saved ticket account after key collection fails", async () => {
      ticketStash()
      h.collectOnboardingKeys.mockRejectedValueOnce(new Error("wallet is locked"))
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAccount("localhost", "id:paylink-frag")?.credentialId).toBe(
        "new-ticket-passkey",
      )
      await act(async () => root.unmount())
      root = createRoot(container)
      sessionStorage.clear()
      ticketStash()
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    /** The session writes its checkpoint the way `claimTag` does, then dies before the outcome. */
    const interruptedAfterCheckpoint = () =>
      h.claimTag.mockImplementationOnce(
        async (
          tag: string,
          _keys: unknown,
          _config: unknown,
          _wallet: unknown,
          _onStage: unknown,
          earned: unknown,
          _refunded: unknown,
          _replaced: unknown,
          ticket: unknown,
        ) => {
          await seedRecord({ tag })
          saveRegistrationTerms(
            realOxideOnboarding.checkpointRegistrationTerms(ACCOUNT, tag, TICKET_CLAIM as never, {
              earnedExpected: earned === true,
              ticket: ticket as never,
            }),
          )
          throw new Error("interrupted after checkpoint")
        },
      )

    it("a same-wizard retry resumes a registration interrupted after its checkpoint without signing another claim", async () => {
      ticketStash()
      interruptedAfterCheckpoint()
      await walkToPasskey()
      expect(button("claim-tag")).toBeTruthy()
      await click("claim-tag")
      expect(container.textContent).toContain("@taga")
      expect(button("claim-tag")).toBeUndefined()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    it("a reopen after the checkpoint resumes the bound registration without another proof or claim", async () => {
      ticketStash()
      interruptedAfterCheckpoint()
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
      await act(async () => root.unmount())
      root = createRoot(container)
      sessionStorage.clear()
      ticketStash()
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("@taga")
      expect(container.textContent).not.toContain("Pick any name, free")
      expect(button("Continue with your passkey")).toBeUndefined()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    it("a refused attempt write prevents opening the authenticator", async () => {
      ticketStash()
      testWalletDbs().onApply = (_version, ops) => {
        if (ops.some(([key]) => key.startsWith("obsidion.ticket-signup.account:")))
          throw new DOMException("full", "QuotaExceededError")
      }
      await walkToPasskey()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    it("a failed binding write preserves the incomplete attempt and requires an explicit restart", async () => {
      ticketStash()
      let refuse = true
      testWalletDbs().onApply = async (_version, ops) => {
        const binding = ops.some(
          ([key, value]) =>
            key.startsWith("obsidion.ticket-signup.account:") &&
            JSON.parse(value ?? "{}").credentialId,
        )
        if (refuse && binding) {
          // A real transaction fails after the flow has moved on, not within a microtask.
          await new Promise((resolve) => setTimeout(resolve, 20))
          throw new DOMException("full", "QuotaExceededError")
        }
      }
      await walkToPasskey()
      // Let the refused write settle.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
      refuse = false
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toMatchObject({
        phase: "creating",
      })
      await act(async () => root.unmount())
      root = createRoot(container)
      ticketStash()
      await render("/claim")
      expect(container.textContent).toContain("No ticket was redeemed")
      expect(button("Create another passkey")).toBeTruthy()
      expect(button(TICKET_CTA)).toBeUndefined()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      pendingClaim(TICKET_CLAIM)
      await click("Create another passkey")
      expect(h.createAccount).toHaveBeenCalledTimes(2)
      expect(h.claimTag).toHaveBeenCalledTimes(1)
    })

    it("in a phone browser the in-app rule misses, a refused create points back to the payment link, and its retry restarts the attempt", async () => {
      const startUrl = window.location.href
      const ua = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(
          "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
        )
      window.history.replaceState(null, "", "/link#paylink-frag")
      try {
        h.hasRootBreadcrumb = false
        ticketStash()
        h.createAccount.mockRejectedValueOnce(
          new DOMException("Error connecting to Web Authentication service", "NotSupportedError"),
        )
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        expect(container.querySelector('[data-testid="create-in-app-notice"]')).toBeNull()
        await settleReads()
        const card = container.querySelector<HTMLElement>('[data-testid="create-refused"]')
        expect(card?.dataset.reason).toBe("NotSupportedError")
        const escape = container.querySelector<HTMLElement>('[data-testid="open-in-browser"]')
        expect(escape?.dataset.escape).toBe("hint")
        expect(container.querySelector('[data-testid="open-in-browser-link"]')).toBeNull()
        expect(container.innerHTML).not.toContain("paylink-frag")
        expect(container.textContent).toContain("No ticket was redeemed")
        expect(container.querySelector('[data-testid="create-retry"]')).toBeNull()
        expect(button("Create another passkey")?.dataset.style).toBe("dark")

        pendingClaim(TICKET_CLAIM)
        await click("Create another passkey")
        expect(h.createAccount).toHaveBeenCalledTimes(2)
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      } finally {
        ua.mockRestore()
        window.history.replaceState(null, "", startUrl)
      }
    })

    it("in an iPhone app's browser, the sheet shows the card alone before any request, with nothing to create", async () => {
      const startUrl = window.location.href
      const ua = vi
        .spyOn(navigator, "userAgent", "get")
        .mockReturnValue(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.80",
        )
      window.history.replaceState(null, "", "/link#paylink-frag")
      try {
        h.hasRootBreadcrumb = false
        ticketStash()
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        expect(container.querySelector('[data-testid="create-in-app-notice"]')).not.toBeNull()
        // The payment lives in the address's fragment, which no link can carry: the app's menu.
        const escape = container.querySelector<HTMLElement>('[data-testid="open-in-browser"]')
        expect(escape?.dataset.escape).toBe("hint")
        expect(container.querySelector('[data-testid="open-in-browser-link"]')).toBeNull()
        expect(container.textContent).not.toContain("Welcome taga!")
        expect(container.textContent).not.toContain("Pizza dinner")
        expect(button(TICKET_CTA)).toBeUndefined()
        expect(h.createAccount).not.toHaveBeenCalled()
        expect(h.claimTag).not.toHaveBeenCalled()
      } finally {
        ua.mockRestore()
        window.history.replaceState(null, "", startUrl)
      }
    })

    it("a stale tab cannot restart an attempt another tab already restarted", async () => {
      ticketStash()
      const first = await beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await render("/claim")
      await settleReads()
      expect(button("Create another passkey")).toBeTruthy()
      // Another tab restarts the same attempt and opens its own ceremony.
      restartTicketSignupAccount("localhost", "id:paylink-frag", first.attemptId)
      const second = await beginTicketSignupAccount("localhost", "id:paylink-frag", "taga")
      await click("Create another passkey")
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(loadTicketSignupAttempt("localhost", "id:paylink-frag")).toEqual(second)
      expect(container.textContent).toContain("restarted in another tab")
      expect(button("Create another passkey")).toBeTruthy()
      // The other tab's ceremony completes and binds the account this link continues with.
      await completeTicketSignupAccount("localhost", "id:paylink-frag", second.attemptId, {
        credentialId: "other-tab-passkey",
        l2Address: L2_ADDRESS,
      })
      expect(loadTicketSignupAccount("localhost", "id:paylink-frag")).toEqual({
        credentialId: "other-tab-passkey",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
    })

    it("resumes ticket A and pins status checks when an unrelated record is newer", async () => {
      ticketStash()
      saveTicketSignupAccount("localhost", "id:paylink-frag", {
        credentialId: "ticket-a",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
      await seedRecord({ tag: "taga", startTime: Date.now() - 60000 })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: String(ONE / 2n),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      const OTHER = "0x00000000000000000000000000000000000000bb"
      await getPendingStore().upsert(
        OTHER,
        {},
        baseRecord({ tag: "tagb", l2Address: `0x${"ef".repeat(32)}` }),
      )
      await render("/claim")
      await settleReads()
      expect(container.textContent).not.toContain("Pick any name, free")
      expect(container.textContent).toContain("@taga")
      expect(container.textContent).not.toContain("@tagb")
      h.runDetectionTick.mockClear()
      await clickCheck()
      expect(h.runDetectionTick).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          expectedRecord: { account: ACCOUNT, nameHash: NAME_HASH },
        }),
      )
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(getPendingStore().get(OTHER)?.phase).toBe("awaiting_deposit")
    })

    it("recovers the bound account before loading its registration after an account switch", async () => {
      const { setActiveStorageId } = await import("../../../src/platform/storage/activeStorage")
      setActiveStorageId("account-a")
      await walletStorage.flush()
      await getPendingStore().reload()
      ticketStash()
      saveTicketSignupAccount("localhost", "id:paylink-frag", {
        credentialId: "ticket-a",
        l2Address: L2_ADDRESS,
        tag: "taga",
      })
      await seedRecord({ tag: "taga" })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: String(ONE / 2n),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      setActiveStorageId("account-b")
      await walletStorage.flush()
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      await getPendingStore().upsert(
        "0x00000000000000000000000000000000000000bb",
        {},
        baseRecord({ tag: "tagb", l2Address: `0x${"ef".repeat(32)}` }),
      )
      await render("/claim")
      expect(container.textContent).toContain("Continue your signup")
      expect(container.textContent).not.toContain("Pick any name, free")
      h.reusePasskeyAccount.mockImplementationOnce(async () => {
        setActiveStorageId("account-a")
        await walletStorage.flush()
        return fakeKeys
      })
      h.reloadIfSessionSwitched.mockReturnValueOnce(true)
      await click("Continue with your passkey")
      expect(h.reusePasskeyAccount).toHaveBeenCalledWith(
        h.aztec.obsidionWallet,
        L2_ADDRESS,
        { credentialId: "ticket-a" },
        expect.any(Function),
        expect.any(AbortSignal),
        expect.any(Function),
      )
      expect(h.reloadIfSessionSwitched).toHaveBeenCalledWith("account-b", L2_ADDRESS)
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      await act(async () => root.unmount())
      root = createRoot(container)
      ;(PendingRegistrationStore as unknown as { instance: unknown }).instance = null
      await getPendingStore().load()
      await render("/claim")
      expect(container.textContent).toContain("@taga")
      expect(container.textContent).not.toContain("Pick any name, free")
      expect(h.claimTag).not.toHaveBeenCalled()
    })

    /** The option a gate call was handed by the screen's own sheet. */
    const pickOf = (options: unknown) => (options as GateOptions | undefined)?.unheld?.choice
    /** A gate that resolves on the option the sheet picked, as the real one does while it is offered. */
    const pickingGate = () =>
      vi.fn(async (options?: unknown) => {
        const choice = pickOf(options)
        return {
          signal: new AbortController().signal,
          reach: "unknown" as const,
          choice,
          route: choice && routeForChoice(choice),
        }
      })
    const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const clickId = (id: string) =>
      act(async () => {
        const target = byId(id)
        if (!target) throw new Error(`no control "${id}"`)
        target.click()
      })
    /** Picks `choice` on the sheet's dropdown. */
    const pickOption = async (choice: SignUpChoice) => {
      await clickId("phone-steps-choice")
      await clickId(`phone-steps-option-${choice}`)
    }
    /** The options the sheet's dropdown offers; it is closed again on the one already picked. */
    const offered = async () => {
      await clickId("phone-steps-choice")
      const ids = [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((o) =>
        o.dataset.testid?.replace("phone-steps-option-", ""),
      )
      await act(async () =>
        container.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!.click(),
      )
      return ids
    }
    const credentials = Object.getOwnPropertyDescriptor(navigator, "credentials")
    /** 1Password's script answers the page's passkey creation, or another manager's. */
    const extensionAnswers = (script: () => unknown = onePasswordCreate) =>
      Object.defineProperty(navigator, "credentials", {
        value: { create: script() },
        configurable: true,
      })
    afterEach(() => {
      if (credentials) Object.defineProperty(navigator, "credentials", credentials)
      else delete (navigator as { credentials?: unknown }).credentials
    })

    it.each([["key", "security-key"]] as const)(
      "the ticket sheet's %s creates the account on its route",
      async (choice, route) => {
        ticketStash({ amount: 20n * ONE })
        h.getAuthService.mockReturnValue({ recoverFromCache: async () => undefined })
        pendingClaim(TICKET_CLAIM)
        const gate = pickingGate()
        h.gateHook = () => ({ gate, state: { kind: "idle" }, cancel: () => {}, dismiss: () => {} })
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        expect(byId("phone-steps")?.dataset.choice).toBe("phone")
        await pickOption(choice)
        // A pick only changes the sheet; its Continue creates.
        expect(gate).not.toHaveBeenCalled()
        await clickId("phone-steps-continue")
        expect(gate.mock.calls[0]?.[0]).toMatchObject({ purpose: "create", unheld: { choice } })
        expect(h.createAccount.mock.calls[0]?.[5]).toMatchObject({ route })
      },
    )

    it("the ticket sheet shows no option until the browser says what it reaches and allows", async () => {
      ticketStash({ amount: 20n * ONE })
      let answer!: (reach: string) => void
      h.getAuthService.mockReturnValue({
        recoverFromCache: async () => undefined,
        probePhoneReach: () => new Promise((resolve) => (answer = resolve)),
      })
      await render("/claim")
      await typeTag("taga")
      await clickClaimTag()
      await settleReads()
      // Nothing to pick yet: a waiting button where the picker will be, so no option is shown only
      // to be replaced once the browser answers.
      expect(byId("phone-steps-loading")).not.toBeNull()
      expect(byId("phone-steps-continue")).toBeNull()
      expect(byId("phone-steps-choice")).toBeNull()
      // Nothing warns above the sheet.
      expect(container.querySelector('[data-testid="passkey-loss-notice"]')).toBeNull()
      // A browser that reaches no phone is offered its key alone, never a phone it cannot use.
      await act(async () => answer("no-hybrid"))
      expect(byId("phone-steps-loading")).toBeNull()
      expect((byId("phone-steps-continue") as HTMLButtonElement | null)?.disabled).toBe(false)
      expect(byId("phone-steps")?.dataset.choice).toBe("key")
      expect(byId("phone-steps-choice")).toBeNull()
      expect(h.createAccount).not.toHaveBeenCalled()
    })

    describe("on a laptop allowed to create on its own password manager", () => {
      const MAC: LaptopCreation = {
        local: true,
        os: "macos",
        row: "macChrome",
        managers: ["apple", "gpm"],
        withdrawn: [],
      }
      const ATTEMPT = ["localhost", "id:paylink-frag"] as const
      const BOUND = { credentialId: "new-ticket-passkey", l2Address: L2_ADDRESS, tag: "taga" }
      const useLaptopCreation = vi.fn()
      /**
       * A gate as the real one behaves on this laptop: a sheet's pick resolves at once, a call with
       * no pick (or a way back to the sheet) holds until the sheet's Continue proceeds. `atTap` is
       * what its own probe answers; a local pick that row no longer allows holds the sheet on the
       * phone.
       */
      const laptopGate = (atTap: LaptopCreation = MAC, reach: PhoneReach = "unknown") => {
        const signal = new AbortController().signal
        let held: GateOptions | undefined
        let proceedHeld!: (choice?: SignUpChoice) => void
        type Opened = {
          signal: AbortSignal
          reach: PhoneReach
          creation: LaptopCreation
          choice?: SignUpChoice
          route?: SignInRoute
        }
        const opened = (choice?: SignUpChoice): Opened => ({
          signal,
          reach,
          creation: atTap,
          choice,
          route: choice && routeForChoice(choice),
        })
        const gate = vi.fn((options?: unknown): Promise<Opened> => {
          const o = options as GateOptions | undefined
          const pick = o?.unheld?.choice
          const allowed = !pick || routeForChoice(pick) !== "this-device" || atTap.local
          if (pick && !o?.openOn && allowed) return Promise.resolve(opened(pick))
          held = allowed ? o : { ...o, openOn: "phone" }
          return new Promise((resolve) => {
            proceedHeld = (choice) => {
              held = undefined
              resolve(opened(choice))
            }
          })
        })
        h.gateHook = () => ({
          gate,
          state: held
            ? {
                kind: "awaiting-action",
                prompt: "phone-steps",
                reach: "ok",
                creation: atTap,
                openOn: held.openOn,
                reopened: held.reopened,
                proceed: (choice?: SignUpChoice) => proceedHeld(choice),
              }
            : { kind: "idle" },
          cancel: () => {},
          dismiss: () => {},
        })
        return gate
      }
      /** The ticket sheet drawn for `drawn`, over a gate whose probe at the tap answers `atTap`. */
      const toSheet = async (
        drawn: LaptopCreation = MAC,
        atTap: LaptopCreation = drawn,
        reach?: PhoneReach,
      ) => {
        useLaptopCreation.mockClear()
        h.getAuthService.mockReturnValue({
          recoverFromCache: async () => undefined,
          probePhoneReach: async () => "ok",
          probeLaptopCreation: async () => drawn,
          useLaptopCreation,
        })
        pendingClaim(TICKET_CLAIM)
        const gate = laptopGate(atTap, reach)
        await render("/claim")
        await typeTag("taga")
        await clickClaimTag()
        await settleReads()
        return gate
      }
      const toLocalSheet = async (reach?: PhoneReach) => {
        const gate = await toSheet(MAC, MAC, reach)
        expect(byId("phone-steps")?.dataset.choice).toBe("computer")
        return gate
      }
      const apple = () => markPasskeyWritten(new ScreenLaptopRefusedError("apple", ["gpm"]))
      const route = (call: number) =>
        (h.createAccount.mock.calls[call]?.[5] as { route?: string } | undefined)?.route

      it.each([["This Mac, picked over it", "computer", "computer"]] as const)(
        "on Mac Chrome with an extension, the sheet hands %s to the auth service",
        async (_, picked, choice) => {
          ticketStash({ amount: 20n * ONE })
          extensionAnswers()
          const row: LaptopCreation = { ...MAC, managers: ["apple", "gpm", "1password"] }
          const gate = await toSheet(row)
          expect(byId("phone-steps")?.dataset.choice).toBe("1password")
          if (picked) await pickOption(picked)
          await clickId("phone-steps-continue")
          await settleReads()
          expect(pickOf(gate.mock.calls[0]?.[0])).toBe(choice)
          expect(useLaptopCreation).toHaveBeenCalledWith(row, choice)
          expect(route(0)).toBe("this-device")
        },
      )

      it("the ticket sheet reopened after a close waits for fresh answers and shows them", async () => {
        ticketStash({ amount: 20n * ONE })
        await toLocalSheet()
        expect(byId("phone-steps-choice")!.textContent).toContain("iCloud Keychain")
        let answer!: (creation: LaptopCreation) => void
        h.getAuthService.mockReturnValue({
          recoverFromCache: async () => undefined,
          probePhoneReach: async () => "no-hybrid",
          probeLaptopCreation: () => new Promise((resolve) => (answer = resolve)),
          useLaptopCreation,
        })
        await act(async () =>
          container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
        )
        await clickClaimTag()
        await settleReads()
        expect(byId("phone-steps-loading")).not.toBeNull()
        expect(byId("phone-steps-choice")).toBeNull()
        await act(async () => answer({ ...MAC, managers: ["gpm"] }))
        expect(byId("phone-steps")?.dataset.choice).toBe("computer")
        expect(byId("phone-steps-choice")!.textContent).not.toContain("iCloud Keychain")
        expect(await offered()).toEqual(["computer", "key"])
      })

      describe("on a row with 1Password alone", () => {
        const ONEPASSWORD_ONLY: LaptopCreation = {
          local: true,
          os: "windows",
          row: "windowsEdgeBrave",
          managers: ["1password"],
          withdrawn: [],
          chromeTip: "gpm",
        }
        const PHONE_ONLY: LaptopCreation = { local: false, chromeTip: "gpm" }

        it("a ticket bound after its sheet opened signs in without the creation's warning", async () => {
          ticketStash({ amount: 20n * ONE })
          extensionAnswers(otherCreate)
          await toSheet(ONEPASSWORD_ONLY)
          expect(byId("phone-steps")?.dataset.choice).toBe("phone")
          saveTicketSignupAccount("localhost", "id:paylink-frag", {
            credentialId: "other-tab-passkey",
            l2Address: L2_ADDRESS,
            tag: "taga",
          })
          h.reusePasskeyAccount.mockImplementationOnce(() => new Promise(() => {}))
          await clickId("phone-steps-continue")
          await settleReads()
          expect(h.reusePasskeyAccount).toHaveBeenCalledTimes(1)
          expect(h.createAccount).not.toHaveBeenCalled()
          expect(byId("phone-steps-extension-warning")).toBeNull()
          // A sign-in with the bound passkey is no passkey creation request.
          expect(h.fireEvent).not.toHaveBeenCalledWith(
            "onboarding_create_attempted",
            expect.anything(),
          )
        })

        it("a row no longer offered at the tap holds the sheet on the phone, and creates nothing on this computer", async () => {
          ticketStash({ amount: 20n * ONE })
          extensionAnswers()
          await toSheet(ONEPASSWORD_ONLY, PHONE_ONLY)
          expect(byId("phone-steps")?.dataset.choice).toBe("1password")
          await clickId("phone-steps-continue")
          await settleReads()
          expect(h.createAccount).not.toHaveBeenCalled()
          expect(byId("phone-steps")?.dataset.choice).toBe("phone")
          expect(await offered()).toEqual(["phone", "key"])
          await clickId("phone-steps-continue")
          await settleReads()
          expect(h.createAccount).toHaveBeenCalledTimes(1)
          expect(route(0)).toBe("phone")
          expect(useLaptopCreation).not.toHaveBeenCalledWith(ONEPASSWORD_ONLY, expect.anything())
        })
      })

      it.each([["Use my phone", "passkey-phone", "phone", "phone"]] as const)(
        "a refusal's %s restarts the interrupted attempt, holds the sheet, and the next pick binds the ticket",
        async (_, exit, openOn, picked) => {
          ticketStash({ amount: 20n * ONE })
          h.createAccount.mockRejectedValueOnce(apple())
          const gate = await toLocalSheet()
          await clickId("phone-steps-continue")
          await settleReads()
          const refused = loadTicketSignupAttempt(...ATTEMPT)
          expect(isTicketSignupCreating(refused)).toBe(true)
          expect(byId("create-refused")?.dataset.reason).toBe("LaptopPasskeyRefusedError")
          expect(byId("passkey-leftover")).not.toBeNull()
          await clickId(exit)
          await settleReads()
          // The attempt the prompt interrupted is gone before the sheet re-opens.
          expect(loadTicketSignupAttempt(...ATTEMPT)).toBeNull()
          expect(gate.mock.calls[1]?.[0]).toMatchObject({ purpose: "create", openOn })
          expect(pickOf(gate.mock.calls[1]?.[0])).toBeUndefined()
          expect(byId("create-refused")).toBeNull()
          expect(byId("phone-steps")?.dataset.choice).toBe(openOn)
          await clickId("phone-steps-continue")
          await settleReads()
          expect(h.createAccount).toHaveBeenCalledTimes(2)
          expect(route(1)).toBe(picked)
          expect(loadTicketSignupAccount(...ATTEMPT)).toEqual(BOUND)
        },
      )

      it("a refusal's Try again counts a second passkey request once its pick goes through", async () => {
        const attempts = () =>
          h.fireEvent.mock.calls.filter(([event]) => event === "onboarding_create_attempted")
        ticketStash({ amount: 20n * ONE })
        h.createAccount.mockRejectedValueOnce(apple())
        await toLocalSheet()
        await clickId("phone-steps-continue")
        await settleReads()
        expect(attempts()).toEqual([
          ["onboarding_create_attempted", { attempt: "1", entry: "ticket" }],
        ])
        // The sheet re-opens and holds: nothing is counted until a pick lets the request through.
        await clickId("create-retry")
        await settleReads()
        expect(attempts()).toHaveLength(1)
        await clickId("phone-steps-continue")
        await settleReads()
        expect(attempts()).toEqual([
          ["onboarding_create_attempted", { attempt: "1", entry: "ticket" }],
          ["onboarding_create_attempted", { attempt: "2+", entry: "ticket" }],
        ])
      })

      it.each([["Apple Passwords with no phone in reach", apple, "no-hybrid", false]] as const)(
        "a refusal of %s leaves the sheet's own button bright",
        async (_, refusal, reach, phoneOffered) => {
          ticketStash({ amount: 20n * ONE })
          h.createAccount.mockRejectedValueOnce(refusal())
          await toLocalSheet(reach)
          await clickId("phone-steps-continue")
          await settleReads()
          expect(byId("create-refused")).not.toBeNull()
          expect(byId("passkey-phone") !== null).toBe(phoneOffered)
          expect(button("Create another passkey")?.dataset.style).toBe("gradient")
        },
      )

      it("a refused phone attempt's Try again re-opens the sheet on the phone, with no phone exit", async () => {
        ticketStash({ amount: 20n * ONE })
        h.createAccount.mockRejectedValueOnce(
          markPasskeyWritten(new ScreenPhoneRequiredError({ ceremony: "create" })),
        )
        const gate = await toLocalSheet()
        await pickOption("phone")
        await clickId("phone-steps-continue")
        await settleReads()
        expect(route(0)).toBe("phone")
        expect(byId("create-refused")).not.toBeNull()
        expect(byId("passkey-phone")).toBeNull()
        await clickId("create-retry")
        await settleReads()
        expect(gate.mock.calls[1]?.[0]).toMatchObject({ openOn: "phone" })
        expect(byId("phone-steps")?.dataset.choice).toBe("phone")
      })

      it.each([["the phone", "phone", "phone"]] as const)(
        "a prompt closed with nothing made re-opens the sheet, and the next pick (%s) restarts the attempt before binding",
        async (_, picked, route1) => {
          ticketStash({ amount: 20n * ONE })
          h.createAccount.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"))
          const gate = await toLocalSheet()
          await clickId("phone-steps-continue")
          await settleReads()
          // No card, no error line: the sheet again, saying the setup didn't finish, while the
          // interrupted attempt stays saved until the next pick replaces it.
          expect(byId("create-refused")).toBeNull()
          expect(container.querySelector(".ww-invite-modal-error")).toBeNull()
          expect(gate.mock.calls[1]?.[0]).toMatchObject({
            openOn: "computer",
            reopened: "unfinished",
          })
          expect(byId("phone-steps-unfinished")).not.toBeNull()
          expect(isTicketSignupCreating(loadTicketSignupAttempt(...ATTEMPT))).toBe(true)
          if (picked) await pickOption(picked)
          await clickId("phone-steps-continue")
          await settleReads()
          expect(h.createAccount).toHaveBeenCalledTimes(2)
          expect(route(1)).toBe(route1)
          expect(loadTicketSignupAccount(...ATTEMPT)).toEqual(BOUND)
        },
      )

      it("a request refused before any prompt re-opens the sheet saying so, twice in a row saying to try another browser", async () => {
        const refusedAtOnce = () => {
          const refused = new DOMException("blocked", "NotAllowedError")
          recordRequestHeld(refused, 200)
          return refused
        }
        ticketStash({ amount: 20n * ONE })
        h.createAccount.mockRejectedValueOnce(refusedAtOnce())
        const gate = await toLocalSheet()
        await clickId("phone-steps-continue")
        await settleReads()
        expect(byId("create-refused")).toBeNull()
        expect(gate.mock.calls[1]?.[0]).toMatchObject({ openOn: "computer", reopened: "blocked" })
        expect(byId("phone-steps-blocked")?.textContent).toBe(PHONE_STEPS_COPY.local.blocked)
        expect(isTicketSignupCreating(loadTicketSignupAttempt(...ATTEMPT))).toBe(true)
        h.createAccount.mockRejectedValueOnce(refusedAtOnce())
        await clickId("phone-steps-continue")
        await settleReads()
        expect(gate.mock.calls[2]?.[0]).toMatchObject({
          openOn: "computer",
          reopened: "blocked-again",
        })
        expect(byId("phone-steps-blocked")?.textContent).toBe(PHONE_STEPS_COPY.local.blockedAgain)
        await clickId("phone-steps-continue")
        await settleReads()
        expect(h.createAccount).toHaveBeenCalledTimes(3)
        expect(loadTicketSignupAccount(...ATTEMPT)).toEqual(BOUND)
      })

      it("a refusal's Try again refuses to restart an attempt another tab replaced", async () => {
        ticketStash({ amount: 20n * ONE })
        h.createAccount.mockRejectedValueOnce(apple())
        await toLocalSheet()
        await clickId("phone-steps-continue")
        await settleReads()
        const refused = loadTicketSignupAttempt(...ATTEMPT)
        if (!isTicketSignupCreating(refused)) throw new Error("expected the refused attempt")
        restartTicketSignupAccount(...ATTEMPT, refused.attemptId)
        const other = await beginTicketSignupAccount(...ATTEMPT, "taga")
        await clickId("create-retry")
        await settleReads()
        expect(h.createAccount).toHaveBeenCalledTimes(1)
        expect(byId("create-refused")).toBeNull()
        expect(container.textContent).toContain("restarted in another tab")
        expect(loadTicketSignupAttempt(...ATTEMPT)).toEqual(other)
        expect(
          h.fireEvent.mock.calls.filter(([event]) => event === "onboarding_create_attempted"),
        ).toHaveLength(1)
      })
    })

    it.each([true])(
      "a new ticket signup ignores an unrelated account, nameless identity=%s",
      async (nameless) => {
        ticketStash({ amount: 20n * ONE })
        if (nameless) saveWalletIdentity({ address: L2_ADDRESS, claimedAt: 1 })
        const recoverFromCache = vi.fn(async () => ({
          credentialId: "previous-account-passkey",
          expectedAddress: L2_ADDRESS,
        }))
        h.getAuthService.mockReturnValue({ recoverFromCache })
        pendingClaim(TICKET_CLAIM)
        await walkToPasskey()
        expect(h.createAccount).toHaveBeenCalledTimes(1)
        expect(h.reusePasskeyAccount).not.toHaveBeenCalled()
        expect(recoverFromCache).not.toHaveBeenCalled()
        expect(h.claimTag).toHaveBeenCalledTimes(1)
      },
    )

    it("reports each passkey request and the account on the signup stream, by how the account came", async () => {
      const stream = () =>
        h.fireEvent.mock.calls.filter(([event]) =>
          ["onboarding_create_attempted", "onboarding_account_created"].includes(event),
        )
      ticketStash({ amount: 20n * ONE })
      h.claimTag.mockRejectedValueOnce(new Error("account service unavailable"))
      await walkToPasskey()
      expect(stream()).toEqual([
        ["onboarding_create_attempted", { attempt: "1", entry: "ticket" }],
        ["onboarding_account_created", { duration_ms: 0, mode: "create", route: "ticket" }],
      ])
      // The remount recovers the ticket's own passkey: no new request, an account entered.
      await act(async () => root.unmount())
      root = createRoot(container)
      sessionStorage.clear()
      h.fireEvent.mockClear()
      ticketStash({ amount: 20n * ONE })
      pendingClaim(TICKET_CLAIM)
      await walkToPasskey()
      expect(stream()).toEqual([
        ["onboarding_account_created", { duration_ms: 0, mode: "enter", route: "ticket" }],
      ])
    })

    it("reports a new passkey's account before the reload a session switch forces", async () => {
      const created = () =>
        h.fireEvent.mock.calls.filter(([event]) => event === "onboarding_account_created")
      ticketStash({ amount: 20n * ONE })
      h.reloadIfSessionSwitched.mockReturnValueOnce(true)
      await walkToPasskey()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(created()).toEqual([
        ["onboarding_account_created", { duration_ms: 0, mode: "create", route: "ticket" }],
      ])
      const sentAt =
        h.fireEvent.mock.invocationCallOrder[
          h.fireEvent.mock.calls.findIndex(([event]) => event === "onboarding_account_created")
        ]
      expect(sentAt).toBeLessThan(h.reloadIfSessionSwitched.mock.invocationCallOrder[0])
    })

    it("an unreadable saved binding fails without creating or claiming", async () => {
      ticketStash()
      walletStorage.setItem("obsidion.ticket-signup.account:localhost:id:paylink-frag", "broken")
      await walkToPasskey()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(container.textContent).toContain("account could not be read")
    })

    it("a refused bound passkey neither creates another account nor redeems the ticket", async () => {
      ticketStash()
      saveTicketSignupAccount("localhost", "id:paylink-frag", {
        credentialId: "ticket-passkey",
        l2Address: L2_ADDRESS,
      })
      h.reusePasskeyAccount.mockRejectedValueOnce(new PasskeyMismatchError())
      await walkToPasskey()
      expect(h.createAccount).not.toHaveBeenCalled()
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(container.textContent).toContain("isn't the passkey")
    })

    it("tickets paused before the redeem: the signup goes on at the signed price and keeps the link for Home", async () => {
      ticketStash({ amount: 20n * ONE })
      const PAID_CLAIM = nameClaim({
        terms: earnedTerms({
          fee: String(PAID.fee),
          minDeposit: String(PAID.min),
          reduced: false,
        }),
      })
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
        return {
          kind: "pending",
          claim: PAID_CLAIM,
          oxideAccount: ACCOUNT,
          ticketUnavailable: true,
        }
      })
      await walkToPasskey()
      await settleReads()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      // Home asks for the deposit at the signed price.
      expect(enteredWallet()).toBe(true)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(getPendingStore().current()?.phase).toBe("awaiting_deposit")
      const terms = loadRegistrationTerms(ACCOUNT, "taga")
      expect(terms).toMatchObject({ fee: String(PAID.fee), feeWaived: false })
      expect(terms?.paylinkFunded).toBeUndefined()
      expect(terms?.paylinkId).toBeUndefined()
    })

    it("a ticket redeemed before the pause still prices the claim: the ticket path goes on", async () => {
      ticketStash({ amount: 20n * ONE })
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag }))
        return {
          kind: "pending",
          claim: TICKET_CLAIM,
          oxideAccount: ACCOUNT,
          ticketUnavailable: true,
        }
      })
      await walkToPasskey()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
      expect(enteredWallet()).toBe(true)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain("paylink tickets are paused")
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
    })

    it("a pending registration continues only with the link its terms name", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ fragment: "other-link", amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(container.textContent).not.toContain("Claim your payment")

      ticketStash({ amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("Claim your payment")
    })

    it("a pending registration continues with the bound link reopened without its marker", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      sessionStorage.setItem(CLAIM_STASH_KEY, "paylink-frag")
      await render("/claim")
      await settleReads()
      expect(container.textContent).toContain("Claim your payment")
      expect(container.textContent).not.toContain("Send 10 DAI")
      expect(button("Enter now, deposit later")).toBeUndefined()
    })

    it("re-reads the activation at the click: a burn already out claims nothing", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      await render("/claim")
      await settleReads()
      expect(button("Claim your payment")?.disabled).toBe(false)
      // Another tab's claim seeded the burn's record between the render and the click.
      await session().withdrawals.create({
        networkId: "0xnet",
        localId: "wdraw_test",
        recipient: "0x00000000000000000000000000000000000000c3",
        recipientProvenance: "saved-recipient",
        amount: "0.61",
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        phase: "submitting",
        startTime: Date.now(),
      })
      await click("Claim your payment")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(container.textContent).toContain("already claimed")
    })

    it("offers no claim after a reload until the burns load, then reads the burn already out", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      await session().withdrawals.create({
        networkId: "0xnet",
        localId: "wdraw_test",
        recipient: "0x00000000000000000000000000000000000000c3",
        recipientProvenance: "saved-recipient",
        amount: "0.61",
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        phase: "submitting",
        startTime: Date.now(),
      })
      // A reload whose withdrawal store has yet to open.
      closeSession()
      await walletStorage.batch(() =>
        walletStorage.removeItem(`${activeNamespace().prefix}acct/meta/withdrawals`),
      )
      let land!: () => void
      const landed = new Promise<void>((resolve) => (land = resolve))
      testWalletDbs().onApply = async (_version, ops) => {
        if (ops.some(([key]) => key.endsWith("acct/meta/withdrawals"))) await landed
      }
      await openHostSession()
      await render("/claim")
      await settleReads()
      expect(button("Claim your payment")).toBeUndefined()
      await act(async () => land())
      await settleReads()
      await click("Claim your payment")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(container.textContent).toContain("already claimed")
    })

    it("never asks a link-funded registration for a deposit when its link is not on this tab", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: String(ONE),
        feeWaived: true,
        paylinkFunded: true,
        paylinkDeposit: true,
        paylinkId: "id:paylink-frag",
      })
      // The link's burn is out; the reload lost the tab's stash.
      await session().withdrawals.create({
        networkId: "0xnet",
        localId: "wdraw_reload",
        recipient: getPendingStore().current()!.sipaAddress as Hex,
        recipientProvenance: "saved-recipient",
        amount: "1.7",
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        phase: "submitting",
        startTime: Date.now(),
      })
      await render("/claim/taga")
      await settleReads()
      expect(container.textContent).not.toContain(getPendingStore().current()!.sipaAddress)
      expect(container.textContent).not.toContain("Waiting for deposit")
      expect(container.textContent).toContain(
        "Registering @taga. Waiting for the network to sweep the deposit.",
      )
    })

    it("claims from the pending step on the working beat, and enters once it is sent", async () => {
      screenProps = {}
      // No burn left in the store by an earlier case: this one's claim is ready.
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      const controller = new AbortController()
      h.gateHook = () => ({
        gate: async () => ({ signal: controller.signal, reach: "unknown" as const }),
        state: { kind: "idle" },
        cancel: () => controller.abort(),
        dismiss: () => {},
      })
      const settle = {} as { resolve: (hash: string) => void }
      h.claimSponsoredLink.mockImplementation(async () => {
        await getOperationStore().begin({
          operationId: "pending-claim-op",
          flow: "paylink-claim",
          summary: "$20",
          scope: null,
        })
        return new Promise<string>((resolve) => Object.assign(settle, { resolve }))
      })
      await render("/claim")
      await settleReads()
      await click("Claim your payment")
      await settleReads()
      expect(h.claimSponsoredLink).toHaveBeenCalledOnce()
      expect(container.textContent).toContain("Keep this tab open")
      expect(loadWalletIdentity()).toBeNull()

      // The proof runs in this page: the beat holds until it is sent.
      await act(async () => {
        provingProgress.emitStageStart("proving", "pending-claim-op")
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(container.textContent).toContain("Proving privately")
      expect(loadWalletIdentity()).toBeNull()

      await act(async () => {
        provingProgress.emitTxHashSaved("pending-claim-op", `0x${"cd".repeat(32)}`)
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga" })
      expect(container.textContent).not.toContain("Keep this tab open")
      expect(isClaimRunning("paylink-frag")).toBe(true)

      await act(async () => settle.resolve("0xclaim"))
      expect(isClaimRunning("paylink-frag")).toBe(false)
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBeNull()
      getOperationStore().release("pending-claim-op")
      await getOperationStore().remove("pending-claim-op")
    })

    it("a status check on the pending step is no claim: the Claim stays, held, with no working beat", async () => {
      screenProps = {}
      await seedRecord()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      let tick!: () => void
      h.runDetectionTick.mockImplementation(
        () => new Promise<string>((resolve) => (tick = () => resolve("pending"))),
      )
      await render("/claim")
      await settleReads()
      await click("Check again")
      expect(button("Claim your payment")?.disabled).toBe(true)
      expect(container.textContent).not.toContain("Keep this tab open")
      await act(async () => tick())
      await settleReads()
      expect(button("Claim your payment")?.disabled).toBe(false)
    })

    it("holds the review's claim until the tip quote answers, so it burns the tip it shows", async () => {
      screenProps = {}
      await seedRecord()
      const committed = (3n * 10n ** 18n).toString()
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) + 7200,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
        proverTip: committed,
        speed: "faster",
      })
      ticketStash({ amount: 20n * ONE })
      const split = (id: string) =>
        container.querySelector(`[data-testid="paylink-signup-${id}"]`)?.textContent ?? ""
      try {
        splitTip.value = undefined
        await render("/claim")
        await settleReads()
        expect(button("Claim your payment")?.disabled).toBe(true)
        expect(split("network-fee")).toBe(DEPOSIT_TERMS_PENDING)
        expect(loadRegistrationTerms(ACCOUNT, "taga")?.proverTip).toBe(committed)

        splitTip.value = 10n ** 18n
        await render("/claim")
        await settleReads()
        expect(button("Claim your payment")?.disabled).toBe(false)
        expect(split("network-fee")).not.toBe(DEPOSIT_TERMS_PENDING)
        expect(loadRegistrationTerms(ACCOUNT, "taga")?.proverTip).toBe((10n ** 18n).toString())
      } finally {
        splitTip.value = 10n ** 18n
      }
    })

    /**
     * Expired paylink-funded terms plus a forced tick whose re-sign answers `quote`. A reduced quote
     * runs a stubbed tick (the real machine would go on to broadcast); a paid one runs the real
     * resume machine, which reads such a claim as ordinary and backs off without reporting.
     */
    const renewal = async (quote: { fee: bigint; minDeposit: bigint; reduced: boolean }) => {
      screenProps = {}
      await seedRecord({
        fee: (ONE / 2n).toString(),
        beneficiary: "0x00000000000000000000000000000000000000b5",
      })
      saveRegistrationTerms({
        account: ACCOUNT,
        tag: "taga",
        deadline: Math.floor(Date.now() / 1000) - 60,
        fee: (ONE / 2n).toString(),
        minDeposit: "0",
        feeWaived: true,
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
      })
      ticketStash({ amount: 20n * ONE })
      await render()
      const deadline = Math.floor(Date.now() / 1000) + 7200
      const signDomain = vi.fn(async (_req: unknown) =>
        nameClaim({
          deadline: String(deadline),
          terms: earnedTerms({
            fee: quote.fee.toString(),
            minDeposit: quote.minDeposit.toString(),
            reduced: quote.reduced,
            ticket: quote.reduced,
          }),
        }),
      )
      if (quote.reduced) {
        h.buildRetrySignDeps.mockReturnValue({ accountService: { signDomain } })
        h.runDetectionTick.mockImplementation(
          async (deps: {
            getSignDeps: () => Promise<{ accountService: { signDomain: typeof signDomain } }>
          }) => {
            const sign = await deps.getSignDeps()
            await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
            await getPendingStore().upsert(ACCOUNT, { broadcast: true })
            return "pending"
          },
        )
      } else {
        const real = await vi.importActual<
          typeof import("../../../src/features/onboarding/webRegistration")
        >("../../../src/features/onboarding/webRegistration")
        h.runDetectionTick.mockImplementation(real.runDetectionTick)
        h.buildRetrySignDeps.mockReturnValue({
          masterSecret: `0x${"11".repeat(32)}`,
          accountService: { signDomain },
          deriveRegistrationSipa: async () => ({
            sipaAddress: "0x00000000000000000000000000000000000000c3",
            sipaArgs: {},
          }),
          broadcast: vi.fn(),
        })
        h.buildWebDetectionDeps.mockImplementation(async (_config: unknown, extras = {}) => ({
          ...extras,
          env: { l1ChainId: 11155111, registry: ACCOUNT, factory: ACCOUNT, feeToken: ACCOUNT },
          l1: {
            readUserAddress: async () => "0x0000000000000000000000000000000000000000",
            readNameOf: async () => `0x${"00".repeat(32)}`,
            predictAccountAddress: async () => ACCOUNT,
          },
          deposits: {
            readFunding: async () => [],
            readSweeps: async () => [],
            readBalance: async () => 0n,
            floor: async () => ONE / 2n,
          },
          pendingStore: getPendingStore(),
          publicClient: {},
        }))
      }
      await click("Refresh deposit amount")
      expect(signDomain).toHaveBeenCalledOnce()
      return deadline
    }

    it("a renewed quote the link can no longer pay for blocks the link on this signup, and says so", async () => {
      await renewal({ fee: 5n * ONE, minDeposit: 10n * ONE, reduced: false })
      // The machine swallowed the claim as ordinary; the sheet still says why nothing can be claimed.
      expect(container.textContent).toContain("did not waive the tag price")
      expect(h.showReportableError).not.toHaveBeenCalled()
      expect(button("Claim your payment")).toBeUndefined()
      expect(button("Enter now, deposit later")).toBeUndefined()
      expect(container.textContent).not.toContain("Send 10 DAI")
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
        paylinkBlocked: true,
      })
      const { ticketSignupContinuation, ticketSignupCommitted } = await import(
        "../../../src/features/paylink/ticketContinuation"
      )
      expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toMatchObject({
        activation: { state: "blocked" },
      })
      expect(ticketSignupCommitted("paylink-frag")).toBe(true)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()

      // A later re-sign that waives the tag again lifts the block.
      h.runDetectionTick.mockImplementation(
        async (deps: {
          getSignDeps: () => Promise<{
            accountService: { signDomain: (req: unknown) => Promise<unknown> }
          }>
        }) => {
          const sign = await deps.getSignDeps()
          await sign.accountService.signDomain({ nameHash: NAME_HASH, userAddress: ACCOUNT })
          return "pending"
        },
      )
      h.buildRetrySignDeps.mockReturnValue({
        accountService: {
          signDomain: async () => ({
            ...CLAIM,
            deadline: String(Math.floor(Date.now() / 1000) + 7200),
            terms: { fee: (ONE / 2n).toString(), minDeposit: "0", reduced: true, ticket: true },
          }),
        },
      })
      saveRegistrationTerms({
        ...loadRegistrationTerms(ACCOUNT, "taga")!,
        deadline: Math.floor(Date.now() / 1000) - 60,
      })
      await settleReads()
      await click("Refresh deposit amount")
      expect(loadRegistrationTerms(ACCOUNT, "taga")?.paylinkBlocked).toBeUndefined()
      expect(button("Claim your payment")).toBeTruthy()
      expect(container.textContent).not.toContain("did not waive the tag price")
    })

    it("logging out of a blocked signup keeps the link bound and blocked until it is renewed or abandoned", async () => {
      await renewal({ fee: 5n * ONE, minDeposit: 10n * ONE, reduced: false })
      const { ticketSignupContinuation, ticketSignupCommitted } = await import(
        "../../../src/features/paylink/ticketContinuation"
      )
      await click("Log out")
      expect(getPendingStore().current()?.phase).toBe("awaiting_deposit")
      expect(loadRegistrationTerms(ACCOUNT, "taga")).toMatchObject({
        paylinkFunded: true,
        paylinkId: "id:paylink-frag",
        paylinkBlocked: true,
      })
      expect(ticketSignupCommitted("paylink-frag")).toBe(true)
      expect(ticketSignupContinuation("paylink-frag", L2_ADDRESS, [])).toMatchObject({
        activation: { state: "blocked" },
      })

      // The same pending registration, resumed: still the refusal, never a paid deposit.
      await act(async () => root.unmount())
      root = createRoot(container)
      await render("/claim/taga")
      await settleReads()
      expect(container.textContent).toContain("did not waive the tag price")
      expect(container.textContent).not.toContain("Send 10 DAI")
      expect(button("Claim your payment")).toBeUndefined()
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("a marker left in the tab never turns another wizard into the ticket signup", async () => {
      screenProps = {}
      ticketStash()
      pendingClaim(TICKET_CLAIM)
      await render("/claim")
      await settleReads()
      // The ordinary landing, not the three-step modal; the marker is left where it was.
      expect(container.textContent).not.toContain("Pick any name, free")
      expect(container.querySelector("dialog")).toBeNull()
      expect(container.textContent).toContain("Create Account")
      expect(h.claimTag).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
    })

    it("opens on the choose-tag step over the link, ignoring a leftover reservation", async () => {
      ticketStash()
      await seedRecord({ tag: "hmm2" })
      await render("/claim")
      await settleReads()
      expect(container.querySelector("dialog")).not.toBeNull()
      expect(container.textContent).toContain("Pick any name, free")
      expect(container.textContent).not.toContain("@hmm2.zk.money")
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
    })

    it("refuses a paid NameClaim and drops the reservation, keeping the link", async () => {
      ticketStash()
      pendingClaim(CLAIM)
      await walkToPasskey()
      expect(container.textContent).toMatch(/did not waive the tag price/)
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(getPendingStore().current()).toBeNull()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
    })

    it("enters before the SIPA broadcast lands: Home waits for the address, not the wizard", async () => {
      ticketStash()
      let release!: (ok: boolean) => void
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
        return {
          kind: "pending",
          claim: TICKET_CLAIM,
          oxideAccount: ACCOUNT,
          broadcastDone: new Promise<boolean>((r) => {
            release = r
          }),
        }
      })
      await walkToPasskey()
      expect(enteredWallet()).toBe(true)
      expect(container.textContent).not.toContain("Publishing your deposit address")
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()

      await act(async () => release(true))
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
    })

    it("a failed SIPA broadcast leaves the wallet entered and the link stashed, with no claim", async () => {
      ticketStash()
      let release!: (ok: boolean) => void
      h.claimTag.mockImplementation(async (tag: string) => {
        await getPendingStore().upsert(ACCOUNT, {}, baseRecord({ tag, broadcast: false }))
        return {
          kind: "pending",
          claim: TICKET_CLAIM,
          oxideAccount: ACCOUNT,
          broadcastDone: new Promise<boolean>((r) => {
            release = r
          }),
        }
      })
      await walkToPasskey()
      await act(async () => release(false))
      await settleReads()
      expect(h.claimSponsoredLink).not.toHaveBeenCalled()
      expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
      expect(container.textContent).not.toContain("Deposit 0")
      expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
    })

    describe("inside the visitor page (the link opened with no account)", () => {
      const LINK = {
        url: "http://test/link#paylink-frag",
        fragment: "paylink-frag",
        amount: "20",
        status: "unclaimed",
        flavor: "direct",
      } as never
      const BURN_HASH = `0x${"11".repeat(32)}` as Hex
      const store = () => session().withdrawals
      const renderVisitor = (link = LINK) =>
        act(async () => {
          root.render(
            <MemoryRouter initialEntries={["/link"]}>
              <PaylinkVisitorScreen link={link} onRetryStatus={vi.fn()} />
            </MemoryRouter>,
          )
        })
      const clickContaining = (label: string) =>
        act(async () => {
          const target = buttons().find((b) => b.textContent?.includes(label))
          if (!target) throw new Error(`no button containing "${label}"`)
          target.click()
        })
      /** Account → tag → welcome → passkey: the wizard enters, and Home owns the link's claim. */
      it("enters the wallet as soon as the name is reserved, and never claims the link itself", async () => {
        pendingClaim(TICKET_CLAIM)
        await renderVisitor()
        await clickContaining("Receive to zk.money")
        expect(container.textContent).toContain("Pick any name, free")
        await typeTag("taga")
        await clickClaimTag()
        await click(button("Continue") ? "Continue" : "Create account with passkey")
        await settleReads()
        expect(enteredWallet()).toBe(true)
        expect(container.textContent).not.toContain("Keep this tab open")
        expect(h.claimSponsoredLink).not.toHaveBeenCalled()
        expect(loadWalletIdentity()).toMatchObject({ handle: "taga", pending: true })
        // No burn of the wizard's own: the batch is Home's to send.
        expect(store().list.get().records).toHaveLength(0)
        expect(isClaimRunning("paylink-frag")).toBe(false)
        expect(sessionStorage.getItem(CLAIM_STASH_KEY)).toBe("paylink-frag")
        expect(sessionStorage.getItem(TICKET_STASH_KEY)).not.toBeNull()
      })

      it("a link one wei below the threshold keeps the account option shut", async () => {
        await renderVisitor({ ...(LINK as object), amount: "1.999999999999999999" } as never)
        const account = buttons().find((b) => b.textContent?.includes("Receive to zk.money"))!
        expect(account.disabled).toBe(true)
        expect(account.textContent).toContain(
          "This payment is below the $2 minimum for a new account.",
        )
        await clickContaining("Receive to zk.money")
        expect(container.textContent).not.toContain("Pick any name, free")
        expect(sessionStorage.getItem(TICKET_STASH_KEY)).toBeNull()
        expect(h.createAccount).not.toHaveBeenCalled()
      })

      it("an ordinary cash-out of the link still shows its withdrawal page", async () => {
        await store().create({
          networkId: "0xnet",
          localId: "wdraw_cashout",
          recipient: `0x${"dd".repeat(20)}`,
          recipientProvenance: "saved-recipient",
          source: "paylink",
          paylinkId: "id:paylink-frag",
          amount: "19.65",
          tokenSymbol: "DAI",
          tokenDecimals: 18,
          phase: "l2_mined",
          l2TxHash: BURN_HASH,
          startTime: Date.now(),
        })
        await renderVisitor()
        expect(container.textContent).toContain("You withdrew")
        expect(container.textContent).not.toContain("Receive to zk.money")
      })
    })
  })
})

describe("no loss line on an ordinary sign-up", () => {
  const PHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1"
  const notices = () => container.querySelectorAll('[data-testid="passkey-loss-notice"]').length

  it("a phone's terms sheet carries no warning before Deposit, which then starts the creation", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(PHONE_UA)
    try {
      await render("/claim/taga")
      await click("landing-signin")
      expect(notices()).toBe(0)
      expect(container.textContent).not.toMatch(/lose your passkey|account recovery/i)
      expect(h.createAccount).not.toHaveBeenCalled()
      await clickDeposit()
      expect(h.createAccount).toHaveBeenCalledTimes(1)
    } finally {
      ua.mockRestore()
    }
  })
})

// Last in the file: the fresh page load replaces the modules every test above shares.
describe("onboarding_started", () => {
  it("is reported once per page load, however often the wizard mounts", async () => {
    vi.resetModules()
    await openHostSession(await pageModules())
    const { OnboardingScreen: Screen } = await import(
      "../../../src/features/onboarding/OnboardingScreen"
    )
    await (await import("../../../src/features/onboarding/webRegistration"))
      .getPendingStore()
      .load()
    await render("/claim/taga", Screen)
    // Home's draft mounts the wizard again after /claim.
    await act(async () => root.unmount())
    root = createRoot(container)
    await render("/claim/taga", Screen)
    expect(h.fireEvent.mock.calls.filter(([name]) => name === "onboarding_started")).toEqual([
      ["onboarding_started", { entry: "link" }],
    ])
  })

  it("a ticket signup reports none, and an ordinary signup after it still reports its own", async () => {
    vi.resetModules()
    await openHostSession(await pageModules())
    const { OnboardingScreen: Screen } = await import(
      "../../../src/features/onboarding/OnboardingScreen"
    )
    await (await import("../../../src/features/onboarding/webRegistration"))
      .getPendingStore()
      .load()
    const starts = () => h.fireEvent.mock.calls.filter(([name]) => name === "onboarding_started")
    const ONE = 10n ** 18n
    screenProps = { ticketSignup: true }
    stashTicketSignup({
      fragment: "paylink-frag",
      threshold: (2n * ONE).toString(),
      schedule: { fee: (ONE / 2n).toString(), minDeposit: "0" },
      amount: (20n * ONE).toString(),
    })
    await render("/claim", Screen)
    expect(starts()).toEqual([])
    await act(async () => root.unmount())
    root = createRoot(container)
    screenProps = {}
    await render("/claim/taga", Screen)
    expect(starts()).toEqual([["onboarding_started", { entry: "link" }]])
  })
})
