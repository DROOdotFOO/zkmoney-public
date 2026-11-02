import { expect, it } from "vitest"
import { pinnedOxideDeployment } from "@obsidion/core/oxide"
import { migrationFeatureFor } from "../../../src/oxide/portal/migrationFeature.js"

const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`
const SOURCE = addr("51")
const DAI = addr("da")
const PORTAL = "0x1E6142c98D83c8D14b09668d90583E940A646458"

const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"
const l2 = (byte: string) => `0x${byte.repeat(32)}`

function manifest(features: Record<string, unknown>) {
  return {
    schemaVersion: "5",
    deployments: [
      {
        label: "v6.0.0",
        gitSha: "c92f24e54e11222d5255e653d673851122cbbf04",
        deployedAt: "2026-10-13T20:24:20.754Z",
        updatedAt: "2026-10-14T20:24:20.754Z",
        chainId: "1",
        rollupVersion: "2934756905",
        enclaveUrl: "https://enclave.example/rpc",
        nameRegistry: "0xee17cff830cd8344d3908c2e07f1a57d9605efb6",
        resolverGatewayUrl: "https://resolver.example/{sender}/{data}.json",
        l2Broadcaster: l2("08"),
        bridges: [
          {
            key: "susds",
            bridgeId: "brg-susds-v6",
            token: SUSDS,
            underlying: SUSDS,
            portal: PORTAL,
            l2Token: l2("a1"),
            plainWithdrawalExecutor: addr("a1"),
            depositSubsidy: `0x${"a1".repeat(19)}d1`,
          },
        ],
        features,
      },
    ],
  }
}

const feature = (sourcePortal: string) => ({
  project: "migration",
  bridges: { destination: "brg-susds-v6" },
  contracts: { migrationExecutor: addr("e1"), migrationExecutorSubsidy: addr("5b") },
  variables: { sourcePortal, payoutToken: DAI, operationExecutorCodeHash: `0x${"ab".repeat(32)}` },
})

it("finds the migration feature that serves the source portal, ignoring case", () => {
  const deployment = {
    features: [
      { id: "fea-sky-v6", project: "sky", bridges: {}, contracts: {}, variables: {} },
      { id: "fea-migration-susds", ...feature(SOURCE.toUpperCase().replace("0X", "0x")) },
    ],
  }
  expect(migrationFeatureFor(deployment, SOURCE)).toEqual({
    id: "fea-migration-susds",
    executor: addr("e1"),
    subsidy: addr("5b"),
    payoutToken: DAI,
    destinationBridge: "brg-susds-v6",
  })
})

it("finds none for another portal, or on a deployment without features", () => {
  expect(
    migrationFeatureFor({ features: [{ id: "m", ...feature(addr("99")) }] }, SOURCE),
  ).toBeUndefined()
  expect(migrationFeatureFor({}, SOURCE)).toBeUndefined()
})

it("refuses two features for one portal, and a feature without its payout token", () => {
  expect(() =>
    migrationFeatureFor(
      {
        features: [
          { id: "a", ...feature(SOURCE) },
          { id: "b", ...feature(SOURCE) },
        ],
      },
      SOURCE,
    ),
  ).toThrow("More than one migration feature")
  const broken = { id: "m", ...feature(SOURCE), variables: { sourcePortal: SOURCE } }
  expect(() => migrationFeatureFor({ features: [broken] }, SOURCE)).toThrow("variables.payoutToken")
})

it("reads a feature as the manifest parser keeps it", () => {
  const { deployment } = pinnedOxideDeployment(
    manifest({ "fea-migration-susds": feature(SOURCE) }),
    {
      portal: PORTAL,
    },
  )
  expect(migrationFeatureFor(deployment, SOURCE)).toMatchObject({
    id: "fea-migration-susds",
    payoutToken: DAI,
    destinationBridge: "brg-susds-v6",
  })
  expect(deployment.bridges.find((b) => b.id === "brg-susds-v6")?.portal).toBe(PORTAL)
})
