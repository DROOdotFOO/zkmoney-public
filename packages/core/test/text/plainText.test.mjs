import assert from "node:assert/strict"
import { test } from "node:test"
import { plainText } from "../../dist/text/index.js"

test("drops direction overrides", () => {
  assert.equal(plainText("ko " + String.fromCharCode(0x202e) + "olleh"), "ko olleh")
  assert.equal(
    plainText(
      String.fromCharCode(0x2067) + "abc" + String.fromCharCode(0x2069, 0x20, 0x200f) + "x",
    ),
    "abc x",
  )
})

test("caps stacked marks at three per letter", () => {
  const marks = String.fromCharCode(0x301, 0x302, 0x303, 0x304, 0x305, 0x306, 0x307, 0x308)
  assert.equal(plainText("q" + marks), "q" + marks.slice(0, 3))
})

test("leaves ordinary text alone", () => {
  for (const s of ["Lunch 🍕", "Tiếng Việt", "हिन्दी", "مرحبا", "e" + String.fromCharCode(0x301)])
    assert.equal(plainText(s), s.normalize("NFC"))
})
