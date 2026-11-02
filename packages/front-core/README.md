# @obsidion/front-core

## What belongs here

Persistence (storage classes, `IStorageAdapter`), non-contract business
logic, HTTP services (relayer, gateway, ENS/CCIP-Read clients),
in-memory aggregators, pure data transforms,
domain services that don't call contracts, and the React contexts/hooks
built on top of all of those. Anything you'd want to share between
wallet fronts belongs here.

Concrete examples already in this package:

- `ContactStorage`, `TokenStorage`, `BalanceStorage`,
  `AccountStorage` — JSON-DTO persistence classes.
- `SIPADepositStore`, `RecordStorage` — bridge state with subscription
  kernel.
- `BridgeActivityFeed` — in-memory aggregator projecting the store into a
  unified subscribe-able feed.
- `accountResource`, `tokenResource`, `teeSignerResource` — session resources over the wallet;
  `useResource` and `useStore` read them and the stores in React.

What does NOT belong here:

- `contract.methods.X()` calls or on-chain-typed payloads →
  `@obsidion/sdk`.
- Noir source or contract codegen → `@obsidion/contracts`.
- Browser-only runtime adapters (the `localStorage` `IStorageAdapter`
  impl, the OPFS PXE store, WebAuthn glue) → `web-wallet/src/`.

This package depends on `@obsidion/sdk` for shared types (account /
wallet / address / network shapes) and for a small number of utility
helpers and service entry points that the asset and account flows
compose against at runtime.
What it does NOT do is originate contract method calls of its own —
no `contract.methods.X()` lives in this package. If a future PR adds
one, that code belongs in `@obsidion/sdk`, not here.

See the root `CLAUDE.md` "Package Layering" section for the full rule
set, decision tree, and gotchas.
