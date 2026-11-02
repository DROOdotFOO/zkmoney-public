import { describe, expect, it } from "vitest"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import { ServiceBase } from "../../src/services/ServiceBase.js"

const fakeSigner = () => ({} as RegisteredTeeSigner)

describe("ServiceBase.setTeeSigner clear path", () => {
  class TestService extends ServiceBase {
    constructor() {
      super({} as never)
    }
    public probe(): RegisteredTeeSigner {
      return this.getTeeSigner()
    }
  }

  it("setTeeSigner(undefined) clears a previously-wired signer", () => {
    const service = new TestService()
    const signer = fakeSigner()

    service.setTeeSigner(signer)
    expect(service.probe()).toBe(signer)

    service.setTeeSigner(undefined)
    expect(() => service.probe()).toThrow(/TEE signer not wired/)
  })

  it("setTeeSigner(signer) replaces a previously-wired signer", () => {
    const service = new TestService()
    const signerA = fakeSigner()
    const signerB = fakeSigner()

    service.setTeeSigner(signerA)
    expect(service.probe()).toBe(signerA)

    service.setTeeSigner(signerB)
    expect(service.probe()).toBe(signerB)
  })
})
