import type { ReactNode } from "react"
import { ContractServiceProvider } from "./useContractServiceContext"
import type { ContractService } from "@obsidion/sdk"
import type { IStorageAdapter, NetworkStorageConfig } from "../core"
import type { Resource } from "../engine/resource"
import { StorageProvider, useStorageContext } from "./useStorageContext"

/** The storage singletons and the page's contract service. */
export const ObsidionCoreProvider = ({
  children,
  networkConfig,
  storageAdapter,
  contractService,
}: {
  children: ReactNode
  networkConfig: NetworkStorageConfig
  storageAdapter: IStorageAdapter
  contractService: Resource<ContractService>
}) => {
  return (
    <StorageProvider networkConfig={networkConfig} storageAdapter={storageAdapter}>
      <ObsidionCoreProviderInner contractService={contractService}>
        {children}
      </ObsidionCoreProviderInner>
    </StorageProvider>
  )
}

const ObsidionCoreProviderInner = ({
  children,
  contractService,
}: {
  children: ReactNode
  contractService: Resource<ContractService>
}) => {
  const { storageAdapter } = useStorageContext()
  if (!storageAdapter) return null
  return (
    <ContractServiceProvider contractService={contractService}>{children}</ContractServiceProvider>
  )
}
