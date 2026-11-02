import { Gas, GasFees, GasSettings } from "@aztec-labs/stdlib/gas"

/** Node-advertised per-tx gas admission limits for wallet unit-test stubs. */
export const STUB_TXS_LIMITS_GAS = { daGas: 500_000, l2Gas: 500_000 }

/** Minimal `getNodeInfo()` payload for obsidion-wallet unit tests. */
export function stubNodeInfo(overrides?: Partial<{ l1ChainId: number; rollupVersion: number }>) {
  return {
    l1ChainId: overrides?.l1ChainId ?? 31337,
    rollupVersion: overrides?.rollupVersion ?? 1,
    txsLimits: { gas: STUB_TXS_LIMITS_GAS },
  }
}

/** v5 `GasSettings.fallback` requires explicit `gasLimits`. */
export function stubGasSettingsFallback(overrides?: { maxFeesPerGas?: GasFees; gasLimits?: Gas }) {
  return GasSettings.fallback({
    gasLimits: overrides?.gasLimits ?? Gas.from(STUB_TXS_LIMITS_GAS),
    maxFeesPerGas: overrides?.maxFeesPerGas ?? GasFees.empty(),
  })
}
