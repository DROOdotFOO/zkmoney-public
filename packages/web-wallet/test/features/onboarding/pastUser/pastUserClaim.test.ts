import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { AccountServiceError } from "@obsidion/front-core"
import { seedBootConfig } from "../../../support/seedBootConfig"

const OWNER = `0x${"ab".repeat(20)}`
const h = vi.hoisted(() => ({ prove: vi.fn(), claim: vi.fn() }))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  deriveBootstrapKey: () => ({ address: `0x${"AB".repeat(20)}` }),
}))
vi.mock("../../../../src/features/onboarding/oxideOnboarding", () => ({
  collectOnboardingKeys: async () => ({ secretKey: "sk" }),
  accountServiceFor: () => ({ claimPastUser: h.claim }),
}))
vi.mock("../../../../src/features/onboarding/pastUserProver", () => ({ provePastUser: h.prove }))

const { claimPastUser, PastUserAlreadyUsedError } = await import(
  "../../../../src/features/onboarding/pastUserClaim"
)

describe("claimPastUser", () => {
  const proved = { proof: "0xaa", publicInputs: ["0x1", "0x2", "0x3", "0x4"] }
  beforeAll(seedBootConfig)
  beforeEach(() => {
    h.prove.mockReset().mockResolvedValue(proved)
    h.claim.mockReset().mockResolvedValue({ status: "created" })
  })

  it("proves for this account's bootstrap key and submits only the proof", async () => {
    await claimPastUser({} as never, "0x5151")
    expect(h.prove).toHaveBeenCalledWith({ signature: "0x5151", owner: OWNER })
    expect(h.claim).toHaveBeenCalledWith(proved)
  })

  it("reports a nullifier that was already spent", async () => {
    h.claim.mockRejectedValue(new AccountServiceError(409, "past_user_claimed"))
    await expect(claimPastUser({} as never, "0x5151")).rejects.toBeInstanceOf(
      PastUserAlreadyUsedError,
    )
  })
})
