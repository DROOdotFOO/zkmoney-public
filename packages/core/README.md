# @obsidion/core

Leaf-level workspace package for dependency-free, platform-neutral foundations shared across the obsidion monorepo.

## What belongs here

Shared type aliases and constants belong here, along with narrowly scoped domain foundations that are cross-layer, platform-neutral, dependency-free, and cohesive with a named subpath. `./oxide`, for example, owns the manifest parser, pinned-entry policy, and fetch seam used by frontend and backend consumers. Generic helpers and code that needs a workspace or runtime dependency belongs one layer up — see the root `CLAUDE.md` "Package Layering" section for the full ruleset.

## Why

Other obsidion packages (`@obsidion/contracts`, `@obsidion/sdk`, `@obsidion/front-core`) include heavy artifact JSON, `@aztec-labs/pxe` runtime entry points, and Noir circuit data through their barrel exports. Backend services that only need a handful of primitives (`Network`, `ContractName`, `FPCPaymentType`, `L1_CHAIN_ID`, registry URLs, transaction-result types, …) used to either pay the full artifact-build cost at typecheck time or build CI workarounds around it.

`@obsidion/core` is the leaf those services depend on instead. It is artifact-free, has zero workspace or runtime dependencies, and references `@aztec/*` only through `import type` (declared as `devDependencies`, so they do not enter a consumer's production dependency tree). A backend package that needs only shared foundations can avoid dependencies on `@obsidion/sdk` and `@obsidion/contracts`.

## Subpath exports

Three named exports — there is intentionally **no** root `.` export. Pick the right axis at the import site:

```ts
import { Network, ContractName, BaseTransactionResult, AUTH_TYPE } from "@obsidion/core/types"
import { Network, FPCPaymentType, DEFAULT_CONTRACTS, L1_CHAIN_ID, DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { loadOxideManifestTuple } from "@obsidion/core/oxide"
```

- `./types` — type aliases, interfaces, enum *type* identities (transaction result types, `ContractName`, `IContractServiceStorage`, paylink commitment types, etc.).
- `./constants` — runtime values: enum *runtime* objects (`Network`, `FPCPaymentType`, `AUTH_TYPE`, the seven cross-cutting domain enums), plain literals (`DEFAULT_CONTRACTS`, decimals, chain IDs), `process.env`-derived URLs, and pure helpers (`getFPCContractName`).
- `./oxide` — dependency-free manifest validation, extraction, pinned-entry policy, and acquisition shared across runtime layers.

Enums appear under both subpaths from a single declaration: the runtime form lives in `./constants`, the type identity is re-exported from `./types`.

## Invariants

The canonical test in `test/isolation.test.mjs` verifies that compiled public entry points stay within core and Node built-ins. Build core before running `pnpm test`.

1. **No external runtime dependencies.** Resolution from every public subpath declared in `package.json` must stay within core and Node built-ins.
2. **`@aztec/*` references are type-only.** Compiled output strips them. They are `devDependencies` used to typecheck this package, not dependencies imposed on consumers.
3. **`process.env` reads stay verbatim.** The `process.env.X || "fallback"` evaluation timing is what consumers that write to `process.env` at module load depend on — do not memoize, lazy-getter, or convert to a getter property. The `_env()` helper guards `typeof process` for browser/worker contexts that lack a polyfill, but the eager-at-module-load semantics are preserved.

## Build

```sh
pnpm --filter @obsidion/core build
```

`tsc -b` only. Single-second build on a cold cache.

## Adding a new symbol

- **Cross-cutting and dependency-free?** Add it only when it is platform-neutral and cohesive with a named subpath. Decide whether it is a type (`./types`), a runtime value (`./constants`), Oxide manifest behavior (`./oxide`), or both (mirror enums across types/constants from one declaration like `Network`).
- **Single-package consumer?** Keep it where it's used. Promotion to core is a one-way door — don't pre-emptively elevate.
- **Carries `@aztec/*` runtime?** Don't add to core. Find a different home in SDK or contracts.
