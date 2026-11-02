# web-wallet

The zk.money browser wallet: React + Vite, a full PXE in the browser over OPFS-sqlite, and passkey-PRF accounts.

## Run it locally

```shell
cp .env.mainnet.example .env.local   # fill VITE_NODE_URL, VITE_NODE_API_KEY and VITE_L1_RPC_URL
pnpm dev
pnpm test                            # unit tests; no sandbox and no network
```

The root [README](../../README.md) gives the full build from a clean checkout.

## Pointing it at another network

Every network-dependent value resolves once in `src/config/env.ts` — `resolveBootConfig()` runs
before React mounts and seeds the memoized `getConfig()` every consumer reads — so switching targets
is env-only. `VITE_NETWORK` picks the L1 chain id, `VITE_CONFIG_PROFILE_URL` names the config
profile that supplies the endpoints and contract addresses, and everything else overrides a
default.

| Var                                                          | Default                              | Notes                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_NETWORK`                                               | `sandbox`                            | `sandbox` \| `testnet` \| `mainnet`; unknown values throw                                                                                                                                                                          |
| `VITE_NODE_URL`                                              | `http://localhost:8080`              | Aztec node                                                                                                                                                                                                                         |
| `VITE_NODE_API_KEY`                                          | unset                                | `x-api-key` for a gateway-fronted node; unset targets an open node                                                                                                                                                                 |
| `VITE_L1_RPC_URL`                                            | `http://localhost:8545`              | Sepolia RPC for testnet                                                                                                                                                                                                            |
| `VITE_ACCOUNT_SERVICE_URL`                                   | ignored by profile boot              | The selected profile owns this URL; local SIP ports 5060/5061 use the `/svc/account` proxy                                                                                                                                          |
| `VITE_ACCOUNT_SERVICE_TEST_MODE`                             | `true` on sandbox, `false` elsewhere | fails closed: only sandbox defaults to the synthetic keyId a test-mode service accepts; explicit `true` is refused on mainnet                                                                                                      |
| `VITE_ENCLAVE_URL`                                           | manifest's `enclaveUrl`              | sandbox defaults to the `/svc/enclave` proxy (its mock TEE is CORS-free); set it explicitly for any other tier whose enclave serves no CORS                                                                                         |
| `VITE_PROVER_ENABLED`                                        | `true`                               | `false` only where the sequencer accepts unproven txs                                                                                                                                                                              |
| `VITE_PROVE_TX_PERF_LOGS`                                    | `false`                              | `true` prints each transaction's `[Perf][ProveTx]` console line (request build, simulation, app and kernel witness, proof and total times); the e2e build turns it on                                                              |
| `VITE_PREDICATE_API_KEY` / `_VERIFICATION_HASH` / `_CHAIN`   | unset (screening off)                | Predicate L1 address screening — all three or none (a partial set throws); must match the policy oxide's relayer enforces                                                                                                          |
| `VITE_PREDICATE_BASE_URL`                                    | `/svc/predicate`                     | Predicate sends no CORS headers, so the default is the same-origin proxy: vite's (dev/preview, target via `PREDICATE_TARGET`, default their production tier — it serves every chain and is where our keys are issued) or the `vercel.json` rewrite (deployed) |
| `VITE_CONFIG_PROFILE_URL`                                    | unset (the build does not boot)      | the config profile to boot from — it serves the node, L1 RPC, account-service, XMTP and oxide values plus the contract snapshot; node and L1 RPC build overrides still win where set                                                |
| `VITE_CONFIG_EXPECTED_PROFILE_ID`                            | unset                                | the `profileId` the fetched document must carry. Required whenever the URL is set (a URL that vouches for itself checks nothing); inert on its own                                                                                                  |

### Booting from a config profile

The profile pair is required — a build without it throws at boot. Set it in `.env.local` or the shell. Mainnet uses:

```shell
VITE_CONFIG_PROFILE_URL=https://cdn.zk.money/profiles/v5/current.json
VITE_CONFIG_EXPECTED_PROFILE_ID=prod-v5
```

`pnpm build` also fetches that document and bakes it into the bundle (`bakedConfigProfile.ts`),
after running the checks the app runs at boot; a build with the URL set fails if the document
cannot be fetched or would be refused. `pnpm dev` bakes nothing. At boot the app fetches the live
document as always and uses the baked copy only when the config service cannot be reached —
network failure, timeout, or a 5xx — showing a notice that the configuration may be outdated. A
profile the server *answers* with but the app cannot accept — a 404, an expired document, one
naming another network, or one identifying as something else — is still a boot error with a
retry, never a boot on values nobody chose.

### X sign-in

Without test mode, onboarding gates account-service on an X session instead of the App Attest a
browser cannot produce. It needs an account-service that mints them — set
`ENABLED_SERVICES=…,xauth`, `OXIDE_ACCOUNT_ACCEPTED_CREDENTIALS=app-attest,x-session`, the
`OXIDE_ACCOUNT_X_CLIENT_{ID,SECRET}` pair and `OXIDE_ACCOUNT_X_REDIRECT_URI` there.

That redirect URI must be this app's `/auth/x/callback`, registered byte-identically on the X app,
or the code exchange is refused. The service sends its own configured value, so it is single-valued
in both directions: exactly one origin can complete sign-in, and registering more callbacks on the X
app does not change which. `GET /xauth/info` reports the one in force.

Sign-in happens once, in a popup, and the session is dropped when onboarding finishes — nothing is
persisted, so the wallet never carries a live link to a social account. Allow popups on the origin.

Testnet additionally needs ClaimFPC deployed and recorded under `claimFpc` in the registry —
sponsored onboarding and the paylink rail both fail closed without it.

## Phone UI captures

Run `pnpm ui:capture --plan scripts/ui-capture/plans/phone.json --preset all` for isolated demo captures at 390×844, 402×879, and 390×667. Add `--record` for matching-size WebM recordings. The command owns its local config and server; generated output stays outside the repository. See [the capture guide](scripts/ui-capture/README.md) for setup, route/interaction plans, safe-area conventions, and the separate real-device verification requirements.

## Demo mode

`pnpm dev` then open `http://localhost:5173/?demo=recovery`. The wallet comes up populated — no
sandbox, no chain, no passkey, no config service — so the UI can be walked through and screenshotted
anywhere. Demo mode boots from the in-process profile in `src/dev/demoProfile.ts` on sandbox,
whatever pair the shell holds; only the UI-capture harness supplies its own profile.
Dev-only: `import.meta.env.DEV` is a build-time literal, so a production build drops every branch
and the whole `src/dev/` chunk with them (`pnpm build && grep -r seedDemo dist/` finds nothing).

The scenario is latched in `sessionStorage` on first load, so navigating away from the query string
keeps it; `?demo=off` clears it. **Demo mode never touches an existing wallet**: if the origin
already holds an identity (other than demo's own from a prior seed), seeding refuses with a console
error and the real app boots untouched — use a browser profile without a wallet, or a different
port. On an identity-free origin the seeder does reset the origin's wallet-storage keys before
writing fixtures.

| Scenario   | What it shows                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recovery` | The SIPA recovery exit: every branch of `recoveryReasonFor` (unsweepable at both ends of the sweep window, stuck, too-young, both terminal phases, and a self-sweep in flight) |
| `activity` | The full feed: transactions in every status, withdrawals in every phase, incoming/outgoing/link payment requests, and contacts with chat history      |
| `onboarding` | Identity-free onboarding; combine with the existing `/claim?mock=create`, `claiming`, `deposit`, `deposit-wrong-chain`, `deposit-expired`, or `funded` states |
| `fresh`    | An onboarded but empty wallet                                                                                                                         |

Wallet scenarios seed a claimed identity, an unlocked session and a balance. The onboarding scenario primes local configuration and leaves the identity and injected provider untouched. `recovery` is the
flagship: its deposits carry real message secrets and the recovery addresses actually derived from
them, so clicking **Recover** runs the real `runSipaRecovery` — signature and all — against a fake
injected wallet, and the record flips to `recovered` live.

### How it fits together

`src/dev/demoFlag.ts` is a small module used by the startup gates; heavier fixtures load through a dynamic import in `main.tsx`. Demo mode boots from the fixture profile, seeds state before rendering, skips PXE and contract-service startup, leaves the unlock gate open, skips XMTP, and primes the local Oxide tuple. The demo wagmi configuration creates no connectors, so wallet-connector configuration and analytics requests do not run. Fixtures use the application's real store classes.

To add a scenario: add its name to `DEMO_SCENARIOS` in `demoFlag.ts`, its fixtures to
`demoFixtures.ts` (typed as the real record types), and a branch to `seedDemo`. Cover it in
`test/dev/demoMode.test.ts` — the suite asserts each scenario through the same reads the screens make.

### Profiling a flow

`VITE_PROFILER=true pnpm build` adds a recording overlay that times every wallet, PXE, circuit,
oracle, node, HTTP, WASM and TEE call and draws the result as a waterfall — the fastest way to see
where a send or a claim actually spends its seconds.
The build downlevels the whole bundle so zone.js can follow await boundaries, which makes it slower
than production: read proportions, and compare only against another profiling build. Any build
without the flag carries none of it. Caveats and how to read a report:
[`src/profiling/README.md`](src/profiling/README.md).

## Product shape

- **Claim X tag** → a name on oxide's L1 `Registry`, gasless via account-service; the X OAuth
  session gates the existing domain-owner `NameClaim` signature, and the claimed tag is the
  session's server-verified X handle.
- **Account** → `ObsidionAccountAlpha` accounts; the MSK derives from the passkey's WebAuthn PRF, so
  every browser produces the same address from the same synced passkey.
- **Balances / sends / receives** → full PXE in the browser (WASM proving), oxide token + TEE
  co-signing + SIPA deposits.
- **Gasless txs** → `ClaimFPC`, a separate top-of-callstack FPC whose eligibility witness is the
  user's own NameClaim + bootstrap-key binding.

## Passkey RP policy

`VITE_PASSKEY_ENVIRONMENT` selects the RP for the wallet: `production` → `auth.zk.money`, `staging`/`preview` → `staging.zk.money`, `prod-preview` → `preview.zk.money`, `local` → `localhost`. Runtime network selection and desktop endpoint overrides cannot change it. Builds reject conflicting `VITE_PASSKEY_RP_ID` overrides and handoff origins from another environment. `passkey-target.json` records the selected environment and RP.
