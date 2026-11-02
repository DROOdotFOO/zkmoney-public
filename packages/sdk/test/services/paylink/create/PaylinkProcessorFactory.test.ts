import { describe, it, expect } from "vitest"
import { PaylinkProcessorFactory } from "../../../../src/services/paylink/create/PaylinkProcessorFactory.js"
import type { ContractName } from "@obsidion/core/types"

describe("PaylinkProcessorFactory", () => {
  it("throws for a paylink type it does not route", () => {
    for (const type of ["paylinkTwitter", "paylinkZKPName"]) {
      expect(() => PaylinkProcessorFactory.create(type as ContractName)).toThrow(
        `Unsupported paylink type: ${type}`,
      )
    }
  })
})
