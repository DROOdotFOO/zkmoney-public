import { createContext, useContext, type ReactNode } from "react"
import { assert } from "ts-essentials"
import type { AddressScreener } from "../core"

const ScreeningContext = createContext<AddressScreener | undefined>(undefined)

/** Provides the app's one AddressScreener; unconfigured builds pass `passThroughScreener`. */
export const ScreeningProvider = ({
  children,
  screener,
}: {
  children: ReactNode
  screener: AddressScreener
}) => {
  return <ScreeningContext.Provider value={screener}>{children}</ScreeningContext.Provider>
}

export const useScreener = (): AddressScreener => {
  const context = useContext(ScreeningContext)
  assert(context, "useScreener must be used within a ScreeningProvider")
  return context
}
