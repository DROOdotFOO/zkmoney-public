import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AccountServiceError, type AccountServiceClient } from "@obsidion/front-core"
import { GoldenTicketWitnessError } from "@obsidion/sdk"

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  settled: vi.fn(),
  redeem: vi.fn(),
  prove: vi.fn(async (_inputs: Record<string, unknown>) => ({ proof: new Uint8Array([1, 2]) })),
  warm: vi.fn(async () => {}),
}))

vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  prepareGoldenTicketWitness: h.prepare,
  assertGoldenTicketNoteSettled: h.settled,
  decodePaylinkInline: () => ({}),
  ContractService: { getInstance: () => ({}) },
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  deriveBootstrapKey: () => ({ address: `0x${"11".repeat(20)}` }),
}))
const rememberTicketSpent = vi.fn()
vi.mock("../../../src/features/paylink/ticketSpent", () => ({ rememberTicketSpent }))
vi.mock("../../../src/features/paylink/goldenTicketProver", () => ({
  proveGoldenTicketInBrowser: h.prove,
  warmGoldenTicketProver: h.warm,
}))

const { PREPARED_ROOT_MAX_AGE_BLOCKS, prewarmGoldenTicket, redeemGoldenTicketForLink } =
  await import("../../../src/features/onboarding/goldenTicket")

const DAI = 10n ** 18n
const offer = {
  goldenTicket: { threshold: (2n * DAI).toString(), schedule: { fee: "1", minDeposit: "0" } },
}
const service = (info: object) =>
  ({
    domainInfo: async () => info,
    redeemGoldenTicket: h.redeem,
  } as unknown as AccountServiceClient)

/** A wallet whose node is at `head`; each test gets its own, so nothing prepared leaks between them. */
const walletAt = (head: { block: number }) =>
  ({ node: { getBlockNumber: async () => head.block } } as never)

const preparedAt = (blockNumber: number) => ({
  amount: 3n * DAI,
  inputs: { note: "n" },
  root: new Fr(1n),
  blockNumber,
  token: { toField: () => new Fr(9n) },
  classIds: [new Fr(3n), new Fr(4n)],
  uniqueNoteHash: new Fr(5n),
  nullifier: new Fr(2n),
})

const redeem = (wallet = walletAt({ block: 5 }), info: object = offer, onProving?: () => void) =>
  redeemGoldenTicketForLink({
    wallet,
    accountService: service(info),
    secretKey: {} as never,
    fragment: "frag",
    onProving,
  })

describe("redeemGoldenTicketForLink", () => {
  beforeEach(() => {
    h.prepare.mockReset()
    h.settled.mockReset()
    h.redeem.mockReset()
    h.prove.mockClear()
    h.prepare.mockImplementation(async () => preparedAt(5))
    h.settled.mockResolvedValue(undefined)
  })

  it("reads no offer as unavailable before any proof", async () => {
    await expect(redeem(undefined, { goldenTicket: null })).resolves.toEqual({
      status: "unavailable",
    })
    expect(h.prove).not.toHaveBeenCalled()
  })

  it("reads a redeem the service paused meanwhile as unavailable, keeping the amount", async () => {
    h.redeem.mockRejectedValueOnce(new AccountServiceError(503, "ticket_paused"))
    await expect(redeem()).resolves.toEqual({ status: "unavailable", amount: 3n * DAI })
  })

  it("surfaces every other refusal and returns the service's status otherwise", async () => {
    h.redeem.mockRejectedValueOnce(new AccountServiceError(400, "ticket_invalid"))
    await expect(redeem()).rejects.toThrow("ticket_invalid")
    h.redeem.mockRejectedValueOnce(new AccountServiceError(503, "golden ticket store unavailable"))
    await expect(redeem()).rejects.toThrow("store unavailable")
    h.redeem.mockResolvedValueOnce({ status: "created" })
    await expect(redeem()).resolves.toEqual({ status: "created", amount: 3n * DAI })
    expect(rememberTicketSpent).not.toHaveBeenCalled()
  })

  it("remembers a ticket the service refused as spent, and still surfaces the refusal", async () => {
    h.redeem.mockRejectedValueOnce(new AccountServiceError(409, "ticket_spent"))
    await expect(redeem()).rejects.toThrow("ticket_spent")
    expect(rememberTicketSpent).toHaveBeenCalledWith("frag")
  })

  it("binds the passkey's owner and the live threshold to the prepared witness, and says when it proves", async () => {
    h.redeem.mockResolvedValueOnce({ status: "created" })
    const onProving = vi.fn()
    await redeem(walletAt({ block: 5 }), offer, onProving)
    expect(onProving).toHaveBeenCalledTimes(1)
    expect(h.prove.mock.calls[0]![0]).toMatchObject({
      note: "n",
      owner: new Fr(BigInt(`0x${"11".repeat(20)}`)).toString(),
      threshold: `0x${(2n * DAI).toString(16)}`,
    })
    expect(h.redeem).toHaveBeenCalledWith(
      expect.objectContaining({
        blockNumber: 5,
        owner: `0x${"11".repeat(20)}`,
        classIds: [new Fr(3n).toString(), new Fr(4n).toString()],
      }),
    )
  })

  it("never proves a note below the live threshold", async () => {
    h.prepare.mockImplementation(async () => ({ ...preparedAt(5), amount: DAI }))
    const onProving = vi.fn()
    await expect(redeem(walletAt({ block: 5 }), offer, onProving)).resolves.toEqual({
      status: "below_threshold",
      amount: DAI,
    })
    expect(onProving).not.toHaveBeenCalled()
    expect(h.prove).not.toHaveBeenCalled()
  })

  describe("prepared before the passkey", () => {
    it("reads the witness again once its root has aged past the bound", async () => {
      const head = { block: 5 }
      const wallet = walletAt(head)
      prewarmGoldenTicket(wallet, "frag")
      head.block = 5 + PREPARED_ROOT_MAX_AGE_BLOCKS + 1
      h.prepare.mockImplementation(async () => preparedAt(head.block))
      h.redeem.mockResolvedValueOnce({ status: "created" })
      await redeem(wallet)
      expect(h.prepare).toHaveBeenCalledTimes(2)
      expect(h.redeem).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: head.block }))
    })

    it("reads the witness again when the head is below its root", async () => {
      const head = { block: 5 }
      const wallet = walletAt(head)
      h.prepare.mockImplementationOnce(async () => preparedAt(9))
      prewarmGoldenTicket(wallet, "frag")
      h.redeem.mockResolvedValueOnce({ status: "created" })
      await redeem(wallet)
      expect(h.prepare).toHaveBeenCalledTimes(2)
      expect(h.redeem).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 5 }))
    })

    it("reads the witness again on the retry after the service refused its root", async () => {
      const head = { block: 5 }
      const wallet = walletAt(head)
      prewarmGoldenTicket(wallet, "frag")
      h.redeem.mockRejectedValueOnce(new AccountServiceError(400, "ticket_root_mismatch"))
      await expect(redeem(wallet)).rejects.toThrow("ticket_root_mismatch")
      expect(h.prepare).toHaveBeenCalledTimes(1)

      head.block = 6
      h.prepare.mockImplementation(async () => preparedAt(6))
      h.redeem.mockResolvedValueOnce({ status: "created" })
      await expect(redeem(wallet)).resolves.toEqual({ status: "created", amount: 3n * DAI })
      expect(h.prepare).toHaveBeenCalledTimes(2)
      expect(h.redeem).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 6 }))
    })

    it("spends no ticket on a prepared note the link spent since, and reads it again on the retry", async () => {
      const wallet = walletAt({ block: 5 })
      prewarmGoldenTicket(wallet, "frag")
      const spent = new GoldenTicketWitnessError(
        "The link's note is no longer in this wallet's view.",
      )
      h.settled.mockRejectedValueOnce(spent)
      await expect(redeem(wallet)).rejects.toBe(spent)
      expect(h.settled).toHaveBeenCalledWith(
        expect.objectContaining({ wallet }),
        {},
        expect.objectContaining({ uniqueNoteHash: new Fr(5n) }),
      )
      expect(h.redeem).not.toHaveBeenCalled()

      // The retry reads the note afresh, which finds it gone.
      h.prepare.mockRejectedValue(spent)
      await expect(redeem(wallet)).rejects.toBe(spent)
      expect(h.settled).toHaveBeenCalledOnce()
      expect(h.redeem).not.toHaveBeenCalled()
    })

    it("checks no note it read just now", async () => {
      h.redeem.mockResolvedValueOnce({ status: "created" })
      await expect(redeem()).resolves.toEqual({ status: "created", amount: 3n * DAI })
      expect(h.settled).not.toHaveBeenCalled()
    })

    it("reads the witness again when the early read failed", async () => {
      const wallet = walletAt({ block: 5 })
      h.prepare.mockRejectedValueOnce(new Error("note not synced"))
      prewarmGoldenTicket(wallet, "frag")
      h.redeem.mockResolvedValueOnce({ status: "created" })
      await expect(redeem(wallet)).resolves.toEqual({ status: "created", amount: 3n * DAI })
      expect(h.prepare).toHaveBeenCalledTimes(2)
    })
  })
})
