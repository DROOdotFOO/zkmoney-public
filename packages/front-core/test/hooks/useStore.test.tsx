import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { memoryStore } from "../../src/engine/store"
import { useStore } from "../../src/hooks/useStore"

const select = (value: { n: number }) => ({ n: value.n })
const always = () => true
const byN = (a: { n: number }, b: { n: number }) => a.n === b.n

describe("useStore", () => {
  it("keeps the selection while equals holds", () => {
    const store = memoryStore({ n: 1 })
    const { result } = renderHook(() => useStore(store, select, byN))
    const first = result.current
    act(() => store.set({ n: 1 }))
    expect(result.current).toBe(first)
    act(() => store.set({ n: 2 }))
    expect(result.current).toEqual({ n: 2 })
  })

  it("selects again when equals changes after a skipped update", () => {
    const store = memoryStore({ n: 1 })
    const { result, rerender } = renderHook(({ equals }) => useStore(store, select, equals), {
      initialProps: { equals: always as typeof byN },
    })
    act(() => store.set({ n: 2 }))
    expect(result.current).toEqual({ n: 1 })
    rerender({ equals: byN })
    expect(result.current).toEqual({ n: 2 })
  })
})
