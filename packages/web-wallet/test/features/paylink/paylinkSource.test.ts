import { beforeEach, expect, it, vi } from "vitest"
const { active, historic, readNote, findHistoric } = vi.hoisted(() => ({
  active: { portal: "0xnewportal", l2Token: "0xnewtoken" },
  historic: { portal: "0xoldportal", l2Token: "0xoldtoken" },
  readNote: vi.fn(),
  findHistoric: vi.fn(),
}))
vi.mock("../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../src/config/oxideTuple", () => ({ getOxideTuple: async () => active }))
vi.mock("../../../src/features/migration/historicTokenContext", () => ({
  findHistoricTuple: findHistoric,
}))
vi.mock("@obsidion/sdk", () => ({
  decodePaylinkInline: () => ({ secret: "link" }),
  readPaylinkEscrowNote: readNote,
}))
const { readPaylinkSource, assertPaylinkSwapSource } = await import(
  "../../../src/features/paylink/paylinkSource"
)

beforeEach(() => {
  readNote.mockReset()
  findHistoric.mockReset()
})
it("uses the escrow token to select its historical deployment", async () => {
  readNote.mockResolvedValue({ tokenAddress: { toString: () => "0xOLDTOKEN" }, amount: 12n })
  findHistoric.mockResolvedValue(historic)
  const result = await readPaylinkSource({} as never, "fragment")
  expect(result.tuple).toBe(historic)
  expect(result.note.amount).toBe(12n)
  expect(findHistoric).toHaveBeenCalledWith("0xOLDTOKEN")
})
it("refuses a delisted source instead of substituting active services", async () => {
  readNote.mockResolvedValue({ tokenAddress: { toString: () => historic.l2Token } })
  findHistoric.mockResolvedValue(null)
  await expect(readPaylinkSource({} as never, "fragment")).rejects.toThrow(
    "deployment is unavailable",
  )
})
it("rejects a preplanned swap from another portal or token", () => {
  expect(() => assertPaylinkSwapSource({ source: active }, historic as never)).toThrow(
    "another token deployment",
  )
  expect(() =>
    assertPaylinkSwapSource({ source: { ...historic, portal: active.portal } }, historic as never),
  ).toThrow()
  expect(() => assertPaylinkSwapSource({ source: historic }, historic as never)).not.toThrow()
})
