import { useEffect, useState } from "react"
import { GradientText } from "@obsidion/web-ds"
import { useContractServiceContext, useResource } from "@obsidion/front-core"
import { PER_INSTANCE_CONTRACTS } from "@obsidion/config-client"
import { DEFAULT_CONTRACTS_NAME } from "@obsidion/core/constants"
import type { ContractName, OxideEnvTuple } from "@obsidion/core/types"
import { Modal } from "./Modal"
import { useCopy } from "./hooks"
import { useSession } from "../platform/session"

type Chain = "L1" | "L2"

type Row = { label: string; chain: Chain; value?: string }

type Group = { title: string; rows: Row[] }

const FLEET_CONTRACTS = DEFAULT_CONTRACTS_NAME.filter(
  (name) => !(PER_INSTANCE_CONTRACTS as readonly ContractName[]).includes(name),
)

type TupleNonAddress =
  | "version"
  | "gitSha"
  | "timestamp"
  | "deployedAt"
  | "deployedAtBlock"
  | "chainId"
  | "enclaveUrl"
  | "pcr0"
  | "rollupVersion"
  | "ensDomain"
  | "resolverGatewayUrl"
  | "frozenNotesRefundVkSha256"
  | "frozenDepositRefundVkSha256"
  | "fpcBeneficiarySalt"
  | "sipaRecoveryProtocol"
  | "bridgeKey"
  | "bridgeId"
  | "features"
  | "l2TokenImmutables"

const OXIDE_CHAIN = {
  portal: "L1",
  token: "L1",
  underlying: "L1",
  l2Token: "L2",
  registry: "L1",
  accountMetadataRegistry: "L1",
  registrationController: "L1",
  namePortal: "L1",
  accountFactory: "L1",
  entryPoint: "L1",
  paymaster: "L1",
  sipaFactory: "L1",
  sipaResolver: "L1",
  resolverProofVerifier: "L1",
  depositSIPAImplementation: "L1",
  registrationSIPAImplementation: "L1",
  forwardingTable: "L1",
  feeToken: "L1",
  depositSubsidy: "L1",
  withdrawalSubsidy: "L1",
  proverSubsidy: "L1",
  plainWithdrawalExecutor: "L1",
  swapEscrowFactoryV2: "L1",
  skyEscrowFactory: "L1",
  operationExecutor: "L1",
  certManager: "L1",
  nitroValidator: "L1",
  frozenNotesRefundVerifier: "L1",
  frozenDepositRefundVerifier: "L1",
  unprocessedDepositRefundVerifier: "L1",
  l2Broadcaster: "L2",
  fpcFunder: "L1",
  fpcBeneficiary: "L2",
} satisfies Record<Exclude<keyof OxideEnvTuple, TupleNonAddress>, Chain>

const NODE_L1 = {
  rollup: "rollupAddress",
  registry: "registryAddress",
  inbox: "inboxAddress",
  outbox: "outboxAddress",
  feeJuice: "feeJuiceAddress",
  feeJuicePortal: "feeJuicePortalAddress",
} as const

const text = (value: unknown): string | undefined => {
  const s = value == null ? "" : String(value)
  return s.trim() ? s : undefined
}

function AddressRow({ row }: { row: Row }) {
  const { copied, copy } = useCopy()
  const head = (
    <span className="ww-addresses__head">
      <span className="ww-addresses__label">{row.label}</span>
      <span className="ww-addresses__chain">{row.chain}</span>
      {copied && <span className="ww-addresses__copied">Copied</span>}
    </span>
  )
  if (!row.value) {
    return (
      <div className="ww-addresses__row ww-addresses__row--unresolved">
        {head}
        <code className="ww-addresses__value">not resolved</code>
      </div>
    )
  }
  const value = row.value
  return (
    <button
      type="button"
      className="zkm-btn-reset ww-addresses__row"
      aria-label={`Copy ${row.label}`}
      onClick={() => void copy(value)}
    >
      {head}
      <code className="ww-addresses__value">{value}</code>
    </button>
  )
}

/** Deployment contracts the wallet points at: profile L2 set, oxide manifest tuple, Aztec protocol. */
export function ContractAddressesModal({ onClose }: { onClose: () => void }) {
  const { contractService } = useContractServiceContext()
  const obsidionWallet = useResource(useSession().wallet)
  const node = obsidionWallet?.node
  const [groups, setGroups] = useState<Group[]>()

  useEffect(() => {
    if (!contractService) {
      setGroups([])
      return
    }
    let cancelled = false
    void (async () => {
      const client = contractService.getOxideClient()
      await client?.initialize()
      if (cancelled) return
      const tuple = client?.getCurrentTuple() ?? null
      const l2 = await Promise.allSettled(
        FLEET_CONTRACTS.map((name) => contractService.getContractAddress(name)),
      )
      if (cancelled) return
      const info = node ? await node.getNodeInfo().catch(() => undefined) : undefined
      if (cancelled) return
      const l2Rows = FLEET_CONTRACTS.map((label, i): Row => {
        const result = l2[i]
        const value = result.status === "fulfilled" ? text(result.value?.toString()) : undefined
        return { label, chain: "L2", value }
      })
      const oxideRows = Object.entries(OXIDE_CHAIN).map(
        ([field, chain]): Row => ({
          label: field,
          chain,
          value: text(tuple?.[field as keyof typeof OXIDE_CHAIN]),
        }),
      )
      const featureRows = (tuple?.features ?? []).flatMap((feature) =>
        Object.entries(feature.contracts).map(
          ([name, address]): Row => ({
            label: `${feature.id} ${name}`,
            chain: "L1",
            value: text(address),
          }),
        ),
      )
      const nodeRows: Row[] = [
        ...Object.entries(NODE_L1).map(
          ([label, key]): Row => ({
            label,
            chain: "L1",
            value: text(info?.l1ContractAddresses[key]?.toString()),
          }),
        ),
        {
          label: "feeJuice (L2)",
          chain: "L2",
          value: text(info?.protocolContractAddresses.feeJuice?.toString()),
        },
      ]
      setGroups([
        { title: "zk.money contracts", rows: l2Rows },
        { title: "Oxide deployment", rows: [...oxideRows, ...featureRows] },
        { title: "Aztec protocol", rows: nodeRows },
      ])
    })()
    return () => {
      cancelled = true
    }
  }, [contractService, node])

  return (
    <Modal variant="create" label="Contract addresses" onClose={onClose} className="ww-feedback">
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        Contract addresses
      </GradientText>
      <div className="ww-addresses">
        {groups === undefined && <p className="ww-supportid__note">Loading…</p>}
        {groups?.length === 0 && (
          <p className="ww-supportid__note">No contract service in this session.</p>
        )}
        {groups?.map((group) => (
          <section key={group.title} className="ww-contacts__section">
            <span className="ww-contacts__label">{group.title}</span>
            <div className="ww-contacts__group ww-addresses__group">
              {group.rows.map((row) => (
                <AddressRow key={row.label} row={row} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}
