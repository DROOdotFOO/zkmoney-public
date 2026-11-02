/**
 * XmtpMount — side-effect-only component mounted inside WalletGate (unlocked wallet only). Runs the
 * resilient KTD-3 lifecycle: capability gate, visibility-scoped `xmtp-client` Web Lock, and — as
 * leader — the stage-3 inbox: payment-request receive and connect-back receive via the hoisted
 * driver, plus the pending connect-back outbox flush. (Transfer receive is chain-native —
 * the `transferScan` task — and independent of XMTP.) A catch-up drain runs on
 * every leader acquisition (unlock / tab promotion); the inbox reads "ready" when it completes or
 * after a bounded wait (KTD-10). Non-leader / unsupported tabs render nothing and only publish the
 * shared UI state.
 */

import { useEffect } from "react"
import {
  bestEffort,
  ConnectBackReceiver,
  ContactStorage,
  IssuedConnectStorage,
  PendingConnectBackStorage,
  RequestReceiver,
  XmtpInboxReceiverDriver,
  createClaimedTagVerifier,
  flushPendingConnectBacks,
  importHistory,
  navigateIdFor,
  startArchivePublisher,
  startHistoryImporter,
  useAfter,
  type After,
  useLocalConfigStore,
  useResource,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { resolveTagForCommit } from "../../features/contacts/registryResolution"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import { getAuthService } from "../auth/useAuthenticator"
import { session, useSession } from "../session"
import { webStorage, type WebStorageAdapter } from "../storage/WebStorageAdapter"
import {
  createRequestBindingResolver,
  createRequestSenderPolicy,
  createRequestStoreWrites,
} from "./adapters"
import { WebXmtpClient } from "./WebXmtpClient"
import {
  XmtpLifecycle,
  messagingCapability,
  setXmtpInboxState,
  setXmtpSender,
  setXmtpUiState,
  withTimeout,
  type XmtpClientHandle,
} from "./xmtpLifecycle"

/** Bound on the KTD-10 catch-up gate: after this the inbox reads "ready" with local content. */
const XMTP_CATCH_UP_TIMEOUT_MS = 120_000

/** Construct the client and mount the full receive pipeline; runs only as the lock leader. */
async function createLeaderClient(
  dbEncryptionKey: Uint8Array,
  signal: AbortSignal,
  allowNonContactRequests: () => boolean,
  networkId: string,
): Promise<XmtpClientHandle> {
  const config = getConfig()
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("wallet locked — cannot derive the XMTP identity")
  const storage = webStorage
  const client = await WebXmtpClient.create({
    msk,
    dbEncryptionKey,
    env: config.xmtpEnv,
    storage,
    signal,
  })
  if (signal.aborted) {
    client.close()
    throw new Error("xmtp client construction abandoned")
  }
  // Sends are usable the moment the client exists — don't hold them behind the catch-up drain
  // below, which can run for a long time on a fresh installation.
  setXmtpSender(client)

  try {
    return await mountReceivePipeline(client, storage, signal, allowNonContactRequests, networkId)
  } catch (err) {
    setXmtpSender(null)
    client.close()
    throw err
  }
}

/** The stage-3 receive pipeline over an already-constructed leader client. */
async function mountReceivePipeline(
  client: WebXmtpClient,
  storage: WebStorageAdapter,
  signal: AbortSignal,
  allowNonContactRequests: () => boolean,
  networkId: string,
): Promise<XmtpClientHandle> {
  // KTD-10: a fresh installation pulls history from the account's other installations. Must
  // finish before the driver starts so its cursors still sit at zero. No history server on `local`.
  const deviceSyncAvailable = getConfig().xmtpEnv !== "local"
  if (deviceSyncAvailable && client.isFirstInstallation) {
    await importHistory(client, console)
    if (signal.aborted) throw new Error("xmtp client construction abandoned")
  }

  const receiverLogger = {
    warn: (message: string, context?: Record<string, unknown>) => {
      if (context) console.warn(message, context)
      else console.warn(message)
    },
  }
  // The `{ log }` port shape some front-core helpers take, over the same console.warn sink.
  const warnLog = { log: (message: string, ...args: unknown[]) => console.warn(message, ...args) }

  const contactStorage = ContactStorage.get()
  const connectBackReceiver = new ConnectBackReceiver(
    IssuedConnectStorage.get(storage),
    {
      addOrMergeContact: async (entry) => {
        const contact = await contactStorage.addOrMergeContact(entry)
        // The add is silent otherwise — nothing else tells the sharer their link was redeemed.
        // Keyed on the XMTP address: a tag-less connect-back is stored handle-only.
        const address = contact.address.toLowerCase()
        void bestEffort(
          "unknown",
          session().notifications.record({
            id: `contact:added:${address}`,
            at: Date.now(),
            kind: "contactAdded",
            data: {
              address,
              contactId: navigateIdFor(contact),
              ...(contact.tag && { tag: contact.tag }),
            },
          }),
        )
        return contact
      },
    },
    createClaimedTagVerifier(resolveTagForCommit),
    receiverLogger,
  )

  // Sender- and binding-gated — see RequestReceiver.
  const requestReceiver = new RequestReceiver(
    createRequestStoreWrites(session().requests),
    receiverLogger,
    createRequestBindingResolver(),
    createRequestSenderPolicy(contactStorage, allowNonContactRequests),
  )

  const driver = XmtpInboxReceiverDriver.getOrCreate({
    xmtp: client,
    connectBackReceiver,
    requestReceiver,
    ownXmtpAddress: client.xmtpAddress,
    currentAccount: async () => {
      const identity = loadWalletIdentity()
      // Nameless accounts have no messaging identity yet: XMTP rows key on the tag.
      if (!identity?.handle) return null
      // The driver stamps received rows with the rollup id.
      return { tag: identity.handle, l2Address: identity.address, rollupId: networkId }
    },
    asyncStorage: storage,
  })

  // KTD-10 catch-up: start the loop + stream, then flip the inbox to "ready" once one full drain
  // completes — or after XMTP_CATCH_UP_TIMEOUT_MS, whichever comes first, so a wedged drain can't
  // pin "catching-up" forever (the drain keeps running in the background; local content shows
  // meanwhile). Not awaited here: client construction is bounded by the lifecycle's own timeout.
  let disposed = false
  let stopPublisher: (() => void) | null = null
  setXmtpInboxState("catching-up")
  await driver.start()
  if (signal.aborted) {
    setXmtpInboxState("idle")
    XmtpInboxReceiverDriver.resetInstance()
    // The driver's first poll is already queued; a closed client is what stops it.
    client.close()
    throw new Error("xmtp client construction abandoned")
  }
  const stopImporter = deviceSyncAvailable
    ? startHistoryImporter(client, console, () => driver.requestHistoryReplay())
    : null
  void driver.startStream()
  const drain = driver
    .pollNow()
    .catch((err) => console.warn("[XmtpMount] catch-up drain failed", err))
  void withTimeout(drain, XMTP_CATCH_UP_TIMEOUT_MS, "xmtp catch-up drain")
    .catch(() => {}) // a wedged drain flips "ready" anyway; it keeps running in the background
    .then(() => {
      if (disposed) return
      setXmtpInboxState("ready")
      // Publish history for other installations that can access the sync group.
      if (deviceSyncAvailable) stopPublisher = startArchivePublisher(client, console)
    })

  // Drain the U8-queued connect-backs now that a client exists. Idempotent on the sharer's side.
  void flushPendingConnectBacks(
    PendingConnectBackStorage.get(storage),
    { sendConnectBack: (peer, content) => client.sendConnectBack(peer, content) },
    warnLog,
  ).catch((err) => console.warn("[XmtpMount] connect-back flush failed", err))

  return {
    close: () => {
      disposed = true
      stopPublisher?.()
      stopImporter?.()
      setXmtpSender(null)
      setXmtpInboxState("idle")
      XmtpInboxReceiverDriver.resetInstance()
      client.close()
    },
  }
}

/** The client is a large WASM, a database and a network sync. */
const AFTER: After = { firstBalance: true }
export function XmtpMount(): null {
  const config = useLocalConfigStore()
  const session = useSession()
  const ready = useAfter(session.milestones, AFTER)
  const networkId = useResource(session.wallet)?.networkId
  useEffect(() => {
    if (messagingCapability() !== "ok") {
      setXmtpUiState("unsupported")
      return () => setXmtpUiState("off")
    }
    if (!ready || !networkId) return
    const lifecycle = new XmtpLifecycle({
      locks: navigator.locks,
      isVisible: () => document.visibilityState === "visible",
      onVisibilityChange: (listener) => {
        document.addEventListener("visibilitychange", listener)
        return () => document.removeEventListener("visibilitychange", listener)
      },
      deriveDbKey: () => getAuthService().getDerivedKey("xmtp-store"),
      createClient: (key, signal) =>
        createLeaderClient(key, signal, () => config.get("allowNonContactRequests"), networkId),
      onState: setXmtpUiState,
      log: (message, ...args) => console.warn(message, ...args),
    })
    lifecycle.start()
    return () => lifecycle.stop()
  }, [config, ready, networkId])
  return null
}
