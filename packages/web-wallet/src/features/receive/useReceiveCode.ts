import {
  SIPADepositStore,
  loadRecords,
  receivesForRequest,
  isUnfundedSipaDeposit,
  payerAddedToContacts,
  randomCodeRequestId,
  payerForPaidLink,
  useContactsDirectory,
  useContractServiceContext,
  type Activity,
  type ContactRow,
  type Requests,
  useResource,
} from "@obsidion/front-core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isDemoMode } from "../../dev/demoFlag"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { useSession } from "../../platform/session"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { useDepositWatch } from "../onboarding/useDepositWatch"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { createAndStoreRequestLink, requestLinkOrigin } from "../requests/requestLinkCreation"
import {
  CODE_ADDRESS_MAX_AGE_MS,
  clearCode,
  codeIsStale,
  currentCode,
  nextCode,
  openCode,
  receiveCodeKey,
  setCodeAmount,
  type CodeDeps,
  type CodeForm,
  type ReceiveCode,
} from "./receiveCode"

/** How often a failed or address-less code is retried. */
const POLL_MS = 10_000

export interface CodePayment {
  amount: number
  via: "private" | "ethereum"
  /** Who paid; an Ethereum payment names nobody. */
  payer?: string
  /** The payer is a full contact. */
  added?: boolean
  /** The paid code held an address, so the next one holds a new one. */
  hadAddress: boolean
}

/** A payment as saved: `added` is read from the payer's contact as it changes. */
type PaidCode = Omit<CodePayment, "added"> & { payerId?: string }

/** What a claimed deposit to the code's address credited; the request's own amount without one. */
async function sweptAmount(code: ReceiveCode, requested: number): Promise<number> {
  if (!code.address) return requested
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  const credited = Number(store.get(code.address)?.amount)
  return credited > 0 ? credited : requested
}

/**
 * Calls `onPaid` once, when the code's request reads paid: by a receive carrying its id, else by a
 * deposit to its address. A failed read leaves it to the next update. Returns the stop.
 */
export function watchRequestPayment(
  code: ReceiveCode,
  deps: {
    requests: Pick<Requests, "view">
    activity: Pick<Activity, "query">
    contacts: () => readonly ContactRow[]
    onPaid: (found: Omit<PaidCode, "hadAddress">) => void
  },
): () => void {
  const { requests, activity } = deps
  let done = false
  // One read at a time; a failed one lets the next update try again.
  let reading = false
  const check = async () => {
    const row = requests.view.get().find((r) => r.id === code.requestId)
    if (done || reading || row?.status !== "fulfilled") return
    reading = true
    try {
      const hash = row.fulfillmentTxHash?.toLowerCase()
      const paying = await loadRecords(activity.query("request", code.requestId.toLowerCase()))
      const receives = receivesForRequest(paying, code.requestId)
      const tx = receives.find((r) => r.txHash?.toLowerCase() === hash)
      if (!tx) {
        const amount = await sweptAmount(code, row.amount)
        if (done) return
        done = true
        return deps.onPaid({ via: "ethereum", amount })
      }
      if (done) return
      done = true
      const payer = payerForPaidLink(row, receives, deps.contacts())
      deps.onPaid({
        via: "private",
        amount: tx.token.amount * (tx.token.price || 1),
        payer: payer?.displayName,
        payerId: payer?.contact?.id,
      })
    } finally {
      reading = false
    }
  }
  const onChange = () =>
    void check().catch((err) => console.warn("[receive] payment read failed:", err))
  onChange()
  const unsubscribe = requests.view.subscribe(onChange)
  return () => {
    done = true
    unsubscribe()
  }
}

/**
 * Receive's code and what paid it. Watches the address on Ethereum and the request id on private
 * transfers; a payment moves the code to the next ready address.
 */
export function useReceiveCode(enabled: boolean) {
  const identity = loadWalletIdentity()
  const tag = identity?.handle
  const obsidionWallet = useResource(useSession().wallet)
  const rollupAddress = obsidionWallet?.networkId
  const { contractService } = useContractServiceContext()
  const tokenService = useResource(useSession().token)
  const { activity, requests } = useSession()
  const [code, setCode] = useState<ReceiveCode>()
  const [paidWith, setPayment] = useState<PaidCode>()
  const [failed, setFailed] = useState(false)
  const contacts = useContactsDirectory()
  const directory = useRef(contacts)
  directory.current = contacts

  // Approval can land after the receipt shows, so `added` follows the contacts.
  const payerContact = contacts.contacts.find((c) => c.id === paidWith?.payerId)
  const payment = useMemo((): CodePayment | undefined => {
    if (!paidWith) return undefined
    const { payerId: _, ...shown } = paidWith
    return { ...shown, added: payerAddedToContacts(payerContact) }
  }, [paidWith, payerContact])

  const walletDeps = useMemo((): CodeDeps | null => {
    if (!enabled || !tag || !rollupAddress || !obsidionWallet || !contractService || !tokenService)
      return null
    return {
      key: receiveCodeKey(rollupAddress, tag),
      readyAddress: () =>
        getSipaDepositGateway()
          .readyAddress(obsidionWallet, contractService, tag, CODE_ADDRESS_MAX_AGE_MS)
          .catch((err) => {
            console.warn("[receive] no ready address:", err)
            return null
          }),
      mint: async (args) => {
        const token = await tokenService.fetchTokenInformation()
        return createAndStoreRequestLink(
          {
            requestId: randomCodeRequestId(),
            compact: true,
            requesterTag: tag,
            requesterAddress: identity?.address,
            tokenAddress: token.address,
            tokenDecimals: token.decimals,
            tokenSymbol: token.symbol,
            networkId: rollupAddress,
            baseUrl: requestLinkOrigin(),
            ...args,
          },
          requests,
        )
      },
      cancel: (requestId) => requests.cancel(requestId),
      paid: async (code) => {
        const saved = (await requests.all()).find((r) => r.id === code.requestId)
        if (saved?.status === "fulfilled") return true
        if (!code.address) return false
        const store = SIPADepositStore.get(webStorage)
        await store.load()
        const record = store.get(code.address)
        return !!record && !isUnfundedSipaDeposit(record)
      },
    }
  }, [
    enabled,
    tag,
    rollupAddress,
    obsidionWallet,
    contractService,
    tokenService,
    identity?.address,
    requests,
  ])
  // Dev demo has no wallet; a production build drops this body and the import with it.
  const [demoDeps, setDemoDeps] = useState<CodeDeps>()
  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode() || !enabled || !tag) return
    void import("../../dev/demoReceiveCode").then(({ demoCodeDeps, demoPayment }) => {
      setDemoDeps(demoCodeDeps(tag))
      setPayment(demoPayment(location.search))
    })
  }, [enabled, tag])
  const deps = demoDeps ?? walletDeps

  // One write at a time: two mints would show one code and leave the other's request behind.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const run = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(task, task)
    queue.current = next.catch(() => {})
    return next
  }, [])

  const load = useCallback(
    (read: (deps: CodeDeps) => Promise<ReceiveCode>) => {
      if (!deps) return
      void run(() => read(deps))
        .then((c) => {
          setFailed(false)
          setCode(c)
        })
        .catch((err) => {
          console.warn("[receive] code not minted:", err)
          setFailed(true)
        })
    },
    [deps, run],
  )
  const refresh = useCallback(() => load(currentCode), [load])

  // Each visit opens on a plain code, retried while it cannot be made.
  useEffect(() => load(openCode), [load])
  useEffect(() => {
    if (!failed || code) return
    const timer = setTimeout(() => load(openCode), POLL_MS)
    return () => clearTimeout(timer)
  }, [failed, code, load])

  // A paid code never shows again: it is dropped at once and its replacement retried until minted.
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(retry.current), [])
  const paid = useCallback(
    (paidCode: ReceiveCode, found: Omit<PaidCode, "hadAddress">) => {
      if (!deps) return
      setPayment({ ...found, hadAddress: !!paidCode.address })
      setCode(undefined)
      const replace = () =>
        void run(() => nextCode(deps, paidCode))
          .then(setCode)
          .catch((err) => {
            console.warn("[receive] next code not minted, retrying:", err)
            retry.current = setTimeout(replace, POLL_MS)
          })
      replace()
    },
    [deps, run],
  )

  // Ethereum: the rail's record of the address. A funded record is the payment.
  const demo = import.meta.env.DEV && isDemoMode()
  const watched = useDepositWatch(code?.address && !payment && !demo ? code.address : null)
  const { record } = watched
  useEffect(() => {
    if (code?.address && record && !isUnfundedSipaDeposit(record))
      paid(code, { via: "ethereum", amount: Number(record.amount) })
  }, [code, record, paid])

  // A code waiting for an address takes one when ready, and a stale one is replaced.
  useEffect(() => {
    if (!code || payment || demo) return
    const timer = setInterval(() => {
      if (!code.address || codeIsStale(code, Date.now())) refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [code, payment, demo, refresh])

  // Private: a receive carrying the code's request id pays it.
  useEffect(() => {
    if (!code || payment) return
    return watchRequestPayment(code, {
      requests,
      activity,
      contacts: () => directory.current.contacts,
      onPaid: (found) => paid(code, found),
    })
  }, [code, payment, paid, activity, requests])

  const setAmount = useCallback(
    async (form: CodeForm) => {
      if (!deps) throw new Error("wallet not ready")
      setCode(await run(() => setCodeAmount(deps, form)))
    },
    [deps, run],
  )
  const clearAmount = useCallback(async () => {
    if (!deps) return
    setCode(await run(() => clearCode(deps)))
  }, [deps, run])

  return {
    tag,
    code,
    payment,
    failed,
    ready: !!deps,
    setAmount,
    clearAmount,
    showCode: () => setPayment(undefined),
  }
}
