import { useRef, useSyncExternalStore } from "react"
import type { ReadonlyStore } from "../engine/store"

/**
 * Reads a store, or a selection of it, and re-renders when that changes. A selection keeps its
 * previous reference while `equals` holds, so derived arrays and objects don't re-render consumers.
 */
export function useStore<T>(store: ReadonlyStore<T>): T
export function useStore<T, S>(
  store: ReadonlyStore<T>,
  select: (value: T) => S,
  equals?: (a: S, b: S) => boolean,
): S
export function useStore<T, S>(
  store: ReadonlyStore<T>,
  select?: (value: T) => S,
  equals: (a: S, b: S) => boolean = Object.is,
): T | S {
  const cache = useRef<{
    input: T
    select?: (value: T) => S
    equals: (a: S, b: S) => boolean
    output: T | S
  } | null>(null)
  const snapshot = () => {
    const input = store.get()
    const last = cache.current
    if (last && Object.is(last.input, input) && last.select === select && last.equals === equals)
      return last.output
    const output = select ? select(input) : input
    const kept = last && select && equals(last.output as S, output as S) ? last.output : output
    cache.current = { input, select, equals, output: kept }
    return kept
  }
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
