/**
 * The accepted-token read a screen waits on: loading until the table is read, failed once a read fails, and read again
 * on Retry or after the retry delay, so the screen never stands in a token of its own.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  DEPOSIT_TOKENS_RETRY_MS,
  useDepositTokensRead,
} from "../../../src/features/deposit/loadDepositFacts"
import { singleToken } from "../../support/depositTokens"

const TOKENS = singleToken("0x00000000000000000000000000000000000000c6", "USDC", 6)
const h = { reads: 0, fail: true }
const load = async () => {
  h.reads++
  if (h.fail) throw new Error("rpc down")
  return TOKENS
}

let read: ReturnType<typeof useDepositTokensRead>
function Probe() {
  read = useDepositTokensRead("deposit", load)
  return null
}

let container: HTMLDivElement
let root: Root
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  h.reads = 0
  h.fail = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  container.remove()
})

it("loads, fails, and lists the table's tokens once Retry reads them", async () => {
  await act(async () => root.render(<Probe />))
  expect(read.tokens).toBeUndefined()
  await settle()
  expect(read.failed).toBe(true)
  expect(read.tokens).toBeUndefined()

  h.fail = false
  await act(async () => read.retry())
  expect(read.failed).toBe(false)
  await settle()
  expect(read.tokens).toBe(TOKENS)
  expect(read.failed).toBe(false)
})

it("reads again by itself after a failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  await act(async () => root.render(<Probe />))
  await settle()
  expect(read.failed).toBe(true)
  const before = h.reads

  h.fail = false
  await act(async () => vi.advanceTimersByTime(DEPOSIT_TOKENS_RETRY_MS))
  await settle()
  expect(h.reads).toBeGreaterThan(before)
  expect(read.tokens).toBe(TOKENS)
  expect(read.failed).toBe(false)
})
