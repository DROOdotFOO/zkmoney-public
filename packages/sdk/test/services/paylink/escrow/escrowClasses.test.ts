/**
 * Paylink escrows across classes. Escrow keys ignore the class, so a link carries its class and the
 * wallet opens it under that class, and a new link never takes a slot an escrow of another class
 * already holds (the two would share a secret). Real compiled artifacts; no PXE, no node.
 */
import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "fs"
import { resolve } from "path"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import {
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from "@aztec-labs/stdlib/contract"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { PaylinkService } from "../../../../src/services/paylink/PaylinkService.js"
import { linkEscrow } from "../../../../src/services/paylink/escrow/paylinkEscrow.js"
import { deriveDeterministicPaylinkKeys } from "../../../../src/services/paylink/escrow/paylinkKeys.js"
import { epochDay } from "../../../../src/utils/helper.js"
import { createTransferEventSource } from "../../../../src/services/token/transferEventSource.js"
import { buildTransferMeta } from "../../../../src/services/token/transferMeta.js"

const target = (path: string) =>
  loadContractArtifact(
    JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../../contracts/src/artifacts/target", path),
        "utf-8",
      ),
    ) as NoirCompiledContract,
  )
const CURRENT = target("paylink_direct/paylink_direct-PaylinkDirect.json")
// Another escrow class with the same derivation, standing in for an earlier PaylinkDirect class.
const EARLIER = target("paylink_email/paylink_email-PaylinkEmail.json")
const classId = async (artifact: typeof CURRENT) =>
  (await getContractClassFromArtifact(artifact)).id.toString()

const escrowAt = (artifact: typeof CURRENT, publicKeys: unknown) =>
  getContractInstanceFromInstantiationParams(artifact, {
    salt: new Fr(0n),
    publicKeys: publicKeys as never,
  })

describe("paylink escrow classes", () => {
  it("opens a link under the class it carries", async () => {
    const keys = await deriveDeterministicPaylinkKeys(Fr.random(), 20_000, 0, "paylinkDirect")
    const earlier = await escrowAt(EARLIER, keys.publicKeys)
    const contractService = {
      getArtifactForClass: async (id: string) =>
        id === (await classId(EARLIER)) ? EARLIER : CURRENT,
      getKnownClassIds: async () => [await classId(CURRENT), await classId(EARLIER)],
    }
    const params = {
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      classId: earlier.currentContractClassId,
      secret: keys.secretKey,
      fallbackKeyHash: keys.fallbackKeyHash,
    }

    const { instance } = await linkEscrow(contractService as never, params)

    expect(instance.address.equals(earlier.address)).toBe(true)
  })

  it("refuses a class the deployment never reviewed, and keeps a reviewed class's fetch error", async () => {
    const keys = await deriveDeterministicPaylinkKeys(Fr.random(), 20_000, 0, "paylinkDirect")
    const params = {
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      classId: Fr.fromHexString(await classId(EARLIER)),
      secret: keys.secretKey,
      fallbackKeyHash: keys.fallbackKeyHash,
    }
    const failing = (known: string[]) => ({
      getArtifactForClass: async () => {
        throw new Error("artifact store unreachable")
      },
      getKnownClassIds: async () => known,
    })

    await expect(linkEscrow(failing([await classId(CURRENT)]) as never, params)).rejects.toThrow(
      /another version of the app/,
    )
    await expect(linkEscrow(failing([await classId(EARLIER)]) as never, params)).rejects.toThrow(
      /artifact store unreachable/,
    )
  })

  it("skips a slot an escrow of another class already holds", async () => {
    const masterSecret = Fr.random()
    const day = epochDay(Math.floor(Date.now() / 1000))
    const slotZero = await deriveDeterministicPaylinkKeys(masterSecret, day, 0, "paylinkDirect")
    const taken = (await escrowAt(EARLIER, slotZero.publicKeys)).address
    const allocate = async (known: string[]) => {
      const wallet = {
        pxe: {
          getContractInstance: async (address: AztecAddress) =>
            address.equals(taken) ? { address } : undefined,
        },
        node: {
          findLeavesIndexes: async (_: unknown, __: unknown, leaves: unknown[]) =>
            leaves.map(() => undefined),
        },
      }
      const service = new PaylinkService(
        wallet as never,
        {} as never,
        null as never,
        {
          getArtifactForContract: async () => CURRENT,
          getKnownClassIds: async () => known,
        } as never,
      )
      const internal = service as unknown as {
        deriveDepositKeys(type: string, secret: Fr): Promise<{ nonce: unknown }>
      }
      return (await internal.deriveDepositKeys(DEFAULT_CONTRACTS.paylinkDirect, masterSecret)).nonce
    }

    expect(await allocate([await classId(CURRENT)])).toEqual({ day, n: 0 })
    expect(await allocate([await classId(CURRENT), await classId(EARLIER)])).toEqual({ day, n: 1 })
  })

  describe("payout lanes", () => {
    const ACCOUNT = AztecAddress.fromBigIntUnsafe(11n)
    /** One incoming Transfer from `from`, carrying a direct payout lane for these keys. */
    const listFrom = async (
      from: AztecAddress,
      keys: { secretKey: Fr; fallbackKeyHash: Fr },
      known: () => Promise<string[]>,
    ) => {
      const wallet = {
        getPrivateEvents: async () => [
          {
            event: {
              from,
              to: ACCOUNT,
              amount: 5n,
              meta: buildTransferMeta({
                paylinkPayout: {
                  flavor: "direct",
                  secret: keys.secretKey,
                  fallbackKeyHash: keys.fallbackKeyHash,
                },
              }),
            },
            metadata: { txHash: "0xabc", l2BlockNumber: 3 },
          },
        ],
      }
      const source = createTransferEventSource({
        wallet: wallet as never,
        tokenAddress: AztecAddress.fromBigIntUnsafe(44n).toString(),
        accountAddress: ACCOUNT.toString(),
        contractService: {
          getArtifactForContract: async () => CURRENT,
          getKnownClassIds: known,
        } as never,
      })
      const [event] = await source.listIncoming(0, 10)
      return event!
    }

    it("keeps a lane its keys derive under the current class without reading the catalog", async () => {
      const keys = await deriveDeterministicPaylinkKeys(Fr.random(), 20_000, 0, "paylinkDirect")
      const known = vi.fn(async () => [])
      const event = await listFrom((await escrowAt(CURRENT, keys.publicKeys)).address, keys, known)
      expect(event.paylinkPayout).toBeDefined()
      expect(known).not.toHaveBeenCalled()
    })

    it("keeps an earlier class's lane, and fails the read when the catalog cannot answer", async () => {
      const keys = await deriveDeterministicPaylinkKeys(Fr.random(), 20_000, 0, "paylinkDirect")
      const earlier = (await escrowAt(EARLIER, keys.publicKeys)).address
      const both = async () => [await classId(CURRENT), await classId(EARLIER)]
      expect((await listFrom(earlier, keys, both)).paylinkPayout).toBeDefined()
      await expect(
        listFrom(earlier, keys, async () => {
          throw new Error("catalog unreachable")
        }),
      ).rejects.toThrow(/catalog unreachable/)
    })
  })
})
