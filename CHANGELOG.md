# Changelog

## Unreleased

- Add a fail-closed `relay-exact` runtime for one approved, finalized withdrawal operation.
- Add durable one-shot approval, signing, pre-send, ambiguity, and terminal-result journal states.
- Prevent generic and exact relayers from running concurrently; require a clean generic shutdown with no active settlement monitor before exact-operation cutover.
- Keep generic relayer SQLite, WAL, cursor, historical, retryable, FPC, and epoch state outside the exact runtime.
- Require descriptor-only approval inputs bound to the exact source commit, image digest, host, state-set digest, deployment, and operation identity.
