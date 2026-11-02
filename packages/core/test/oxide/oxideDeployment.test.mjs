import assert from "node:assert/strict"
import { test } from "node:test"
import { Network } from "../../dist/constants/index.js"
import {
  OxideManifestValidationError,
  loadOxideManifestTuple,
  bridgeByPortal,
  bridgeByToken,
  extractPinnedOxideEnvTuple,
  feeTokenBridge,
  feeTokenRow,
  featureBridge,
  loadOxideDeployment,
  oxideManifestDeployments,
  pinnedEntryPolicy,
  pinnedOxideDeployment,
  rowSweepFee,
  sipaIntentBridge,
  sipaIntentRow,
  tableRowByPortal,
} from "../../dist/oxide/index.js"

const GIT_SHA = "c92f24e54e11222d5255e653d673851122cbbf04"
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F"
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
const DAI_PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"
const USDC_PORTAL = "0x2E6142c98D83c8D14b09668d90583E940A646458"
const TABLE = "0x00000000000000000000000000000000000000fb"
const l2 = (byte) => `0x${byte.repeat(32)}`

const shared = {
  label: "v6.0.0",
  gitSha: GIT_SHA,
  deployedAt: "2026-10-13T20:24:20.754Z",
  updatedAt: "2026-10-14T20:24:20.754Z",
  chainId: "1",
  rollupVersion: "2934756905",
  enclaveUrl: "https://enclave.example/rpc",
  nameRegistry: "0xee17cff830cd8344d3908c2e07f1a57d9605efb6",
  resolverGatewayUrl: "https://resolver.example/{sender}/{data}.json",
  l2Broadcaster: l2("08"),
  forwardingTable: TABLE,
  feeToken: DAI,
}

const bridge = (key, token, portal, byte) => ({
  key,
  bridgeId: `brg-${key}-v6`,
  token,
  underlying: token,
  portal,
  l2Token: l2(byte),
  plainWithdrawalExecutor: `0x${byte.repeat(20)}`,
  depositSubsidy: `0x${byte.repeat(19)}d1`,
})

const twoBridges = () => ({
  schemaVersion: "5",
  deployments: [
    {
      ...shared,
      bridges: [bridge("dai", DAI, DAI_PORTAL, "a1"), bridge("usdc", USDC, USDC_PORTAL, "b2")],
    },
  ],
})

const oneBridge = () => ({
  schemaVersion: "5",
  deployments: [{ ...shared, bridges: [bridge("dai", DAI, DAI_PORTAL, "a1")] }],
})

const row = (bridge, intents) => ({ bridge, intents, txAmountCap: 1000n })

test("the pinned deployment lists every bridge of a two-bridge schema 5 manifest", () => {
  const { deployment, pinned } = pinnedOxideDeployment(twoBridges(), { portal: USDC_PORTAL })

  assert.equal(deployment.label, "v6.0.0")
  assert.equal(deployment.forwardingTable, TABLE)
  assert.deepEqual(
    deployment.bridges.map((b) => [b.key, b.underlying, b.portal]),
    [
      ["dai", DAI, DAI_PORTAL],
      ["usdc", USDC, USDC_PORTAL],
    ],
  )
  assert.equal(pinned.portal, USDC_PORTAL)
  assert.equal(pinned.tuple.depositSubsidy, `0x${"b2".repeat(19)}d1`)
})

test("bridges are found by token, by portal, and as the fee token's", () => {
  const { deployment } = pinnedOxideDeployment(twoBridges(), { portal: DAI_PORTAL })

  assert.equal(bridgeByToken(deployment, USDC.toLowerCase())?.portal, USDC_PORTAL)
  assert.equal(bridgeByPortal(deployment, USDC_PORTAL.toLowerCase())?.key, "usdc")
  assert.equal(feeTokenBridge(deployment)?.key, "dai")
  assert.equal(bridgeByToken(deployment, `0x${"00".repeat(19)}01`), undefined)
})

test("a deposit settles on its token's bridge; a registration or metadata update on the fee token's", () => {
  const { deployment } = pinnedOxideDeployment(twoBridges(), { portal: DAI_PORTAL })

  assert.equal(sipaIntentBridge(deployment, "deposit", USDC)?.key, "usdc")
  assert.equal(sipaIntentBridge(deployment, "registration", USDC)?.key, "dai")
  assert.equal(sipaIntentBridge(deployment, "metadata", USDC)?.key, "dai")
})

test("a one-bridge manifest is a deployment of one row", () => {
  const { deployment, pinned } = pinnedOxideDeployment(oneBridge(), { portal: DAI_PORTAL })

  assert.equal(deployment.bridges.length, 1)
  assert.equal(pinned, deployment.bridges[0])
  assert.equal(feeTokenBridge(deployment), pinned)
  assert.equal(sipaIntentBridge(deployment, "deposit", USDC), undefined)
})

test("a schema 4 entry is a deployment of one bridge whose underlying is its token", () => {
  const manifest = {
    schemaVersion: "4",
    deployments: [{ ...shared, token: DAI, portal: DAI_PORTAL, l2Token: l2("a1") }],
  }
  const { deployment, pinned } = pinnedOxideDeployment(manifest, { portal: DAI_PORTAL })

  assert.equal(deployment.bridges.length, 1)
  assert.equal(pinned.underlying, DAI)
  assert.equal(pinned.key, undefined)
})

test("a Sky bridge keeps its own underlying beside the environment token", () => {
  const sUsds = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"
  const manifest = twoBridges()
  manifest.deployments[0].bridges[1] = {
    ...bridge("susds", DAI, USDC_PORTAL, "b2"),
    underlying: sUsds,
  }
  const { deployment } = pinnedOxideDeployment(manifest, { portal: DAI_PORTAL })
  const sky = bridgeByPortal(deployment, USDC_PORTAL)

  assert.equal(sky.token, DAI)
  assert.equal(sky.underlying, sUsds)
  assert.equal(sky.tuple.underlying, sUsds)
  assert.equal(bridgeByToken(deployment, DAI)?.key, "dai")
})

test("the per-portal tuple reads its bridge's underlying and row key", () => {
  const { tuple } = extractPinnedOxideEnvTuple(twoBridges(), { portal: USDC_PORTAL })

  assert.equal(tuple.underlying, USDC)
  assert.equal(tuple.bridgeKey, "usdc")
})

test("an unknown pin names every available portal", () => {
  assert.throws(
    () => pinnedOxideDeployment(twoBridges(), { portal: `0x${"11".repeat(20)}` }),
    (err) =>
      err instanceof OxideManifestValidationError &&
      err.message.includes(DAI_PORTAL) &&
      err.message.includes(USDC_PORTAL),
  )
})

test("the mainnet gate rejects a fee token without a bridge", () => {
  const manifest = oneBridge()
  manifest.deployments[0].feeToken = USDC
  const policy = pinnedEntryPolicy({ network: Network.MAINNET, expectedGitSha: GIT_SHA })

  assert.throws(
    () => pinnedOxideDeployment(manifest, { portal: DAI_PORTAL }, policy),
    /no bridge for its fee token/,
  )
})

test("the mainnet gate rejects two bridges for one token", () => {
  const manifest = twoBridges()
  manifest.deployments[0].bridges[1] = bridge("dai2", DAI, USDC_PORTAL, "b2")
  const policy = pinnedEntryPolicy({ network: Network.MAINNET, expectedGitSha: GIT_SHA })

  assert.throws(
    () => pinnedOxideDeployment(manifest, { portal: DAI_PORTAL }, policy),
    /two bridges for token/,
  )
})

test("loadOxideDeployment overlays the mainnet constants on every bridge", async () => {
  const { deployment, pinned } = await loadOxideDeployment({
    manifestUrl: "https://oxide.example/manifest.json",
    portal: USDC_PORTAL,
    network: Network.MAINNET,
    expectedGitSha: GIT_SHA,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => twoBridges() }),
  })

  assert.equal(pinned.portal, USDC_PORTAL)
  assert.ok(deployment.bridges.every((b) => b.tuple.ensDomain && b.tuple.entryPoint))
  assert.ok(deployment.bridges.includes(pinned))
})

test("table rows answer by portal, by fee token and by intent", () => {
  const { deployment } = pinnedOxideDeployment(twoBridges(), { portal: DAI_PORTAL })
  const [dai, usdc] = deployment.bridges
  const terms = { sweepTip: 3n, beneficiaryFee: 2n }
  const table = {
    deployment,
    rows: [row(dai, { deposit: terms, registration: terms }), row(usdc, { deposit: terms })],
  }

  assert.equal(tableRowByPortal(table, USDC_PORTAL)?.bridge, usdc)
  assert.equal(feeTokenRow(table)?.bridge, dai)
  assert.equal(sipaIntentRow(table, "registration", USDC)?.bridge, dai)
  assert.equal(sipaIntentRow(table, "metadata", USDC), undefined)
  assert.equal(rowSweepFee(table.rows[1], "deposit"), 5n)
  assert.equal(rowSweepFee(table.rows[1], "registration"), undefined)
})

test("the mainnet tuple read gates the pinned bridge's siblings too", async () => {
  const manifest = twoBridges()
  delete manifest.deployments[0].bridges[1].plainWithdrawalExecutor

  await assert.rejects(
    loadOxideManifestTuple({
      manifestUrl: "https://oxide.example/manifest.json",
      portal: DAI_PORTAL,
      network: Network.MAINNET,
      expectedGitSha: GIT_SHA,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => manifest }),
    }),
    /plainWithdrawalExecutor/,
  )
})

const FACTORY = "0x00000000000000000000000000000000000000fa"
const EXECUTOR = "0x00000000000000000000000000000000000000fe"

const withFeature = (bridges = { usdc: "brg-usdc-v6", dai: "brg-dai-v6" }) => {
  const manifest = twoBridges()
  manifest.deployments[0].features = {
    "fea-swap-v6": {
      project: "swap",
      bridges,
      contracts: { escrowFactory: FACTORY, withdrawalExecutor: EXECUTOR },
    },
  }
  return manifest
}

test("a deployment lists its features and each feature's bridges by role", () => {
  const { deployment } = pinnedOxideDeployment(withFeature(), { portal: DAI_PORTAL })
  const [feature] = deployment.features

  assert.equal(feature.id, "fea-swap-v6")
  assert.equal(feature.project, "swap")
  assert.deepEqual(feature.contracts, { escrowFactory: FACTORY, withdrawalExecutor: EXECUTOR })
  assert.equal(featureBridge(deployment, feature, "usdc")?.portal, USDC_PORTAL)
  assert.equal(featureBridge(deployment, feature, "dai")?.id, "brg-dai-v6")
  assert.equal(featureBridge(deployment, feature, "eur"), undefined)
})

test("a feature keeps its variables, and an older feature without them lists none", () => {
  const manifest = withFeature()
  const SOURCE = "0x00000000000000000000000000000000000000ab"
  manifest.deployments[0].features["fea-migration-v6"] = {
    project: "migration",
    bridges: { destination: "brg-dai-v6" },
    contracts: { migrationExecutor: EXECUTOR, migrationExecutorSubsidy: FACTORY },
    variables: {
      sourcePortal: SOURCE,
      payoutToken: DAI,
      gasCeiling: 300000,
      enabled: true,
      bad: { x: 1 },
    },
  }

  const { deployment } = pinnedOxideDeployment(manifest, { portal: DAI_PORTAL })
  const byId = Object.fromEntries(deployment.features.map((f) => [f.id, f]))

  assert.deepEqual(byId["fea-swap-v6"].variables, {})
  assert.deepEqual(byId["fea-migration-v6"].variables, {
    sourcePortal: SOURCE,
    payoutToken: DAI,
    gasCeiling: 300000,
    enabled: true,
  })
  assert.ok(Object.isFrozen(byId["fea-migration-v6"].variables))
})

test("a feature whose variables are not a record is left out", () => {
  const manifest = withFeature()
  manifest.deployments[0].features["fea-bad-v6"] = {
    project: "migration",
    bridges: { destination: "brg-dai-v6" },
    contracts: {},
    variables: ["0xab"],
  }

  const { deployment } = pinnedOxideDeployment(manifest, { portal: DAI_PORTAL })

  assert.deepEqual(
    deployment.features.map((f) => f.id),
    ["fea-swap-v6"],
  )
})

test("a malformed feature is left out, and the deployment still loads", () => {
  const manifest = withFeature()
  manifest.deployments[0].features["fea-bad-v6"] = {
    project: "bad",
    bridges: ["brg-usdc-v6"],
    contracts: {},
  }

  const { deployment } = pinnedOxideDeployment(manifest, { portal: DAI_PORTAL })

  assert.deepEqual(
    deployment.features.map((f) => f.id),
    ["fea-swap-v6"],
  )
})

test("the mainnet gate holds no feature against its deployment; a feature's use checks it", () => {
  const policy = pinnedEntryPolicy({ network: Network.MAINNET, expectedGitSha: GIT_SHA })
  const manifest = withFeature({ usdc: "brg-usdc-v5" })
  manifest.deployments[0].features["fea-swap-v6"].contracts.escrowFactory = `0x${"0".repeat(40)}`

  const { deployment } = pinnedOxideDeployment(manifest, { portal: DAI_PORTAL }, policy)

  assert.equal(featureBridge(deployment, deployment.features[0], "usdc"), undefined)
})

test("loadOxideDeployment keeps the features through the mainnet overlay", async () => {
  const { deployment } = await loadOxideDeployment({
    manifestUrl: "https://oxide.example/manifest.json",
    portal: USDC_PORTAL,
    network: Network.MAINNET,
    expectedGitSha: GIT_SHA,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => withFeature() }),
  })

  assert.equal(featureBridge(deployment, deployment.features[0], "usdc")?.portal, USDC_PORTAL)
})

test("loadOxideDeployment revalidates with the host only when asked", async () => {
  const inits = []
  const fetchImpl = async (_url, init) => {
    inits.push(init)
    return { ok: true, status: 200, json: async () => withFeature() }
  }
  const opts = {
    manifestUrl: "https://oxide.example/manifest.json",
    portal: USDC_PORTAL,
    network: Network.MAINNET,
    expectedGitSha: GIT_SHA,
    fetchImpl,
  }
  await loadOxideDeployment(opts)
  await loadOxideDeployment({ ...opts, cache: "no-cache" })

  assert.deepEqual(inits, [undefined, { cache: "no-cache" }])
})

test("the manifest's deployments skip one with a malformed entry", () => {
  const manifest = withFeature()
  manifest.deployments.push({
    ...shared,
    label: "v6.0.1",
    bridges: [{ ...bridge("eur", USDC, `0x${"3e".repeat(20)}`, "c3"), l2Token: "0x1" }],
  })
  manifest.deployments.push({
    ...shared,
    label: "v6.0.2",
    bridges: [bridge("eur", USDC, `0x${"4e".repeat(20)}`, "d4")],
  })

  assert.deepEqual(
    oxideManifestDeployments(manifest).map((d) => [d.label, d.features?.length ?? 0]),
    [
      ["v6.0.0", 1],
      ["v6.0.2", 0],
    ],
  )
})

test("the manifest's deployments reject a manifest whose deployment lists no bridges", () => {
  const manifest = withFeature()
  manifest.deployments.push({ ...shared, label: "v6.0.1", bridges: [] })

  assert.throws(() => oxideManifestDeployments(manifest), OxideManifestValidationError)
  assert.throws(
    () => pinnedOxideDeployment(manifest, { portal: USDC_PORTAL }),
    OxideManifestValidationError,
  )
})

test("the manifest's deployments skip one that fails the mainnet gate when asked to hold them to it", () => {
  const manifest = withFeature()
  manifest.deployments.push({
    ...shared,
    label: "v6.0.1",
    bridges: [
      { ...bridge("eur", USDC, `0x${"3e".repeat(20)}`, "c3"), plainWithdrawalExecutor: undefined },
    ],
  })
  const gate = { requireProdSchema: true }

  assert.deepEqual(
    oxideManifestDeployments(manifest).map((d) => d.label),
    ["v6.0.0", "v6.0.1"],
  )
  assert.deepEqual(
    oxideManifestDeployments(manifest, gate).map((d) => d.label),
    ["v6.0.0"],
  )
})
