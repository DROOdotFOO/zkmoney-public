import { describe, expect, it, vi } from "vitest"
import {
  MetadataMigrationService,
  type MetadataMigrationSource,
} from "../../../src/services/migration/MetadataMigrationService.js"

const OWNER = "0x00000000000000000000000000000000000000a1"
const REGISTRY = "0x00000000000000000000000000000000000000a2"
const NAME_PORTAL = "0x00000000000000000000000000000000000000a3"
const FPC = "0x00000000000000000000000000000000000000a4"
const PASSKEY = { qx: "0x01", qy: "0x02" }

type Progress = (approved: number, total: number) => Promise<void>

/** The registration run's source is this version: it holds nothing to move. */
function fixture(options: object = {}) {
  const fpc = { equals: () => true, toString: () => FPC }
  const source = {
    identity: "no-source-deployment",
    state: vi.fn(async (): Promise<"frozen" | "empty"> => "empty"),
  }
  const service = new MetadataMigrationService({
    source: source as unknown as MetadataMigrationSource,
    owner: OWNER,
    record: {
      l2Address: `0x${"11".repeat(32)}`,
      rollupVersion: 7n,
      publicKey: { x: 1n, y: 2n },
      resolverOperator: "0x00000000000000000000000000000000000000a5",
    },
    destination: {
      token: "0x00000000000000000000000000000000000000b0",
      rollupVersion: 7n,
      metadataRegistry: REGISTRY,
      namePortal: NAME_PORTAL,
    },
    bootstrap: { fpcAddress: fpc, user: fpc, railId: 0 },
    registered: { fpcAddress: fpc, user: fpc, railId: 1 },
    wallet: { node: { getNodeInfo: async () => ({ rollupVersion: 7 }) }, sendTx: vi.fn() },
    client: { getBlockNumber: async () => 100n },
    nameClaim: async () => ({ kind: "nameClaim" }),
    recordPasskey: PASSKEY,
    signRecordUpdate: vi.fn(),
    ...options,
  } as never)
  return { service, source }
}

/** A frozen source moves only funds, by its own batches. */
function fundsOnly(options: object = {}) {
  const f = fixture(options)
  const prepareRemaining = vi.fn(async (opts: { signal?: AbortSignal; onApproval?: Progress }) => {
    opts.signal?.throwIfAborted()
  })
  Object.assign(f.source, { identity: "frozen-source", fundsOnly: true, prepareRemaining })
  f.source.state.mockResolvedValue("frozen")
  return { ...f, prepareRemaining }
}

describe("preparing the registration run", () => {
  it("refuses to update the record from a frozen source, which moves only funds", async () => {
    const { service, source } = fixture()
    source.state.mockResolvedValue("frozen")

    await expect(service.prepare()).rejects.toThrow("moves only funds")
  })
})

describe("a funds-only run", () => {
  it("rejects a follower whose source is not frozen", async () => {
    const f = fundsOnly({ recoveryOnly: true })
    f.source.state.mockResolvedValue("empty")
    await expect(f.service.prepare()).rejects.toThrow("requires a frozen source")
  })

  it("passes the cancel signal and the send gate to the source's reconcile, which can send a due broadcast again", async () => {
    const f = fundsOnly()
    const reconcileRemaining = vi.fn<(signal?: AbortSignal, gate?: unknown) => Promise<void>>()
    Object.assign(f.source, { reconcileRemaining })
    const cancel = new AbortController()
    const gate = <T>(step: (operationId?: string) => Promise<T>) => step()
    const plan = JSON.stringify({
      binding: await f.service.binding(),
      recoveryOnly: true,
      sourceState: "frozen",
    })

    await f.service.reconcileRemaining(plan, cancel.signal, gate)

    expect(reconcileRemaining).toHaveBeenCalledWith(cancel.signal, gate)
    await expect(f.service.reconcileRemaining("{}", cancel.signal, gate)).rejects.toThrow(
      "Migration account or deployment changed",
    )
  })
})
