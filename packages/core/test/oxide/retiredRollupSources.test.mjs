import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isRetiredRollupSource,
  parseDeployment,
  retiredRollupSources,
} from "../../dist/oxide/index.js"

const REGISTRY = "0xa14905681a6d078c0bd03957df3685d4f009aacb"
const OTHER_REGISTRY = "0xb14905681a6d078c0bd03957df3685d4f009aacb"
const ACCOUNT_FACTORY = "0x842f0f87bf2318fe7b68a516e360cd1fded36c9b"
const NAME_PORTAL = "0x5555555555555555555555555555555555555555"
const ZERO_L1 = `0x${"0".repeat(40)}`

/** A unique, well-formed L1 address per label — every manifest entry needs a distinct portal. */
function portalFor(label) {
  return `0x${Buffer.from(label).toString("hex").padEnd(40, "0").slice(0, 40)}`
}

function entry(overrides) {
  return {
    portal: portalFor(overrides.label),
    token: "0x6b9ef1a089feeff90695ac7cf19be39f4b8a0334",
    l2Token: `0x${"11".repeat(32)}`,
    enclaveUrl: "https://tee.example.test/rpc",
    deployedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nameRegistry: REGISTRY,
    accountFactory: ACCOUNT_FACTORY,
    namePortal: NAME_PORTAL,
    ...overrides,
  }
}

const PINNED_ENTRY = entry({ label: "current", rollupVersion: "7", chainId: "1" })
const pinned = parseDeployment(PINNED_ENTRY).tuple

function manifestWith(...deployments) {
  return { schemaVersion: "4", deployments: [PINNED_ENTRY, ...deployments] }
}

test("retiredRollupSources returns a well-formed entry on a different rollup, same L1 chain and registry", () => {
  const retired = entry({ label: "retired", rollupVersion: "6", chainId: "1" })
  const manifest = manifestWith(retired)
  assert.deepEqual(
    retiredRollupSources(manifest, pinned).map((t) => t.version),
    ["retired"],
  )
})

test("retiredRollupSources never returns an entry on the pinned rollup", () => {
  const sameRollup = entry({ label: "same-rollup", rollupVersion: "7", chainId: "1" })
  const manifest = manifestWith(sameRollup)
  assert.deepEqual(retiredRollupSources(manifest, pinned), [])
})

test("retiredRollupSources skips an entry on another L1 chain", () => {
  const wrongChain = entry({ label: "wrong-chain", rollupVersion: "6", chainId: "2" })
  const manifest = manifestWith(wrongChain)
  assert.deepEqual(retiredRollupSources(manifest, pinned), [])
})

test("retiredRollupSources skips an entry naming another name registry", () => {
  const wrongRegistry = entry({
    label: "wrong-registry",
    rollupVersion: "6",
    chainId: "1",
    nameRegistry: OTHER_REGISTRY,
  })
  const manifest = manifestWith(wrongRegistry)
  assert.deepEqual(retiredRollupSources(manifest, pinned), [])
})

test("retiredRollupSources skips an entry missing accountFactory or namePortal", () => {
  const noFactory = entry({ label: "no-factory", rollupVersion: "6", chainId: "1" })
  delete noFactory.accountFactory
  const noPortal = entry({ label: "no-portal", rollupVersion: "5", chainId: "1" })
  delete noPortal.namePortal
  const manifest = manifestWith(noFactory, noPortal)
  assert.deepEqual(retiredRollupSources(manifest, pinned), [])
})

test("retiredRollupSources skips an entry whose accountFactory or namePortal is the zero address", () => {
  const zeroFactory = entry({
    label: "zero-factory",
    rollupVersion: "6",
    chainId: "1",
    accountFactory: ZERO_L1,
  })
  const zeroPortal = entry({
    label: "zero-portal",
    rollupVersion: "5",
    chainId: "1",
    namePortal: ZERO_L1,
  })
  const manifest = manifestWith(zeroFactory, zeroPortal)
  assert.deepEqual(retiredRollupSources(manifest, pinned), [])
})

test("retiredRollupSources compares the name registry without case", () => {
  const retired = entry({
    label: "retired-upper",
    rollupVersion: "6",
    chainId: "1",
    nameRegistry: REGISTRY.toUpperCase().replace("0X", "0x"),
  })
  const manifest = manifestWith(retired)
  assert.deepEqual(
    retiredRollupSources(manifest, pinned).map((t) => t.version),
    ["retired-upper"],
  )
})

test("retiredRollupSources throws on a malformed known-schema entry instead of dropping it", () => {
  const broken = entry({ label: "broken", rollupVersion: "not-a-number", chainId: "1" })
  const manifest = manifestWith(broken)
  assert.throws(() => retiredRollupSources(manifest, pinned), /rollupVersion/)
})

test("retiredRollupSources ignores a malformed entry outside the pinned lineage", () => {
  // No updatedAt, token or rollupVersion: unparseable, on a chain and registry this pin doesn't use.
  const unrelated = { portal: portalFor("unrelated"), chainId: "999", nameRegistry: OTHER_REGISTRY }
  assert.deepEqual(retiredRollupSources(manifestWith(unrelated), pinned), [])
})

test("isRetiredRollupSource admits another manifest's entry of the pinned lineage only", () => {
  const tuple = (overrides) => parseDeployment(entry({ label: "other", ...overrides })).tuple
  assert.equal(isRetiredRollupSource(tuple({ rollupVersion: "5", chainId: "1" }), pinned), true)
  assert.equal(isRetiredRollupSource(tuple({ rollupVersion: "7", chainId: "1" }), pinned), false)
  assert.equal(isRetiredRollupSource(tuple({ rollupVersion: "5", chainId: "2" }), pinned), false)
  assert.equal(
    isRetiredRollupSource(
      tuple({ rollupVersion: "5", chainId: "1", nameRegistry: OTHER_REGISTRY }),
      pinned,
    ),
    false,
  )
  assert.equal(
    isRetiredRollupSource(
      tuple({ rollupVersion: "5", chainId: "1", accountFactory: ZERO_L1 }),
      pinned,
    ),
    false,
  )
})
