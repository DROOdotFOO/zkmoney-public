import type { PaylinkWindow } from "@obsidion/core/types"
import { describe, it, expect, beforeAll } from "vitest"
import {
  type PaylinkInitParams,
  PaylinkService,
} from "../../../src/services/paylink/PaylinkService.js"
import { derivePaylinkKeys } from "../../../src/services/paylink/escrow/paylinkKeys.js"
import { buildTransferMetaForSend } from "../../../src/services/token/transferMeta.js"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin"
import { readFileSync } from "fs"
import { resolve } from "path"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { DEFAULT_CONTRACTS } from "../../../src/index.js"
import type { ContractName, ContractService } from "../../../src/index.js"
import { ZKJWT_VKEY_HASH } from "@obsidion/core/constants"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"

describe("PaylinkService Encryption and URL Tests", () => {
  const bare = () => new PaylinkService(null as never, null as never, null as never, null as never)

  describe("serverless link (generate + parse)", () => {
    it("generates an inline link and parses it back to the original params", async () => {
      const keys = await derivePaylinkKeys({ secretKey: Fr.random(), fallbackSecret: Fr.random() })
      const params = {
        secret: Fr.random(),
        paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
        classId: Fr.random(),
        chainId: 11155111,
        fallbackKeyHash: keys.fallbackKeyHash,
        rollupVersion: 1,
        escrowTagSecret: Grumpkin.generator,
      }

      const url = await bare().generatePaymentLink(params)

      expect(url).toContain("paylink.zk.money/claim#")
      expect(url.split("#")).toHaveLength(2)

      const parsed = await PaylinkService.parsePaylinkUrl(url)
      expect(parsed.secret.toString()).toBe(params.secret.toString())
      expect(parsed.paylinkType).toBe(params.paylinkType)
      expect(parsed.classId.toString()).toBe(params.classId.toString())
      expect(parsed.chainId).toBe(params.chainId)
      expect(parsed.fallbackKeyHash.equals(params.fallbackKeyHash)).toBe(true)
      expect(parsed.escrowTagSecret?.equals(params.escrowTagSecret)).toBe(true)
    })

    it("throws on a URL with no fragment", async () => {
      await expect(
        PaylinkService.parsePaylinkUrl("https://paylink.zk.money/claim"),
      ).rejects.toThrow("Invalid paylink URL format")
    })
  })

  describe("Compute Commitment Hash", () => {
    it.each([
      [123, "Email must be a string"],
      [undefined, "Email must be a string"],
      ["", "Email must not be empty"],
      ["   ", "Email must not be empty"],
      ["notanemail", "Email must be valid"],
      ["@example.com", "Email must have characters before @"],
      ["test@", "Email must have characters after @"],
      [`${"a".repeat(60)}@example.com`, "exceeds 64 byte limit"],
    ])("rejects the email %j", async (email, error) => {
      await expect(
        bare().computeCommitmentHash(DEFAULT_CONTRACTS.paylinkEmail, { email } as never),
      ).rejects.toThrow(error)
    })
  })

  describe("Getting contract name for type", () => {
    it("should get correct name for paylink types", () => {
      const service = bare()
      expect(service.getContractNameForType(DEFAULT_CONTRACTS.paylinkEmail)).toBe(
        DEFAULT_CONTRACTS.paylinkEmail,
      )
      expect(service.getContractNameForType(DEFAULT_CONTRACTS.paylinkDirect)).toBe(
        DEFAULT_CONTRACTS.paylinkDirect,
      )
    })
  })

  describe("Getting constructor arguments for type", async () => {
    const mockEmailInput: PaylinkInitParams = {
      amount: BigInt(1000000),
      hash: Fr.random(),
      token: await AztecAddress.random(),
      window: {
        fromClaimable: BigInt(1718582400),
        untilClaimable: BigInt(1718582400) + BigInt(86400),
        refundableUntil: 0n,
      },
      registry_address: await AztecAddress.random(),
      vkey_hash: Fr.fromHexString(ZKJWT_VKEY_HASH),
    }

    const senderAddress = await AztecAddress.random()
    const service = new PaylinkService(
      null as never,
      { getAddress: () => senderAddress } as never,
      null as never,
      null as never,
    )

    it("should get correct constructor arguments for email paylink", async () => {
      const args = service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, mockEmailInput)
      expect(args).toEqual([
        mockEmailInput.amount,
        mockEmailInput.registry_address,
        mockEmailInput.vkey_hash,
        mockEmailInput.hash,
        mockEmailInput.window.fromClaimable,
        mockEmailInput.window.untilClaimable,
        mockEmailInput.window.refundableUntil,
        mockEmailInput.token,
        senderAddress,
        buildTransferMetaForSend({}),
      ])
    })

    it("passes the memo as the trailing deposit meta", async () => {
      const args = service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, {
        ...mockEmailInput,
        memo: "hi",
      })
      expect(args.at(-1)).toEqual(buildTransferMetaForSend({ memo: "hi" }))
    })

    it("passes an explicit funding meta through as the trailing deposit arg", async () => {
      const meta = [new Fr(7n)]
      const args = service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, mockEmailInput, meta)
      expect(args.at(-1)).toBe(meta)
    })

    it("should reject a missing sender for email paylink", () => {
      expect(() =>
        bare().getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, mockEmailInput),
      ).toThrow("email paylink requires a sender")
    })

    const withWindow = (over: Partial<PaylinkWindow>) => ({
      window: { ...mockEmailInput.window, ...over },
    })

    it.each([
      [{ amount: "1000000" }, "amount must be a bigint"],
      [{ amount: 0n }, "amount must be greater than 0"],
      [{ amount: -100n }, "amount must be greater than 0"],
      [{ hash: undefined }, "hash must be provided"],
      [{ token: null }, "token must be provided"],
      [withWindow({ fromClaimable: "123456" as never }), "fromClaimable must be a bigint"],
      [withWindow({ untilClaimable: 123456 as never }), "untilClaimable must be a bigint"],
      [withWindow({ refundableUntil: 1 as never }), "refundableUntil must be a bigint"],
      [withWindow({ fromClaimable: -1n }), "fromClaimable must be non-negative"],
      [withWindow({ untilClaimable: -1n }), "untilClaimable must be non-negative"],
      [withWindow({ refundableUntil: -1n }), "refundableUntil must be non-negative"],
      [
        withWindow({ fromClaimable: 1000n, untilClaimable: 500n, refundableUntil: 0n }),
        "untilClaimable must be greater than fromClaimable",
      ],
      [
        withWindow({ refundableUntil: mockEmailInput.window.untilClaimable + 1n }),
        "refundableUntil must not exceed untilClaimable",
      ],
    ])("rejects deposit args %o", (over, error) => {
      expect(() =>
        service.getConstructorArgs(DEFAULT_CONTRACTS.paylinkEmail, {
          ...mockEmailInput,
          ...over,
        } as never),
      ).toThrow(error)
    })
  })
})

describe("escrow class assertion", () => {
  // The artifact this binary would bundle, and the class derived from it — the value the assert
  // compares against in either mode. Read rather than hardcoded, so a recompile moves both sides.
  let artifact: ContractArtifact
  let artifactClassId: string

  beforeAll(async () => {
    artifact = loadContractArtifact(
      JSON.parse(
        readFileSync(
          resolve(
            __dirname,
            "../../../../contracts/src/artifacts/target/paylink_direct/paylink_direct-PaylinkDirect.json",
          ),
          "utf-8",
        ),
      ) as NoirCompiledContract,
    )
    artifactClassId = (await getContractClassFromArtifact(artifact)).id.toString()
  })

  /** A contract service that serves one artifact and whatever class id the config states. */
  const fakeContractService = (configuredClassId?: string | Error) =>
    ({
      getArtifactForContract: async () => artifact,
      getConfiguredClassId: () => {
        if (configuredClassId instanceof Error) throw configuredClassId
        return configuredClassId
      },
    } as unknown as ContractService)

  const derive = async (
    contractService: ContractService,
    type: ContractName = DEFAULT_CONTRACTS.paylinkDirect,
  ) => {
    const service = new PaylinkService(null as never, null as never, null as never, contractService)
    const paylinkKeys = await derivePaylinkKeys({
      secretKey: Fr.random(),
      fallbackSecret: Fr.random(),
    })
    return service.getContractInstance(type, [], undefined, paylinkKeys)
  }

  it("accepts a served class id in upper case", async () => {
    const upper = `0x${artifactClassId.slice(2).toUpperCase()}`
    await expect(derive(fakeContractService(upper))).resolves.toBeDefined()
  })

  it("rejects a served class id the binary does not compile to, naming both", async () => {
    const served = `0x${"9".repeat(64)}`
    await expect(derive(fakeContractService(served))).rejects.toThrow(served)
    await expect(derive(fakeContractService(served))).rejects.toThrow(artifactClassId)
  })

  it("fails closed when the config states no class for a supported type", async () => {
    const refused = new Error("The config profile states no class id for paylinkDirect")
    await expect(derive(fakeContractService(refused))).rejects.toThrow(/states no class id/)
  })

  it("skips the assert on a local-ledger service, which states no class ids", async () => {
    const { instance } = await derive(fakeContractService(undefined))
    expect(instance.currentContractClassId.toString()).toBe(artifactClassId)
  })
})
