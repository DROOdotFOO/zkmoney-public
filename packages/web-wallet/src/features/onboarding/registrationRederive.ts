/**
 * Finds this wallet's registration addresses from its keys alone, for a device with no
 * registration record. An address commits to its fee and salt, and both have moved since addresses
 * were handed out, so every fee the account service has signed is tried under the self-SIPA key's
 * salt and under the resolver salt addresses used before it.
 */
import type { Address, Hex } from "viem"
import { REGISTRATION_SIGNED_FEES } from "@obsidion/core/constants"
import {
  composeWireNameHash,
  deriveBootstrapKey,
  deriveRegistrationAddress,
  legacyRegistrationSalt,
  type After,
  type Milestones,
} from "@obsidion/front-core"
import { readSipaBalancesMany, readSipaDeployedMany } from "@obsidion/sdk"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { WebWalletConfig } from "../../config/env"
import { l1MulticallClient, oxideEnvFor } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { walletStorage } from "../../platform/storage/walletStorage"
import { sipaFundingTokens } from "../deposit/loadDepositFacts"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { registrationAddressDeps } from "./oxideOnboarding"

export type RegistrationAddress = Awaited<ReturnType<typeof deriveRegistrationAddress>>

type Deps = Awaited<ReturnType<typeof registrationAddressDeps>>

export interface RederiveOptions {
  /** The candidates to seed out of every fee and salt derived at once. */
  keep: (candidates: RegistrationAddress[]) => Promise<RegistrationAddress[]>
  /** A fee to try, both salts, when `keep` picks none of the known ones. */
  quotedFee?: (deps: Deps, owner: Address, nameHash: Hex) => Promise<bigint | undefined>
}

/** Seeds the registration addresses `keep` picks for `handle`; returns how many. */
export async function seedRederivedRegistrations(
  config: WebWalletConfig,
  networkId: string,
  secret: Fr,
  handle: string,
  l2Address: Hex,
  opts: RederiveOptions,
): Promise<number> {
  // Every candidate's address is one predictSIPA read; the multicall client sends them as one.
  const deps = await registrationAddressDeps(
    handle,
    secret,
    l2Address,
    config,
    networkId,
    l1MulticallClient(config),
  )
  const [owner, scheduleFee, { resolver }] = await Promise.all([
    deps.l1.predictAccountAddress(deps.env.factory, deriveBootstrapKey(secret).address as Address),
    deps.scheduleFee(),
    oxideEnvFor(config),
  ])
  const nameHash = composeWireNameHash(handle, deps.env.ensDomain)
  const salts = [undefined, legacyRegistrationSalt(secret, resolver.resolverPublicKey, nameHash)]
  const seedKept = async (fees: readonly bigint[]) => {
    const derived = await Promise.all(
      salts.flatMap((salt) =>
        fees.map((fee) => deriveRegistrationAddress(deps, owner, nameHash, fee, salt)),
      ),
    )
    const kept = await opts.keep(derived)
    for (const found of kept) await deps.seedSipaDeposit(found.seed)
    return kept.length
  }
  const fees = [...new Set([scheduleFee, ...REGISTRATION_SIGNED_FEES])]
  const seeded = await seedKept(fees)
  if (seeded > 0 || !opts.quotedFee) return seeded
  const quoted = await opts.quotedFee(deps, owner, nameHash)
  return quoted === undefined || fees.includes(quoted) ? 0 : seedKept([quoted])
}

const DISCOVERED_KEY = "webwallet.registration.rederived"
/** A fresh device's search for registration addresses it has no record of waits for the settled balance. */
const DISCOVERY_AFTER: After = { firstBalance: true, depositsReplayed: true, movesReplayed: true }

/** This page load's run per wallet and name: Home remounts share it, and a failed one waits for a reload. */
const runs = new Map<string, Promise<number>>()

/**
 * Seeds every registration address of this wallet and name that holds funds or was swept, so the
 * deposit sync and recovery track it. A broadcast note covers an address that was published; this
 * covers one that never was. No claim is asked for: that would reserve the name. Runs after the
 * boot's deposit replay, once per page load until it finds an address: one handed out but not yet
 * paid is found when the payment lands.
 */
export async function discoverRegistrationDeposits(
  config: WebWalletConfig,
  networkId: string,
  milestones: Pick<Milestones, "after">,
): Promise<number> {
  const identity = loadWalletIdentity()
  const secret = await getAuthService()?.getSecretKey?.()
  if (!identity?.handle || !secret) return 0
  const key = `${DISCOVERED_KEY}.${identity.address.toLowerCase()}.${identity.handle}`
  if (walletStorage.getItem(key)) return 0
  let run = runs.get(key)
  if (!run) {
    run = discover(
      config,
      networkId,
      milestones,
      secret,
      identity.handle,
      identity.address as Hex,
      key,
    )
    runs.set(key, run)
  }
  return run
}

async function discover(
  config: WebWalletConfig,
  networkId: string,
  milestones: Pick<Milestones, "after">,
  secret: Fr,
  handle: string,
  l2Address: Hex,
  key: string,
): Promise<number> {
  if (!(await milestones.after(DISCOVERY_AFTER))) return 0
  const { env, publicClient } = await oxideEnvFor(config)
  const tokens = (await sipaFundingTokens(config, env.feeToken as Address, "registration")).map(
    (t) => t.address,
  )
  // The seeder leaves an address already tracked as it is, so every candidate is checked.
  const seeded = await seedRederivedRegistrations(config, networkId, secret, handle, l2Address, {
    keep: async (found) => {
      const sipas = found.map((f) => f.derivation.sipaAddress)
      const [balances, deployed] = await Promise.all([
        readSipaBalancesMany(publicClient, sipas, tokens),
        readSipaDeployedMany(publicClient, sipas),
      ])
      return found.filter((f) => {
        const sipa = f.derivation.sipaAddress.toLowerCase()
        const held = balances.get(sipa)
        // A failed read is missing from the map; it must not pass for an empty address.
        if (tokens.some((t) => held?.get(t.toLowerCase()) === undefined)) {
          throw new Error(`couldn't read the balance of ${f.derivation.sipaAddress}`)
        }
        // A swept address holds nothing, but its bridged funds wait for a claim only its seed can make.
        return deployed.has(sipa) || tokens.some((t) => held!.get(t.toLowerCase())! > 0n)
      })
    },
  })
  if (seeded > 0) {
    console.info(`[registrationRederive] found ${seeded} registration deposit(s)`)
    walletStorage.setItem(key, "1")
  }
  return seeded
}
