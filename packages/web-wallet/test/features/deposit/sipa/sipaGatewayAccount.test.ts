/**
 * The gateway builds the session's account once and reuses it across sync ticks; a session with
 * another signer gets its own account, never the previous session's under the new key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ sessionKeys: vi.fn() }))

vi.mock("../../../../src/config/oxideTuple", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/oxideTuple")>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../../../../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/config/env")>()),
  getConfig: () => ({ network: "sandbox", l1ChainId: 31337 }),
}))
vi.mock("../../../../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ sessionKeys: h.sessionKeys }),
}))

const { getSipaDepositGateway, resetSipaDepositGatewayForTests } = await import(
  "../../../../src/features/deposit/sipaGateway"
)

const ADDRESS = `0x${"ab".repeat(20)}`
const session = () => ({ secretKey: {}, authProvider: {} })

beforeEach(() => {
  localStorage.clear()
  resetSipaDepositGatewayForTests()
})

describe("the gateway's account", () => {
  it("is built once for a session and again for a session with another signer", async () => {
    const createObsidionAccount = vi.fn(async (_key: unknown, authProvider: unknown) => ({
      authProvider,
    }))
    const wallet = { createObsidionAccount } as never
    // The landed check reads the session's account before anything else it needs.
    const read = () =>
      getSipaDepositGateway()
        .slotExecutor(wallet)
        .landed({ address: ADDRESS } as never)
    const alice = session()
    h.sessionKeys.mockResolvedValue(alice)
    await read()
    await read()
    expect(createObsidionAccount).toHaveBeenCalledTimes(1)
    const bob = session()
    h.sessionKeys.mockResolvedValue(bob)
    await read()
    expect(createObsidionAccount).toHaveBeenCalledTimes(2)
    expect(createObsidionAccount).toHaveBeenLastCalledWith(bob.secretKey, bob.authProvider)
    await read()
    expect(createObsidionAccount).toHaveBeenCalledTimes(2)
  })
})
