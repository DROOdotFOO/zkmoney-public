import assert from "node:assert/strict"
import { test } from "node:test"
import { goldenTicketQuote, registrationFloor } from "../../dist/constants/index.js"

const dai = (n) => BigInt(Math.round(n * 100)) * 10n ** 16n

test("the floor is the fee plus the minimum", () => {
  assert.equal(registrationFloor({ min: dai(9.5), fee: dai(4.9) }), dai(14.4))
  assert.equal(registrationFloor({ min: dai(4.4), fee: dai(0.5) }), dai(4.9))
})

const TIPS = {
  withdrawalFee: dai(0.2),
  relayerTip: dai(0.1),
  proverTip: dai(1),
  bridgeRemainder: dai(0.01),
}
const ticket = (min) => goldenTicketQuote({ min, fee: dai(0.5) }, TIPS)

test("a ticket burn funds the fee, the remainder, the executor's fee and the tips", () => {
  const quote = ticket(0n)
  assert.equal(quote.sipaTarget, dai(0.51))
  assert.equal(quote.burn, dai(1.81))
  assert.equal(quote.returned, dai(0.01))
})

test("a minimum above the remainder is funded once, not on top of it", () => {
  const quote = ticket(dai(1))
  assert.equal(quote.sipaTarget, dai(1.5))
  assert.equal(quote.burn, dai(2.8))
  assert.equal(quote.returned, dai(1))
})

test("the floor binds the target once the remainder falls under one wei", () => {
  const quote = goldenTicketQuote({ min: 0n, fee: dai(0.5) }, { ...TIPS, bridgeRemainder: 0n })
  assert.equal(quote.sipaTarget, dai(0.5) + 1n)
  assert.equal(quote.returned, 1n)
})
