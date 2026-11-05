# Oxide relayer image

The `@oxide/oxide-relayer` workspace builds the long-running L1 operation relayer. Its default mode is `l1-operations`. It reads a public list of deployments and their bridges, pins one bridge by its Portal, and runs one worker for every listed bridge on the pinned bridge's L2 that its policy selects. Each worker discovers the L2 Broadcaster operations of its deployment and keeps a SQLite database for its Portal. Submission uses a separate funded L1 signer. `DISABLE_SUBMISSION=true` runs fisherman checks and records fake sends as executed.

## Build

Use Node 24, Aztec 6.0.0, Docker Buildx, and the Foundry toolchain. From the repository root:

```sh
pnpm build-contracts
pnpm build:relayer
pnpm prepare:relayer-image
docker buildx build --platform linux/amd64 --provenance=mode=max --sbom=true \
  -f Dockerfile.oxide-relayer -t oxide-relayer:local .
```

The preparation command deploys production dependencies into an isolated
filesystem, copies the built Oxide workspace outputs, and runs the exact CLI
from that filesystem. Publish only a reviewed image by immutable digest.

## Public releases

The [release workflow](../../.github/workflows/release.yml) publishes the public Docker Hub image `azteclabs/oxide-relayer` when a `relayer/vX.Y.Z` or `relayer/vX.Y.Z-rc.N` tag is pushed. The tagged commit must be on `main` or on the release branch of its line, `release/relayer-X.Y.x`. The workflow prepares the same image inputs as the local build above, verifies `--version`, pushes the versioned image, checks that it is anonymously pullable, and creates a GitHub release that contains its digest. Stable releases also move the applicable `X.Y`, `X`, and `latest` tags when they are the newest version in each line. Release candidates get only their full version tag. The private ECR image that the [deployment workflow](../../.github/workflows/relayer-deploy.yml) builds is a separate deployment artifact.

The GitHub `release` environment holds the `DOCKERHUB_USERNAME` and `DOCKERHUB_PASSWORD` secrets and permits only `relayer/v*` tags. Keep this policy, because without it a workflow on any branch can read the secrets. Protect creation of `relayer/v*` tags with a repository ruleset. Tag a reviewed commit and push the tag, for example `git tag relayer/v1.2.3 && git push origin relayer/v1.2.3`. To release a fix for an older line, tag a commit on its `release/relayer-X.Y.x` branch. Push one relayer release tag at a time. The workflow serializes releases, and GitHub keeps only one pending run in a concurrency group.

## Runtime inputs

Set `OXIDE_DEPLOYMENT_ENV_MANIFEST_URL`, `OXIDE_PORTAL`, `READ_L1_RPC_URL`, and `AZTEC_NODE_URL`. The CLI accepts equivalent `run` options; use `docker run --rm oxide-relayer:local run --help` to inspect them.

`OXIDE_DEPLOYMENT_ENV_MANIFEST_URL` (`--deployment-env-manifest`) names the releases list, `v<major>/<env>/releases.json`, a schema v5 deployment env manifest that lists every published deployment with a channel. It can be an `https://` URL, a `file://` URL, or a path. Each deployment lists its bridges. The relayer makes one entry for each bridge, from the fields of the deployment and the fields of the bridge, and the entry has the label of its deployment. The deployment supplies the rollup version, enclave URL, Broadcaster, and OperationExecutor. Each bridge supplies the Portal, L2 token, advertised payout token, plain withdrawal executor, subsidies, and FPC funder. The relayer rejects a list with two deployments for one label, two entries for one Portal, or two entries for one label and one token. If the list cannot be read at startup, startup fails.

`OXIDE_PORTAL` (`--portal`) pins one entry of that list, which must be present; otherwise startup fails and the error names the available deployments. The pinned entry's rollup version selects the L2 the process serves: at startup the relayer compares it with the rollup version the Aztec node reports and refuses to start on a mismatch, so a wrong node URL cannot make a process serve another L2. `fpc-funding` and `epoch-proofs`, when enabled, run for the pinned entry only, and its label is the telemetry `service.version`.

With `l1-operations`, the relayer runs a worker for every entry in the list that has `withdrawalProtocol: l1-operation` and the pinned entry's rollup version, subject to the policy below. The pinned entry's worker starts first and a failure there stops the process; every other worker starts in the background with bounded retries and never stops the process. Each worker logs `deployment worker started label=<label> portal=<portal>` when it is running. The relayer rereads the list every five minutes and adds workers for new entries; it never stops a worker, and a read that fails or that changes the pinned entry's rollup version is logged and ignored. The state path must contain `{portal}` when more than one worker may run. When served entries share a Broadcaster, each operation goes to one of their running workers: a withdrawal finalization to the worker of the Portal that it targets, and any other operation to the first running worker whose token is the payout token, or else to the first running worker on that Broadcaster. The pinned entry is first, then the other entries in manifest order.

One relayer ID has one signer, host and state volume. Multiple IDs may pin entries on the same L2 and serve the same Portal, but they may race to submit the same operation. A separate ID is needed for another L2 because one process uses one Aztec node. The deployment workflow takes the major version and pinned Portal, builds the manifest URL from the environment domain, and resolves the node for that entry's rollup version. Its verified receipt records the policy and the Portals seen at verification. App-entry composition uses that receipt and the current releases list to decide whether to run a funded-deposit smoke; an entry without a serving relayer can still publish with that step marked skipped.

The policy decides which of those entries get a worker and is applied on every read:

- `OXIDE_RELAYER_EXCLUDE_PORTALS` (`--exclude-portals`), optional: a comma-separated list of Portals that get no worker. A skipped entry is logged with reason `excluded`.
- `OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS` (`--l1-operations-payout-tokens`), optional: a comma-separated list of USD tokens or ERC-4626 shares of USD tokens (see [Economic model](#economic-model)). When it is set, every worker accepts the listed tokens as L1-operation payout, and an entry whose advertised token is not listed gets no worker, logged with reason `payout-token`. When it is unset, every worker accepts the advertised token of each served entry and the tokens that their deposit sweeps pay out in (DAI on mainnet), because an operation of one deployment can pay out in the token of another. Each operation's own payout token is still checked against the worker's list.

The pinned entry follows the same policy: it can be excluded or skipped on its token, in which case the relayer logs that it gets no worker while `fpc-funding` and `epoch-proofs` still run for it. The watched deposit tokens come from each entry's advertised token: DAI, USDC, and USDT on mainnet and that token on other chains.

Mount durable storage at `/data` for the default `oxide-relayer-{portal}.sqlite3` files. Supply either a keystore and password file under the mount or an L1 private key through the configured secret environment. Fund the L1 signer with ETH. The read RPC must support `eth_simulateV1` with validation; the Aztec node and each served entry's enclave must be reachable. The configured Chainlink feed and sanctions-list endpoint must be reachable.

For a reader coming from upstream oxide: the inputs and flag names are upstream's. The two differences are the startup check of the pinned entry's rollup version against the node, and the policy, that is the exclude list and the token admission rule, which upstream does not have.

Start the relayer before clients broadcast operations and check that its L2 cursor advances. Observe one transaction through discovery, simulation, screening, L1 execution, and receipt. Back up the SQLite state and monitor discovery lag, deferred operations, signer ETH, and the sanctions-list refresh. The L2 transaction payload is available only for a short window; an operation broadcast before discovery cannot be recovered after its payload is pruned.

## Exact-operation relay

`relay-exact` is a separate one-shot runtime for an already-finalized withdrawal operation. It does not start the
L1-operation discovery loop, historical supervisors, FPC funding, epoch proofs, fake-send mode, or a retry loop. It
does not open the generic relayer SQLite files. The exact runtime uses a dedicated schema-versioned journal and a
shared runtime lease.

The operation identity is not available before the L2 exit transaction is submitted. Derive it after inclusion from
the exact Portal deployment, source transaction hash and block, the single Broadcaster call, its calldata, and the
resulting operation ID. The source block must be at or below the proven L2 tip, the withdrawal must verify against the
transaction effect, and an Outbox witness must exist. Recipient plus amount is not an operation identity.

The approval, approval token, and independently verified runtime identity are accepted only through inherited file
descriptors. Use either `--bundle-fd` for a strict in-memory bundle or all of `--approval-fd`,
`--approval-token-fd`, and `--runtime-identity-fd`. The token is bound to the source commit, immutable image digest,
singleton host, generic-state-set digest, Portal, and operation ID. Never place these values in inventory,
environment files, generated Compose, command arguments, or logs. RPC, manifest, Portal, node, and signer
references use the ordinary reviewed environment configuration.

Cutover is fail closed:

1. Freeze intake outside the relayer.
2. Gracefully stop the generic runtime. Shutdown waits for every signed L1 submission monitor to reach a terminal
   outcome. Only then does it write the clean-handoff marker while still holding the shared lease.
3. Preserve and hash every generic SQLite, WAL, and cursor artifact. The hash set is the approved
   `stateSetDigest`; do not copy, filter, migrate, or rewrite the database.
4. Confirm the exact singleton host, commit, image digest, journal schema, deployment, source evidence, operation,
   and economics. Start `relay-exact`; acquiring its lease consumes the clean-handoff marker.
5. The exact journal records `signing`, signed transaction bytes, and `send_started` durably before the only send.
   A signing, send, or receipt ambiguity locks the approval and evidence permanently. There is no second send.
6. Restore the generic runtime only under separate approval. Its startup does not consume or alter the exact journal.

While the exact runtime owns the lease, unrelated L1-operation discovery/submission, FPC funding, and epoch-proof
work are all delayed. Their SQLite rows and ordering remain unchanged. Account for that whole pause before cutover;
do not use this mode if those obligations cannot be delayed safely.

## User flows

The relayer runs one or more modes, selected with `--modes`. Each mode is one user flow.

### 1. Early epoch proofs and prover claims (`--modes epoch-proofs`)

A withdrawal can only be finalized once the epoch that contains it is proven. Waiting for the full epoch delays every withdrawal in it.

A partial epoch proof covers the epoch from its first checkpoint to the most recent one, and not the full epoch. The withdrawals in those checkpoints are then finalized before the epoch closes.

In this mode, the relayer does not prove. It runs next to a prover node, which does the proving. The relayer watches the prover tips that accumulate in the current epoch. When the tips plus the subsidy pay for the proving and the `submitEpochProof` gas, the relayer asks the prover node to prove those checkpoints now. The user gets paid earlier, and the prover node becomes the first prover of those checkpoints.

The relayer then claims the prover tips. The rollup records the prover id of the proof that moves the proven tip as the first prover, and the Portal pays a claim only to that address. Thus the prover id must be the relayer signer address. Set these prover node settings:

- `PROVER_ID`: the relayer signer address. If you do not set it, the prover id is the address that publishes the proofs, and the relayer cannot claim the tips.
- `PROVER_NODE_PROOF_SUBMISSION_TARGET_ADDRESS`: the `firstProverProofSubmitter` of the pinned manifest entry. It reverts a partial proof whose end checkpoint is already proven, so the prover node does not pay for a proof that records no first prover.

This mode also requires `--prover-node-url`, a nonzero `proverSubsidy`, and an enclave URL in each selected manifest entry. If the prover node's admin API requires an API key, which `aztec start` enables by default, set `OXIDE_RELAYER_PROVER_NODE_API_KEY` to it.

This mode is temporary. When the Aztec protocol enshrines early epoch proofs, we remove the mode. All of its code is in `src/prover/`.

### 2. L1 operations (`--modes l1-operations`)

The main mode. A user broadcasts `(target, payoutToken, l1Calldata)` and a condition on the Broadcaster contract on L2, and the relayer makes that L1 call when the condition is true. Deposits use it to sweep a SIPA (`Balance`) and withdrawals to finalize (`MessageInOutbox`).

The relayer:

1. Watches the small `L1Operation` public logs of the L2 Broadcaster through the _pending_ L2 head,
2. fetches `(target, payoutToken, l1Calldata)` from the broadcasting transaction, which the node only holds until the transaction finalizes,
3. screens, simulates the call with `eth_simulateV1`, screens the addresses its logs expose, and executes it through the `OperationExecutor`, which requires a payout that covers the gas cost.

The `OperationExecutor` transfers the whole resulting `payoutToken` balance to the relayer and reverts when the payout is below the gas cost. Mainnet uses Protect to avoid including reverting transactions. Sepolia uses the public mempool, where an included revert consumes gas.

The caller of `broadcast` chooses the `payoutToken` of each operation. Thus the relayer accepts only operations whose `payoutToken` is in its list of payout tokens, and does not store other operations. `--l1-operations-payout-tokens` (`OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS`) sets the list, as comma-separated addresses. When it is not set, a deployment accepts the `token` of every served manifest entry and the tokens that their deposit sweeps pay out in.

The read RPC must answer `eth_simulateV1` with validation on; the mode probes `eth_simulateV1` at startup. Without validation, the simulated block can run at a base fee of 0, and the subsidies, which price the base fee and the gas price, then quote less than they pay on chain. The screen sees only what the simulation logs: a contract that emits nothing, a non-standard token, or a recipient that state changes before inclusion is not seen.

See [Relayer](../../engineering-design-docs/relayer.md).

### Priority fee

The relayer sets the L1 priority fee to the `eth_maxPriorityFeePerGas` estimate of the read RPC. For L1 operations, the relayer caps this value at `MAX_PRIORITY_FEE_WEI` (0.1 gwei, in `noir-projects/oxide_lib/src/constants.nr`).
This is done since subsidy pays for gas at no more than the base fee plus this capped priority fee.

### Max fee per gas

Set `--l1-max-fee-per-gas-gwei` (`OXIDE_RELAYER_L1_MAX_FEE_PER_GAS_GWEI`) to limit the gas price the relayer pays. When the `maxFeePerGas` of a quote is more than the cap, the relayer does not send the transaction. L1 operations, FPC funding, and prover claim batches stay pending and the relayer quotes them again on the next poll. The max pending age still applies, and a prover claim can expire while the fee stays above the cap.

## Economic model

The relayer pays for gas in ETH and gets paid in tokens, for example DAI or sUSDS. It converts gas to a token with the Chainlink ETH/USD price and the USD value of the token. It reads no market price for a token. A USD token, for example DAI, counts one whole token as one USD. An ERC-4626 vault share whose asset is a USD token, for example sUSDS over USDS, is valued at the assets that the vault converts it to, and each whole asset counts as one USD. The vault rate is read on each quote. The relayer decides which of the two a token is when it first accepts the token: a token that answers `asset()` is a vault share. Thus, accept only tokens that are worth one USD, or shares of one.

### L1 Operations

The payout model and its formulas are in [the relayer design doc](../../engineering-design-docs/relayer.md#payout-and-profit).

The gas limit is 3/2 of the gas that an `eth_simulateV1` run uses, and a second run at that limit confirms it. If that run fails, the relayer doubles the gas limit until a run passes, up to 15M gas, and then requires a payout that covers at least 2/3 of the gas limit. The relayer does not use `eth_estimateGas`, because it runs on a different block than `eth_simulateV1`, because it starts above the gas cap of a transaction (2^24, EIP-7825), where a subsidy can pay a different amount, and because the target controls the limit that it returns.
The gas limit is more than the gas the transaction pays for: it includes gas that is refunded at the end of the transaction, and gas that a call must hold but does not use (EIP-150).
Thus the gas cost uses the gas that an `eth_simulateV1` run uses, not the gas limit.
The transaction can never cost more than `gasLimit * maxFeePerGas`.

We don't have the guarantee of knowing the payout ahead of time, because the operation may have already been executed by another relayer, in which case we receive no tip from it.

### Early EpochProofs

`--early-proof-min-profit` and `--early-proof-proving-cost-per-checkpoint` use integer USD amounts scaled by 10^18. `--early-proof-min-profit-margin-bps` uses basis points of the reward value. All three default to zero. Set the proving cost to account for off-chain compute. `--allow-unprofitable` applies only to L1 operations and FPC funding; it does not bypass epoch-proof profitability checks.

In the case of early epoch proofs the spend happens before the relayer can be paid.
A partial epoch proof costs off-chain compute, and the prover claim that pays for it is a later, separate transaction.
There is no on-chain `minPayout` that can make that spend conditional, so the relayer starts a partial epoch proof only when the accumulated prover tips plus the subsidy cover the gas of the proof submission, which grows with the checkpoints the prefix covers, the gas of the claim transactions, the modelled proving cost per checkpoint (`--early-proof-proving-cost-per-checkpoint`), `--early-proof-min-profit`, and a profit margin (`--early-proof-min-profit-margin-bps`).
The relayer counts one claim transaction for each portal with claims, and its gas grows with the number of claims. A claim must land while the rollup still holds the checkpoint log that the claim verifies against, so the relayer cannot wait long for cheaper gas, and it prices the claims at the same gas price as the proof submission.
The margin covers what can change after that decision: L1 gas can get more expensive before the claim transaction is sent, and another prover can advance the proven tip to those checkpoints first, in which case the relayer paid for compute it will never be recorded as first prover for.

By default, the relayer collects prover tips from the pinned portal only. Set `--prover-payout-tokens` (`OXIDE_RELAYER_PROVER_PAYOUT_TOKENS`) to a comma-separated list of tokens to collect from more portals. The relayer then selects each entry whose portal underlying is in the list, from the pinned entry and the other `l1-operation` entries of the same `rollupVersion`. The list applies to the pinned entry too: if its underlying is not in the list, the relayer does not collect from the pinned portal. The relayer selects the entries at startup only, so restart it to add an entry that the manifest publishes later. The prover can prove only the rollup that the Aztec node follows, so the relayer does not start when the `rollupVersion` of the pinned entry is not the version of that rollup. The rollup records one first prover for each checkpoint, and every selected portal pays its claims to that prover. Thus one proof through the `firstProverProofSubmitter` of the pinned entry lets the relayer claim the tips on every selected portal.

The prover tips and the subsidy are paid in the underlying of each portal, and the relayer values them in USD, as in [Economic model](#economic-model), before it compares them with the gas. So a prover that is paid in sUSDS runs with `--prover-payout-tokens` set to sUSDS, or with `--portal` set to the sUSDS portal.

The prover claim batch itself is priced the same way as every other batch: tips plus subsidy against `gasLimit * maxFeePerGas`, quoted with one gas price for the whole selection, with the lowest-tip claim dropped until the batch clears the floor.
