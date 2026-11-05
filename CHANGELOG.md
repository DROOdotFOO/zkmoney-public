# Changelog

## Unreleased

- Add a fail-closed `relay-exact` runtime for one approved, finalized withdrawal operation.
- Add durable one-shot approval, signing, pre-send, ambiguity, and terminal-result journal states.
- Prevent generic and exact relayers from running concurrently with one fixed global lease; reject clean handoff after an unknown generic broadcast result.
- Keep generic relayer SQLite, WAL, cursor, historical, retryable, FPC, and epoch state outside the exact runtime; reject symlinked state and noncanonical exact-journal schemas.
- Require an Ed25519-signed descriptor-only approval bound to the exact source commit, image digest, host, state-set digest, deployment, and operation identity.
- Root-own the image authority and source identity, rebuild release artifacts from clean source, and suppress sensitive RPC failures at the exact CLI log boundary.
- Preserve Viem's zero-retry raw-send contract, sign only the startup-verified chain ID, and forbid exact handoff from custom generic state paths.
- Mark exact-operation image publication blocked until approval consumption has a reviewed non-rollbackable external anchor.
