import assert from "node:assert/strict"
import { test } from "node:test"
import { MAINNET_ENS_DOMAIN, MAINNET_ENTRY_POINT, Network } from "../../dist/constants/index.js"
import { loadOxideManifestTuple } from "../../dist/oxide/index.js"

const MANIFEST_URL = "https://oxide.example/manifest.json"
const GIT_SHA = "c92f24e54e11222d5255e653d673851122cbbf04"
const PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"
const RAW_ENTRY_POINT = "0x00000000000000000000000000000000000000e7"

function manifest(overrides = {}) {
  return {
    schemaVersion: "4",
    deployments: [
      {
        schemaVersion: "1",
        label: "v1",
        gitSha: GIT_SHA,
        deployedAt: "2026-07-13T20:24:20.754Z",
        updatedAt: "2026-07-13T20:24:20.754Z",
        portal: PORTAL,
        token: "0x6440f144b7e50D6a8439336510312d2F54beB01D",
        nameRegistry: "0xee17cff830cd8344d3908c2e07f1a57d9605efb6",
        accountFactory: "0x00000000000000000000000000000000000000a2",
        entryPoint: RAW_ENTRY_POINT,
        ensDomain: "oxidestaging.eth",
        resolverGatewayUrl: "https://resolver.example/{sender}/{data}.json",
        plainWithdrawalExecutor: "0x55021D52991974d60cdee55CB009C1b9d36c515A",
        l2Token: "0x2fbdc2a4303c9855eb39b14091d57cee8575692925ffbac5c7e3e1b1e62a20c8",
        l2Broadcaster: "0x087a42cac485b38d91202fe949fb2933f20185ba7a2fb1de860500379b1350c8",
        enclaveUrl: "https://enclave.example/rpc",
        rollupVersion: "2934756905",
        chainId: "1",
        ...overrides,
      },
    ],
  }
}

function jsonFetch(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
}

test("loadOxideManifestTuple returns the manifest values unchanged off mainnet", async () => {
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.TESTNET,
    fetchImpl: jsonFetch(manifest()),
  })

  assert.equal(tuple.ensDomain, "oxidestaging.eth")
  assert.equal(tuple.entryPoint, RAW_ENTRY_POINT)
})

test("loadOxideManifestTuple reads the deployment's Sky escrow factory", async () => {
  const factory = "0x00000000000000000000000000000000000000f5"
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.TESTNET,
    fetchImpl: jsonFetch(manifest({ skyEscrowFactory: factory })),
  })

  assert.equal(tuple.skyEscrowFactory, factory)
})

test("loadOxideManifestTuple gates and overlays the pinned mainnet entry", async () => {
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.MAINNET,
    expectedGitSha: GIT_SHA,
    fetchImpl: jsonFetch(manifest({ entryPoint: undefined, ensDomain: undefined })),
  })

  assert.equal(tuple.entryPoint, MAINNET_ENTRY_POINT)
  assert.equal(tuple.ensDomain, MAINNET_ENS_DOMAIN)
  assert.equal(tuple.portal, PORTAL)
  assert.equal(Object.isFrozen(tuple), true)
})

test("loadOxideManifestTuple accepts mainnet git SHA drift or an absent SHA", async () => {
  for (const gitSha of [GIT_SHA, undefined]) {
    const tuple = await loadOxideManifestTuple({
      manifestUrl: MANIFEST_URL,
      portal: PORTAL,
      network: Network.MAINNET,
      expectedGitSha: "0".repeat(40),
      fetchImpl: jsonFetch(manifest({ gitSha })),
    })

    assert.equal(tuple.gitSha, gitSha ?? "")
    assert.equal(tuple.portal, PORTAL)
  }
})

test("loadOxideManifestTuple reports the URL and status for an HTTP failure", async () => {
  await assert.rejects(
    loadOxideManifestTuple({
      manifestUrl: MANIFEST_URL,
      portal: PORTAL,
      network: Network.TESTNET,
      fetchImpl: jsonFetch({}, 503),
    }),
    /HTTP 503 \(https:\/\/oxide\.example\/manifest\.json\)/,
  )
})

/** A schema v5 app deployment: the shared fields once, each bridge's own under `bridges`. */
function manifestV5(bridges) {
  const { deployments } = manifest({ forwardingTable: FORWARDING_TABLE, feeToken: DAI })
  const shared = Object.fromEntries(
    Object.entries(deployments[0]).filter(([key]) => !["portal", "token", "l2Token"].includes(key)),
  )
  return { schemaVersion: "5", deployments: [{ ...shared, bridges }] }
}

const FORWARDING_TABLE = "0x00000000000000000000000000000000000000fb"
const DAI = "0x6440f144b7e50D6a8439336510312d2F54beB01D"
const SUSDS_PORTAL = "0x00000000000000000000000000000000000005d5"

test("loadOxideManifestTuple reads a schema v5 bridge with its deployment's fields", async () => {
  const fetchImpl = jsonFetch(
    manifestV5([
      {
        key: "dai",
        portal: PORTAL,
        token: DAI,
        l2Token: "0x2fbdc2a4303c9855eb39b14091d57cee8575692925ffbac5c7e3e1b1e62a20c8",
      },
      {
        key: "susds",
        portal: SUSDS_PORTAL,
        token: "0x00000000000000000000000000000000000005d0",
        l2Token: "0x00000000000000000000000000000000000000000000000000000000000005d1",
      },
    ]),
  )
  const tuple = await loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal: PORTAL,
    network: Network.TESTNET,
    fetchImpl,
  })

  assert.equal(tuple.portal, PORTAL)
  assert.equal(tuple.token, DAI)
  assert.equal(tuple.forwardingTable, FORWARDING_TABLE)
  assert.equal(tuple.feeToken, DAI)
  assert.equal(tuple.version, "v1")
})

test("loadOxideManifestTuple rejects a schema v5 deployment without bridges", async () => {
  await assert.rejects(
    loadOxideManifestTuple({
      manifestUrl: MANIFEST_URL,
      portal: PORTAL,
      network: Network.TESTNET,
      fetchImpl: jsonFetch(manifestV5([])),
    }),
    /lists no bridges/,
  )
})

const SWAP_FACTORY = "0x00000000000000000000000000000000000005f1"

/** A schema v5 deployment with a DAI and an sUSDS bridge and the given features. */
function manifestV5WithFeatures(features, daiBridge = {}) {
  const manifest = manifestV5([
    {
      key: "dai",
      bridgeId: "brg-dai-v6",
      portal: PORTAL,
      token: DAI,
      l2Token: "0x2fbdc2a4303c9855eb39b14091d57cee8575692925ffbac5c7e3e1b1e62a20c8",
      ...daiBridge,
    },
    {
      key: "susds",
      bridgeId: "brg-susds-v6",
      portal: SUSDS_PORTAL,
      token: "0x00000000000000000000000000000000000005d0",
      l2Token: "0x00000000000000000000000000000000000000000000000000000000000005d1",
    },
  ])
  manifest.deployments[0].features = features
  return manifest
}

function swapFeature(bridge, factory = SWAP_FACTORY) {
  return {
    project: "swap",
    bridges: { dai: bridge },
    contracts: { swapEscrowFactory: factory },
    variables: {},
  }
}

async function tupleFor(manifest, portal = PORTAL) {
  return loadOxideManifestTuple({
    manifestUrl: MANIFEST_URL,
    portal,
    network: Network.TESTNET,
    fetchImpl: jsonFetch(manifest),
  })
}

test("loadOxideManifestTuple reads the swap escrow factory of the swap feature that binds the bridge", async () => {
  const manifest = manifestV5WithFeatures({ "fea-swap-v6": swapFeature("brg-dai-v6") })

  assert.equal((await tupleFor(manifest)).swapEscrowFactoryV2, SWAP_FACTORY)
  assert.equal((await tupleFor(manifest, SUSDS_PORTAL)).swapEscrowFactoryV2, undefined)
})

test("loadOxideManifestTuple keeps the swap escrow factory that a bridge names itself", async () => {
  const own = "0x00000000000000000000000000000000000005f2"
  const manifest = manifestV5WithFeatures({}, { swapEscrowFactoryV2: own })

  assert.equal((await tupleFor(manifest)).swapEscrowFactoryV2, own)
})

test("loadOxideManifestTuple rejects two swap features for one bridge", async () => {
  const manifest = manifestV5WithFeatures({
    "fea-swap-a": swapFeature("brg-dai-v6"),
    "fea-swap-b": swapFeature("brg-dai-v6", "0x00000000000000000000000000000000000005f3"),
  })

  await assert.rejects(tupleFor(manifest), /more than one swap feature \(fea-swap-a, fea-swap-b\)/)
})
