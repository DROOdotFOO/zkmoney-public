# @obsidion/sdk

## What belongs here

Direct contract interaction. Anything that calls `contract.methods.doFunc()` against a deployed
instance, models types around on-chain values, drives account-contract interaction (entrypoints,
nullifiers, witness derivation), or deploys contracts. Re-exports from `@obsidion/contracts` (and
therefore `@obsidion/core`) for backward compatibility.

**Calling an Aztec NODE is NOT contract interaction.** A `createAztecNodeClient`

- `node.getBlockNumber()` call hits the node's RPC, not a contract. Code that does only that and
  then runs business logic belongs in `@obsidion/front-core`. The line is: contract method calls
  earn you sdk; node RPC alone does not.

What does NOT belong here:

- Storage classes, HTTP services, in-memory aggregators, or any persistence-/orchestration-layer
  code → `@obsidion/front-core`. All current storage classes including `NetworkStorage` live in
  front-core; this package no longer hosts persistence.
- Browser-only runtime adapters → `web-wallet/src/`.
- Noir source or codegen pipeline → `@obsidion/contracts`.

### Run Tests

```shell
pnpm test           # sandbox-free unit tests
pnpm test:sandbox   # needs a running sandbox
```

### Run Individual Tests

```shell
pnpm test -- test/transferMeta.test.ts
pnpm test:sandbox test/alpha_account/alpha_account.sandbox.test.ts
```

#### Run mulitple PXEs

run this in terminal 1

```shell
VERSION=2.0.3 aztec start --sandbox
```

run this in terminal 2

```shell
VERSION=2.0.3 aztec start --port 8081 --pxe --pxe.nodeUrl=http://host.docker.internal:8080/ --pxe.proverEnabled false
```
