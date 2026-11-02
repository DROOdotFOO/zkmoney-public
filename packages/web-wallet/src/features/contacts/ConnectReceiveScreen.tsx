import { useEffect, useRef, useState } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { CONNECT_BACK_VERSION } from "@obsidion/sdk"
import {
  ContactStorage,
  PendingConnectBackStorage,
  decodeInline,
  type Contact,
} from "@obsidion/front-core"
import {
  GradientInitialAvatar,
  GradientText,
  PrimaryGradientButton,
  Spinner,
  avatarColors,
} from "@obsidion/web-ds"
import { showReportableError } from "../../errors/errorModal"
import { Modal } from "../../ui/Modal"
import { getXmtpSender } from "../../platform/xmtp/xmtpLifecycle"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { ContactsScreen } from "./ContactsScreen/ContactsScreen"
import {
  confirmConnect,
  previewConnect,
  stashInboundConnect,
  stashToPayload,
  takeConnectStash,
  type ConnectPreview,
} from "./connectReceive"
import { verifyTag } from "./registryResolution"

type ViewState =
  | { kind: "loading" }
  | { kind: "confirm"; preview: ConnectPreview }
  | { kind: "self-scan" }
  | { kind: "conflict"; scanned: Contact; existing: Contact }
  | { kind: "error"; message: string }

const handleOf = (contact: Contact) => (contact.tag ? `@${contact.tag}` : contact.name)

/** Post-unlock landing for an inbound connect link: decode + verify the stashed packet, then
 *  require an explicit "Add contact" before anything is written or queued (AE10). Rendered as a
 *  sheet over the contacts directory, which is where a dismiss lands. */
export function ConnectReceiveScreen() {
  const navigate = useNavigate()
  const [state, setState] = useState<ViewState>({ kind: "loading" })
  const [adding, setAdding] = useState(false)
  // The stash is consume-once; StrictMode's dev double-effect must not take it twice.
  const consumed = useRef(false)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (consumed.current) return
    consumed.current = true
    // In-app navigations reach here without passing the App-mount capture — stash-and-strip again
    // (no-op when the fragment is already gone), then consume.
    stashInboundConnect()
    const stash = takeConnectStash()
    if (!stash) {
      navigate("/contacts", { replace: true })
      return
    }
    const identity = loadWalletIdentity()
    previewConnect(stashToPayload(stash), {
      decodeInline,
      verifyTag,
      ownTag: identity?.handle,
      ownL2Address: identity?.address,
    })
      .then((result) => {
        if (!mounted.current) return
        if (result.kind === "error") {
          showReportableError(new Error(result.message), "contacts:connect-preview")
        }
        setState(result.kind === "confirm" ? { kind: "confirm", preview: result.preview } : result)
      })
      .catch((error) => {
        if (!mounted.current) return
        showReportableError(error, "contacts:connect-preview", {
          message: "Couldn't read this code",
        })
        setState({ kind: "error", message: "Couldn't read this code" })
      })
  }, [navigate])

  const dismiss = () => navigate("/contacts", { replace: true })

  const add = async (preview: ConnectPreview) => {
    setAdding(true)
    const sender = getXmtpSender()
    const result = await confirmConnect(preview, {
      addOrMergeContact: (entry) => ContactStorage.get().addOrMergeContact(entry),
      sendConnectBack: sender ? (peer, content) => sender.sendConnectBack(peer, content) : undefined,
      queueConnectBack: (entry) => PendingConnectBackStorage.get().enqueue(entry),
      connectBackVersion: CONNECT_BACK_VERSION,
      ownTag: loadWalletIdentity()?.handle,
    })
    setAdding(false)
    if (result.kind === "added") {
      navigate(`/contacts/${encodeURIComponent(result.navigateId)}`, { replace: true })
    } else if (result.kind === "conflict") {
      setState({ kind: "conflict", scanned: preview.contact, existing: result.contact })
    } else {
      showReportableError(new Error(result.message), "contacts:connect-confirm")
      setState(result)
    }
  }

  const sheet = () => {
    switch (state.kind) {
      case "loading":
        return (
          <Modal variant="create" label="Add contact" onClose={dismiss}>
            <div className="ww-connect__status">
              <Spinner size={20} />
              Verifying code…
            </div>
          </Modal>
        )
      case "self-scan":
        return (
          <Modal variant="create" label="Add contact" onClose={dismiss}>
            <div className="ww-connect__status">This is your own code.</div>
          </Modal>
        )
      case "conflict":
        return (
          <Modal variant="create" label="Add contact" onClose={dismiss}>
            <div className="ww-connect__status">
              {handleOf(state.scanned)} wasn't added. {handleOf(state.existing)} in your contacts
              has the same address or name.
            </div>
          </Modal>
        )
      case "error":
        // The reportable-error sheet already carries the message.
        return <Navigate to="/contacts" replace />
      case "confirm": {
        const { contact } = state.preview
        const handle = handleOf(contact)
        const avatarKey = contact.tag ?? contact.name
        return (
          <Modal variant="create" label="Add contact" onClose={adding ? undefined : dismiss}>
            <div className="ww-create-modal__body">
              <div className="ww-create-modal__head">
                <GradientInitialAvatar name={avatarKey} colors={avatarColors(avatarKey)} size={64} />
                <div className="ww-share-modal__title">
                  <GradientText size={24} weight={700} className="ww-connect__identity">
                    {handle}
                  </GradientText>
                  <span className="ww-connect__sub">Wants to connect</span>
                </div>
              </div>
              <div className="ww-connect__actions">
                <PrimaryGradientButton
                  title="Add contact"
                  isLoading={adding}
                  onClick={() => void add(state.preview)}
                />
                <PrimaryGradientButton
                  title="Decline"
                  buttonStyle="dark"
                  isDisabled={adding}
                  onClick={dismiss}
                />
              </div>
            </div>
          </Modal>
        )
      }
    }
  }

  return (
    <>
      <ContactsScreen />
      {sheet()}
    </>
  )
}
