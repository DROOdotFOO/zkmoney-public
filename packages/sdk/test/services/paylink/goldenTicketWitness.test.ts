import { describe, expect, it, vi } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { prepareGoldenTicketWitness } from "../../../src/services/paylink/goldenTicket.js"
import { LINK_CLASS_REFUSAL } from "../../../src/services/paylink/link/paylinkInlineCodec.js"

const CLASS_ID = new Fr(0xc1a55n)
const EMAIL_CLASS_ID = new Fr(0xe1a55n)
const OLDER_DIRECT = new Fr(0x01d0n)
const OLDER_EMAIL = new Fr(0x01e0n)
const AMOUNT = 3n * 10n ** 18n
const dao = {
  noteNonce: new Fr(11n),
  noteHash: new Fr(12n),
  randomness: new Fr(13n),
  note: {
    items: [1n, 2n, AMOUNT << 128n, 4n, 5n, 6n, 0x70cn].map((v) => new Fr(v)),
  },
}

function deps(notes = [dao]) {
  const node = {
    getBlockNumber: vi.fn(async () => 42),
    getBlockData: vi.fn(async () => ({
      header: { state: { partial: { noteHashTree: { root: new Fr(0x7007n) } } } },
    })),
    getNoteHashMembershipWitness: vi.fn(async () => ({
      leafIndex: 9n,
      siblingPath: [new Fr(21n), new Fr(22n)],
    })),
  }
  return {
    wallet: { pxe: { debug: { getNotes: vi.fn(async () => notes) } }, node },
    contractService: {
      getArtifactForContract: async (name: string) => ({
        classId: name === "paylinkEmail" ? EMAIL_CLASS_ID : CLASS_ID,
      }),
      getKnownClassIds: vi.fn(async (name: string) =>
        (name === "paylinkEmail" ? [EMAIL_CLASS_ID, OLDER_EMAIL] : [CLASS_ID, OLDER_DIRECT]).map(
          String,
        ),
      ),
    },
    node,
  }
}

describe("golden ticket class pair", () => {
  const direct = { paylinkType: "paylinkDirect" }

  it("refuses a link under a class this deployment never reviewed, before any read", async () => {
    const d = deps()
    const contractService = {
      ...d.contractService,
      getArtifactForClass: async (classId: string) => {
        throw new Error(`No artifact for contract class ${classId}`)
      },
      getKnownClassIds: async () => [CLASS_ID.toString(), OLDER_DIRECT.toString()],
    }
    const link = {
      ...direct,
      classId: new Fr(0xbadn),
      secret: new Fr(1n),
      fallbackKeyHash: new Fr(2n),
    }
    await expect(
      prepareGoldenTicketWitness({ ...d, contractService } as never, link as never),
    ).rejects.toThrow(LINK_CLASS_REFUSAL)
    expect(d.wallet.pxe.debug.getNotes).not.toHaveBeenCalled()
    expect(d.node.getBlockNumber).not.toHaveBeenCalled()
  })
})
