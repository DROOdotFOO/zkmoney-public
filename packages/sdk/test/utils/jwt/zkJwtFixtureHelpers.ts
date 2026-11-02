/**
 * Shared helpers for tests that claim PaylinkEmail via a pre-generated zkJWT
 * proof. Each helper pulls straight from test/fixtures/zkjwt/fixture.json and
 * centralizes the Fr conversions + registry registration so call sites stay
 * short and identical across happy-path-zk / failures.
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import type { BaseAccount } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { poseidon2Hash } from "@zkpassport/poseidon2"
import type { ContractService } from "../../../src/index.js"
import type { ObsidionWalletTest } from "../../../src/obsidion/ObsidionWalletTest.js"
import type { OidcKeyRegistryServer } from "../../../src/services/oidc/OidcKeyRegistryServer.js"

const FIXTURE_PATH = resolve(__dirname, "../../fixtures/zkjwt/fixture.json")

export interface ZkJwtFixture {
  proof: string[]
  public_inputs: string[]
  vk_base64: string
}

/** Fixture's caller (public_inputs[0]). Claims must come from this address. */
export function fixtureCaller(fixture: ZkJwtFixture): string {
  return fixture.public_inputs[0]!
}

export function loadZkJwtFixture(): ZkJwtFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))
}

export function vkBase64ToFields(base64: string): Fr[] {
  const buf = Buffer.from(base64, "base64")
  const fields: Fr[] = []
  for (let i = 0; i < 115; i++) {
    fields.push(Fr.fromBuffer(Buffer.from(buf.subarray(i * 32, (i + 1) * 32))))
  }
  return fields
}

export function vkeyHash(vkey: Fr[]): bigint {
  return poseidon2Hash(vkey.map((f) => f.toBigInt()))
}

export function fixtureVkeyHash(fixture: ZkJwtFixture): bigint {
  return vkeyHash(vkBase64ToFields(fixture.vk_base64))
}

/**
 * Build the zkProof argument that `claimPaylink` expects. Fr-encodes vkey +
 * proof; public_inputs stay as hex strings (what the contract ABI expects).
 */
export function toZkProofClaimInput(fixture: ZkJwtFixture): {
  zkProof: { vkey: Fr[]; proof: Fr[]; public_inputs: string[] }
} {
  return {
    zkProof: {
      vkey: vkBase64ToFields(fixture.vk_base64),
      proof: fixture.proof.map((hex) => Fr.fromHexString(hex)),
      public_inputs: fixture.public_inputs,
    },
  }
}

/**
 * Registers the fixture's issuer-scoped jwk_id (public_inputs[6], public_inputs[5])
 * and aud_hash (public_inputs[3]) against the on-chain OidcKeyRegistry so
 * is_valid_jwk and is_aud_allowed pass during the zkProof claim.
 *
 * `add_aud` is called directly with the poseidon2 hash (not a string) because
 * the fixture already exposes the hash via public_inputs[3] — running it back
 * through `processAud` would re-hash a string that doesn't exist.
 */
export async function registerFixtureRegistryEntries(params: {
  registryServer: OidcKeyRegistryServer
  contractService: ContractService
  wallet: ObsidionWalletTest
  oidcKeyRegistryAddress: AztecAddress
  registryArtifact: ContractArtifact
  deployerAccount: BaseAccount
  fixture: ZkJwtFixture
}): Promise<void> {
  const {
    registryServer,
    contractService,
    wallet,
    oidcKeyRegistryAddress,
    registryArtifact,
    deployerAccount,
    fixture,
  } = params

  await registryServer.setIssuerJwks(fixture.public_inputs[6]!, [BigInt(fixture.public_inputs[5]!)])

  const registry = await contractService.getContractWithArtifactAndAddress(
    oidcKeyRegistryAddress,
    wallet,
    registryArtifact,
  )
  await registry.methods
    .add_aud(BigInt(fixture.public_inputs[3]!))
    .send({ from: deployerAccount.getAddress() })
}
