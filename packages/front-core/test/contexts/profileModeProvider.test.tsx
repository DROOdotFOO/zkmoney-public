/** Hermetic: the contract service and its oxide client are fakes behind a resource. */

import { describe, it, expect, beforeEach } from "vitest"
import React from "react"
import { render, waitFor } from "@testing-library/react"
import { Network, type ContractService } from "@obsidion/sdk"
import {
  ContractServiceProvider,
  useContractServiceContext,
} from "../../src/contexts/useContractServiceContext"
import { fixed, resource, type Resource } from "../../src/engine/resource"

const oxideClient = {
  failureMode: null as string | null,
  getCurrentTuple: () => null,
  async initialize() {},
  getResolutionState() {
    return { failureMode: this.failureMode }
  },
}

const env = { network: "testnet" as string, client: null as typeof oxideClient | null }

const service = () =>
  ({
    getOxideClient: () => env.client,
    getNetwork: () => env.network,
  } as unknown as ContractService)

class Boundary extends React.Component<
  { children: React.ReactNode; onError: (e: Error) => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: Error) {
    this.props.onError(e)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function boot(contractService: Resource<ContractService>) {
  const probe: { current: ReturnType<typeof useContractServiceContext> | null } = { current: null }
  const errors: Error[] = []
  const Probe = () => {
    probe.current = useContractServiceContext()
    return null
  }
  render(
    <Boundary onError={(e) => errors.push(e)}>
      <ContractServiceProvider contractService={contractService}>
        <Probe />
      </ContractServiceProvider>
    </Boundary>,
  )
  return { probe, errors }
}

beforeEach(() => {
  oxideClient.failureMode = null
  env.network = "testnet"
  env.client = null
})

describe("ContractServiceProvider", () => {
  it("hands screens the resource's service once it is ready", async () => {
    const ready = service()
    const { probe } = boot(fixed("contractService", ready))
    await waitFor(() => expect(probe.current?.contractService).toBe(ready))
  })

  it("a failed contract service surfaces through the error boundary", async () => {
    const failed = resource("contractService", { from: [], backoff: "manual" }, async () => {
      throw new Error('Config snapshot is for network "sandbox" but the wallet is on "testnet"')
    })
    const { errors } = boot(failed)
    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0].message).toMatch(/snapshot is for network "sandbox".*wallet is on "testnet"/)
  })

  it("a mainnet manifest incompatibility is fatal", async () => {
    env.network = Network.MAINNET
    env.client = oxideClient
    oxideClient.failureMode = "manifest-incompatible"
    const { errors } = boot(fixed("contractService", service()))
    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0].message).toMatch(/Mainnet oxide manifest is incompatible/)
  })
})
