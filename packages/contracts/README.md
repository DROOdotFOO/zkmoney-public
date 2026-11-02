# @obsidion/contracts

## What belongs here

Noir contract artifacts, codegen output, and the TS service layer that
loads compiled artifacts into PXE. Specifically:

- The `.nr` source under `contracts/` and the codegen pipeline that
  produces TS artifacts from it.
- `ContractService` and `ServiceContractBase` — the artifact loader
  and the base class every per-contract service inherits from.
- The transformed-injectable artifact format produced by
  `scripts/transform-artifact.cjs` and the loader on the consumer side.
- Backward-compat re-exports of `@obsidion/core` types/constants so
  consumers that pull them from `@obsidion/contracts` keep working.
- The offline paylink codegen under `scripts/` (see below).

This package depends only on `@obsidion/core` (its leaf). It never
depends on sdk / front-core / web-wallet.

What does NOT belong here:

- Anything that calls `contract.methods.X()` against a deployed instance
  → `@obsidion/sdk`. Per-contract services like `PaylinkService`,
  `TokenService`, `OidcKeyRegistryService` extend
  `ServiceContractBase` (defined here) but live in sdk because they
  drive contract methods, not artifact loading.
- Storage classes, HTTP services, or business logic that doesn't load
  artifacts → `@obsidion/front-core`.
- Browser-only runtime adapters → `web-wallet/src/`.
- Pure type aliases or runtime-free constants used by 2+ packages →
  `@obsidion/core` (the leaf).

See the root `CLAUDE.md` "Package Layering" section for the full rule
set, decision tree, and gotchas.

## Paylink recompilation (`pnpm recompile:paylinks`)

Run it when the paylink Noir source or the zkJWT circuit changes. It refreshes `ZKJWT_VKEY_HASH` in `@obsidion/core/constants` (and the committed vk) from the current zkJWT circuit, then compiles the paylink contracts (email, direct) and prints their class ids. No registry, wallet, PXE, or node connection is needed. The canonical package test runs Check D against the committed verification key and both core pins.
