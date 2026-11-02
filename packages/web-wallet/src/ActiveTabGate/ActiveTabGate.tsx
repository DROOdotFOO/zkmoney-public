/**
 * Only the active tab mounts the wallet: the one holding the active-tab lock and its databases
 * (`activeTabLifecycle.ts`). Any other tab says so and can take over.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { NoRetryError, makeBackoff, retry } from "@aztec-labs/foundation/retry"
import type { AztecSQLiteOPFSStore } from "@aztec-labs/kv-store/sqlite-opfs"
import type { ChainIdentity } from "@obsidion/core/types"
import { LocalConfigStore, WalletError } from "@obsidion/front-core"
import { createNode } from "@obsidion/sdk"
import { PrimaryGradientButton, Spinner } from "@obsidion/web-ds"
import { App, type ActiveTabBoot } from "../App"
import { getConfig, type WebBootConfig } from "../config/env"
import { isDemoMode } from "../dev/demoFlag"
import { ErrorModalHost } from "../errors/ErrorModalHost"
import { stashInboundNameGrant } from "../features/onboarding/oxideOnboarding"
import { bindAnalyticsConsent } from "../lib/analytics"
import { discardIncompatiblePasskeyState } from "../platform/auth/discardIncompatiblePasskeyState"
import { findRetiredSession } from "../platform/auth/retiredSession"
import { warmBarretenberg } from "../platform/bbWasm"
import { bindWalletAuth } from "../platform/auth/useAuthenticator"
import { activeNamespace, switchSession } from "../platform/session"
import { activateTab, revokeTab, sendOnlyWhileActive } from "../platform/storage/activeTab"
import { ActiveTabLifecycle, type ActiveTabDeps } from "../platform/storage/activeTabLifecycle"
import { createPxeStore, opfsAvailable } from "../platform/storage/createPxeStore"
import { originWasFresh } from "../platform/storage/freshOrigin"
import { carryRetiredConfig } from "../platform/storage/retiredConfig"
import { activeRollup, removeOldWalletKeys } from "../platform/storage/rollupStorage"
import {
  closeWalletStore,
  isWalletOpenElsewhere,
  openWalletStore,
  reloadPage,
} from "../platform/storage/walletStorage"
import { webStorage } from "../platform/storage/WebStorageAdapter"
import { startPageWallet } from "../platform/wallet"
import { BootErrorScreen } from "../ui/BootErrorScreen"
import {
  BootSplash,
  assertCustomL1RpcSimulates,
  bootWaitsForDemand,
  describeBootError,
  identityReads,
  isPayPath,
  reportBootFailure,
  verifiedIdentity,
  type PxeBootTarget,
} from "../ui/PxeBoot"
import copy from "./ActiveTabGate.copy"

interface OpenedWallet {
  node: AztecNode
  pxeBoot: Extract<PxeBootTarget, { kind: "pxe" }>
  close(): Promise<void>
}

/** Another tab holds a database. */
const isBusy = (e: unknown): boolean =>
  e instanceof Error && (isWalletOpenElsewhere(e) || isBusy(e.cause))

/** Seconds between attempts at a PXE store open that failed for a reason other than a held store. */
const PXE_OPEN_BACKOFF_S = [1, 1, 2]

/** `performance.now()` when this page first tried to open its databases. */
let bootStartedAt: number | undefined
let pxeOpenAttempts = 0

/**
 * The app binds the live consent once it mounts. Until then a boot failure reports under the
 * stored consent, which the wallet database holds.
 */
async function bindStoredConsent(): Promise<void> {
  const settings = new LocalConfigStore(webStorage)
  await settings.init()
  const consent = settings.get("analyticsConsent")
  settings.dispose()
  bindAnalyticsConsent(() => consent)
}

/** Under the rollup L1 names, and a custom node's under its own digest, so no two nodes share one. */
async function openPxeStore(
  identity: ChainIdentity,
  nodeDigest: string | undefined,
): Promise<AztecSQLiteOPFSStore> {
  pxeOpenAttempts = 0
  return retry(
    () => {
      pxeOpenAttempts++
      return createPxeStore(identity.rollupAddress, nodeDigest).catch((e: unknown) => {
        throw isBusy(e) ? new NoRetryError(String(e), { cause: e }) : e
      })
    },
    "pxe store open",
    makeBackoff(PXE_OPEN_BACKOFF_S),
  )
}

function walletDeps(): ActiveTabDeps<OpenedWallet> {
  const config = getConfig()
  const node = sendOnlyWhileActive(createNode(config.nodeUrl, config.nodeApiKey))
  let reads: ReturnType<typeof identityReads> | undefined
  let identity: Promise<ChainIdentity> | undefined
  let l1RpcSimulates: Promise<void> | undefined
  return {
    locks: (navigator as Navigator & { locks?: LockManager }).locks,
    // The wallet database first: the PXE store is only worth opening for a wallet this tab holds.
    open: async () => {
      const startedAt = (bootStartedAt ??= performance.now())
      // None of these needs a store, so they load while the stores open: the chain reads the
      // identity check judges, and the genesis block and hashing WASM the PXE starts with.
      reads ??= identityReads(config, node)
      const warmPxe = () => {
        void node.getBlock(BlockNumber.ZERO)
        void warmBarretenberg()
      }
      // Whether the PXE boot waits needs the wallet database; only a pay page can wait.
      const payPage = isPayPath(location.pathname)
      if (!payPage) warmPxe()
      // The fresh-origin check must not see this page's own database.
      await originWasFresh()
      await openWalletStore(activeRollup(), { persistent: await opfsAvailable() })
      if (payPage && !bootWaitsForDemand()) warmPxe()
      try {
        await carryRetiredConfig()
        await bindStoredConsent()
        // Checked once per page, after consent is bound so the check's events are sent. The wallet
        // database is named after the profile's rollup, which the check holds to L1's.
        identity ??= verifiedIdentity(config, node, reads)
        l1RpcSimulates ??= assertCustomL1RpcSimulates(config)
        const [verified] = await Promise.all([identity, l1RpcSimulates])
        const store = await openPxeStore(verified, config.nodeEndpointDigest)
        return {
          node,
          pxeBoot: {
            kind: "pxe",
            store,
            identity: verified,
            bootStartedAt: startedAt,
            attempts: pxeOpenAttempts,
          },
          close: async () => {
            try {
              await store.close()
            } finally {
              await closeWalletStore()
            }
          },
        }
      } catch (e) {
        await closeWalletStore()
        throw e
      }
    },
    isBusy,
    // After both opens, so an older-build tab still holding the PXE store keeps its state meanwhile.
    // Nothing reads those keys, so a failed removal is left to the next activation or logout.
    prepare: async (opened) => {
      try {
        removeOldWalletKeys()
      } catch (e) {
        console.warn("[ActiveTabGate] could not remove old wallet keys:", e)
      }
      await discardIncompatiblePasskeyState(config.rpId)
      await findRetiredSession(config.rpId)
      bindWalletAuth(startPageWallet(opened.node, opened.pxeBoot))
      switchSession(activeNamespace())
    },
    activate: activateTab,
    revoke: revokeTab,
    reload: () => void reloadPage(),
  }
}

let lifecycle: ActiveTabLifecycle<OpenedWallet> | undefined

/** One per page, so StrictMode's replayed effects share it. */
function walletLifecycle(): ActiveTabLifecycle<OpenedWallet> {
  lifecycle ??= new ActiveTabLifecycle(walletDeps())
  return lifecycle
}

export function ActiveTabGate({ boot }: { boot: WebBootConfig }) {
  // Retain an inbound name grant and take the bearer token out of the URL, even in a tab that
  // waits on the other-tab screen.
  useState(stashInboundNameGrant)
  return isDemoMode() ? <DemoWallet boot={boot} /> : <ActiveTabWallet boot={boot} />
}

/**
 * Demo mode boots no PXE and takes no lock: its wallet database is in memory and belongs to this
 * page alone. The tab counts as active from page load.
 */
function DemoWallet({ boot }: { boot: WebBootConfig }) {
  const [activeTab] = useState<ActiveTabBoot>(() => {
    const config = getConfig()
    return {
      node: createNode(config.nodeUrl, config.nodeApiKey),
      pxeBoot: { kind: "demo" },
      activeSince: performance.timeOrigin,
    }
  })
  return <App boot={boot} activeTab={activeTab} />
}

function ActiveTabWallet({ boot }: { boot: WebBootConfig }) {
  const tab = walletLifecycle()
  const state = useSyncExternalStore(tab.subscribe, tab.getState)
  useEffect(() => tab.start(), [tab])

  switch (state.kind) {
    case "starting":
      return <BootSplash />
    case "inactive":
      return (
        <TabNotice title={copy.otherTab}>
          <p style={{ margin: 0 }}>{copy.otherTabBody}</p>
          <PrimaryGradientButton
            title={copy.useThisTab}
            isLoading={state.claiming}
            onClick={tab.takeOver}
          />
        </TabNotice>
      )
    case "opening":
      if (!state.takeover && !state.stalled) return <BootSplash />
      return (
        <TabNotice title={state.takeover ? copy.switching : copy.loading}>
          <Spinner size={28} />
          {state.stalled && <p style={{ margin: 0 }}>{copy.stalled}</p>}
        </TabNotice>
      )
    case "ready":
      return (
        <App
          boot={boot}
          activeTab={{
            node: state.opened.node,
            pxeBoot: state.opened.pxeBoot,
            activeSince: state.activeSince,
          }}
        />
      )
    case "displaced":
      // Only while this page closes its databases, before it reloads.
      return (
        <TabNotice title={copy.otherTab}>
          <Spinner size={28} />
        </TabNotice>
      )
    case "failed":
      return <BootFailure error={state.error} />
    default: {
      const unhandled: never = state
      throw new WalletError(
        "invariant",
        `ActiveTabWallet: unhandled state ${(unhandled as { kind: string }).kind}`,
      )
    }
  }
}

function TabNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        boxSizing: "border-box",
        background: "var(--surface-dark)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          maxWidth: 400,
          textAlign: "center",
          color: "var(--text-secondary)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, color: "var(--text-primary)" }}>{title}</h1>
        {children}
      </div>
    </div>
  )
}

function BootFailure({ error }: { error: unknown }) {
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current) return
    shown.current = true
    reportBootFailure(error, { bootStartedAt, attempts: pxeOpenAttempts })
  }, [error])
  return (
    <>
      {/* A failed boot ends this page's run as the active tab for good, so a retry is a new page. */}
      <BootErrorScreen
        error={describeBootError(error)}
        onRetry={() => void reloadPage()}
        walletOpen={false}
      />
      <ErrorModalHost />
    </>
  )
}
