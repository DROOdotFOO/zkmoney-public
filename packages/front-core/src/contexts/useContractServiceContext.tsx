import { createContext, useContext, type ReactNode, useState, useEffect } from "react"
import { assert } from "ts-essentials"
import { type ContractService, Network } from "@obsidion/sdk"
import type { Resource } from "../engine/resource"
import { useStore } from "../hooks/useStore"

interface ContractServiceContextProps {
  contractService: ContractService | null
}

const ContractServiceContext = createContext<ContractServiceContextProps | undefined>(undefined)
ContractServiceContext.displayName = "ContractServiceContext"

/** Hands the page's contract service to screens; a failed build reaches the error boundary. */
export const ContractServiceProvider = ({
  children,
  contractService: service,
}: {
  children: ReactNode
  contractService: Resource<ContractService>
}) => {
  const state = useStore(service)
  const contractService = state.status === "ready" ? state.value : null
  // Mainnet-only hard boot error surfaced from the oxide manifest gate below.
  const [fatalError, setFatalError] = useState<Error | null>(null)

  // Oxide env-registry lifecycle: start the client so boot-time readers that never call
  // initialize() themselves still inherit manifest values, then gate mainnet on the result.
  //
  // Nothing subscribes. A tuple-to-tuple roll moves the token address, which signals a portal
  // roll rather than a stale cache — the upgrade's boot-time detection owns the response, and
  // reacting here would be a second, blinder detector for the same event.
  useEffect(() => {
    if (!contractService) return
    const client = contractService.getOxideClient()
    // No manifest for this environment (sandbox).
    if (!client) return

    let cancelled = false

    void (async () => {
      await client.initialize()
      if (cancelled) return
      // Mainnet: a wrong/partial/mismatched-gitSha manifest leaves the client
      // with no applied tuple and failureMode "manifest-incompatible". Surface a
      // hard boot error rather than silently degrading to empty address rows
      // with real funds. Gated on mainnet so testnet/sandbox are unchanged; a
      // transient "fetch-failed" is NOT fatal (the client retries).
      if (
        contractService.getNetwork() === Network.MAINNET &&
        !client.getCurrentTuple() &&
        client.getResolutionState().failureMode === "manifest-incompatible"
      ) {
        setFatalError(
          new Error(
            "Mainnet oxide manifest is incompatible (wrong schema, missing required field, or " +
              "gitSha mismatch). Refusing to boot against empty registry rows.",
          ),
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [contractService])

  if (state.status === "failed") throw state.error
  // Brick loudly on a fatal mainnet manifest incompatibility — the nearest error
  // boundary renders it instead of the app running against empty registry rows.
  if (fatalError) throw fatalError

  return (
    <ContractServiceContext.Provider value={{ contractService }}>
      {children}
    </ContractServiceContext.Provider>
  )
}

export const useContractServiceContext = (): ContractServiceContextProps => {
  const context = useContext(ContractServiceContext)
  assert(context, "useContractServiceContext must be used within a ContractServiceProvider")
  return context
}
