# zk.money wallet

Source of the zk.money web wallet and the zk.money Desktop app. This tree builds the wallet for the v6 rollup: config profile `prod-v6`, Oxide commit `3b5e1f7c8`, Aztec `6.0.0`.

## Layout

| Path | Contents |
| --- | --- |
| `packages/web-wallet` | The browser wallet (React + Vite). The PXE runs in the browser. |
| `packages/web-wallet-desktop` | The Electron launcher that serves the built web wallet locally. |
| `packages/core`, `contracts`, `sdk`, `front-core` | The wallet stack: shared types, Noir contracts, contract calls, and app logic. |
| `packages/config-client`, `passkey-web`, `design-system`, `proving-progress`, `metrics-policy` | Libraries that the wallet imports. |
| `packages/oxide-build` | Builds the vendored Oxide packages. |
| `vendor/oxide` | The subset of Oxide that the wallet needs, the relayer source, and the refund and resolver circuits, at commit `3b5e1f7c8`. |

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 24.15 or later (the Aztec 6.0.0 installer needs it) |
| pnpm | 9.14.4 (`corepack enable`) |
| Yarn | 4 (`corepack` supplies it for `vendor/oxide/l1-contracts`) |
| Foundry (`forge`) | 1.4 or later |
| Aztec toolchain | 6.0.0 (`aztec`, `aztec-nargo`, `aztec-bb`) |
| jq | any |
| rsync, bash | any; macOS and Linux have them |
| Google Chrome | any; the desktop app opens the installed Chrome (or set `CHROME_PATH`) |

The contract build fetches Noir dependencies and two pinned Solidity repositories from github.com.

## Build

```shell
git clone <this repo>
cd zkmoney-public
pnpm install --frozen-lockfile
pnpm build-contracts        # Noir contracts, Oxide build, then the contracts package
OXIDE_REFUND_CIRCUITS=required pnpm build:web-deps
GH_TOKEN=$(gh auth token) pnpm --filter @obsidion/generation-v5 fetch:bundle
```

`OXIDE_REFUND_CIRCUITS=required` compiles the three Oxide refund circuits. The wallet uses them to move funds out of a frozen deployment, and it refuses a stub. Without the variable, the dependency build writes stubs. The tests can use the stubs.

The wallet reads and upgrades v5 accounts through a build of the v5 wallet at the commit `packages/generation-v5/source.json` names. `fetch:bundle` downloads it into `packages/generation-v5/dist` from one of this repository's releases: `source-generations`, or the release whose tag is the bundle's asset name without `.tar.zst`. This repository publishes each new bundle in its own release, because its releases are immutable. `fetch:bundle` needs any GitHub token. A build without the bundle cannot read v5 accounts; `REQUIRE_SOURCE_GENERATIONS=true` makes that a build error.

You must supply three values yourself: an Aztec mainnet node URL (`VITE_NODE_URL`), its API key if the node needs one (`VITE_NODE_API_KEY`), and an Ethereum mainnet RPC URL (`VITE_L1_RPC_URL`). The example files hold all other mainnet values.

### Web wallet

```shell
cp packages/web-wallet/.env.mainnet.example packages/web-wallet/.env.production
# Fill VITE_NODE_URL, VITE_NODE_API_KEY and VITE_L1_RPC_URL.
pnpm --filter @obsidion/web-wallet build
```

The build fetches the `prod-v6` config profile and bakes it into the bundle. The build fails if the profile, the network, or the Oxide pointer does not agree. The output is in `packages/web-wallet/dist`.

### Desktop app

```shell
cd packages/web-wallet-desktop
cp config/mainnet.env.example config/mainnet.env
# Fill VITE_NODE_URL, VITE_NODE_API_KEY and VITE_L1_RPC_URL.
npm ci
ENV_FILE=config/mainnet.env SKIP_MONOREPO_BUILD=1 pnpm build:web
pnpm start                  # run from source
pnpm dist:mac               # or dist:linux, dist:win
```

The installers are in `packages/web-wallet-desktop/dist`. They are not signed. macOS shows a Gatekeeper warning for an unsigned app.

See [packages/web-wallet-desktop/README.md](packages/web-wallet-desktop/README.md) for how the launcher serves the wallet under `wallet.zk.money`.

## Desktop releases

`.github/workflows/release-desktop.yml` builds the macOS, Windows and Linux installers and attaches them to a draft GitHub release.

1. In the repository settings, create the environment `production`. Add the secrets `WEB_WALLET_NODE_URL`, `WEB_WALLET_L1_RPC_URL` and, if the node needs one, `WEB_WALLET_NODE_API_KEY`.
2. Optional: add the signing secrets. The comment at the top of the workflow lists them. Without them, the installers are unsigned.
3. Push a tag: `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`. A tag with a hyphen, such as `desktop-v0.1.0-rc1`, makes a pre-release.
4. Review the draft release and publish it. The download links `releases/latest/download/zkmoney-desktop-mac-arm64.dmg` and the other installer names then resolve to it.

**Caution:** the node URL, the node API key and the L1 RPC URL go into every installer in plain text. Use endpoints that you can make public.

## Enclave host

The wallet sends signature requests to the Oxide enclave at the `enclaveUrl` in the Oxide manifest. `vendor/oxide/yarn-project/tee-proxy` is the HTTP front end of an enclave host. The host tooling that starts the enclave is in the Oxide repository, under `tee-host/`, at commit `3b5e1f7c8`.

The `TeeRegistry` contract on L1 accepts an enclave only if its PCR0 is the same as the `PCR0_HASH` that the contract got at deployment. Each new enclave must be registered with `TeeRegistry.registerTee`. The registration sends a message to L2, and each spend proves the inclusion of this message. The Oxide repository does this registration in `yarn-project/tee-registrar`.

To make the wallet use your own host, set the enclave URL in the endpoint editor on the wallet's Settings page.

### Reproduce the enclave image

`scripts/build-enclave.sh` builds the EIF from `vendor/oxide` (copied from Oxide commit `3b5e1f7c8`) and prints its measurements. Compare them with the release build values below.

Requirements: Linux x86_64, Docker with buildx, `jq`, `nitro-cli` 1.5.0, and the [v1.5.0 `blobs/x86_64`](https://github.com/aws/aws-nitro-enclaves-cli/tree/v1.5.0/blobs/x86_64) files in `/usr/share/nitro_enclaves/blobs`. The Amazon Linux package ships different blobs, which change PCR0.

```sh
scripts/build-enclave.sh dist/enclave
```

| | Release build value |
| --- | --- |
| PCR0 | `4d28e5b10f51d67b1383f1cf738b567fe9e19efa6043d8470a5dad299d2e30c9e76e7493c0df7bb5e9c2cc2156348b73` |
| PCR1 | `0343b056cd8485ca7890ddd833476d78460aed2aa161548e4e26bedf321726696257d623e8805f3f605946b3d8b0c6aa` |
| PCR2 | `13436262d1a664df460a32c51802b0b365654cfdde6030bbad56f73ae58e21ff6ea8e9d59fe6e0bbdb6874baf9b6e5d2` |
| Docker image | `sha256:84c4463dcd1e26e6efd53135832544de0ab5b03dbad4365fb1236e81666fe26d` |
| Blobs fingerprint | `9f2473748e0c953194d30d7a2708887875ac58ba1918406353b405909485772e` |

The Keccak-256 hash of PCR0 equals `PCR0_HASH()` of `TeeRegistry` `0x8b705C3519169F29850D156574ec377B686bd9CD`.

## Relayer

`vendor/oxide/yarn-project/oxide-relayer` is the Oxide relayer. It completes L1 operations for users, so that users do not need ETH for gas. `vendor/oxide/yarn-project/telemetry` and `vendor/oxide/yarn-project/watcher-lib` are its Oxide dependencies. These packages are copies from Oxide commit `3b5e1f7c8`, without the relayer `Dockerfile`.

To build the relayer, clone the repository and run `pnpm install --frozen-lockfile` as in [Build](#build). Then run:

```shell
pnpm build-contracts        # compiles the Broadcaster contract, among others
pnpm build:relayer          # generates @oxide/noir-contracts.js, then compiles the relayer
node vendor/oxide/yarn-project/oxide-relayer/dest/bin/oxide-relayer.js run --help
```

For the relayer configuration, see [vendor/oxide/yarn-project/oxide-relayer/README.md](vendor/oxide/yarn-project/oxide-relayer/README.md).

## Circuits

`vendor/oxide/noir-projects` holds the Noir source of the Oxide circuits whose proofs L1 contracts verify. `refund_lib` is the library of the refund circuits.

| Circuit | L1 verifier | Contract that uses the verifier |
| --- | --- | --- |
| `frozen_notes_refund` | `src/generated/FrozenNotesRefundVerifier.sol` | `OxidePortal` |
| `frozen_deposits_refund` | `src/generated/FrozenDepositsRefundVerifier.sol` | `OxidePortal` |
| `unprocessed_deposit_refund` | `src/generated/UnprocessedDepositRefundVerifier.sol` | `OxidePortal` |
| `resolver_circuit` | `src/pinned/PinnedResolverVerifier.sol` | The Resolver module |

The verifier paths are in `vendor/oxide/l1-contracts`.

To compile the refund circuits and check them against their verifiers, run [Build](#build) to `pnpm build-contracts`, then run:

```shell
pnpm build:oxide-circuits
```

For each refund circuit, the script writes `target/<circuit>.json` and the vk in `target/keys/vk`. It then generates a Solidity verifier from the vk, with the same `aztec-bb` settings as Oxide's verifier build. The script fails if this verifier is not the same as the verifier in the table.

The script does not check `resolver_circuit`. `src/pinned/PinnedResolverVerifier.sol` is pinned to the circuit that the deployed Resolver module uses. The Aztec 6.0.0 toolchain compiles the vendored resolver source to a different vk.

`@oxide/refund-proof` reads the compiled refund circuits from `target/`. `OXIDE_REFUND_CIRCUITS=required pnpm build:web-deps` also compiles the refund circuits, but it does not compare them with the verifiers.

## Tests

Each package runs its unit tests with `pnpm test`. The tests need no sandbox and no network.

The desktop smoke test (`packages/web-wallet-desktop`, `pnpm test`) and the web wallet's `desktopSettingsPage` test expect a time zone at UTC or east of UTC. In a time zone west of UTC, run them with `TZ=UTC pnpm test`.

## License

MIT. See [LICENSE](LICENSE).
