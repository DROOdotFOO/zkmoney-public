# Changelog

## Unreleased

- Add a fail-closed `relay-exact` runtime for one approved, finalized withdrawal operation.
- Consume each operation once with a stable operation-scoped conditional S3 claim, compliance Object Lock retention, exact-version verification, and no local-only fallback.
- Bind source, image, host, expected signer, schema, Portal, operation, complete state inventory, canonical-state digest, approval-signature commitment, and witness authority in approval and monotonic claim evidence without exposing the approval nonce or recipient linkage.
- Reserve generic signing identity, request digest, signer, chain and nonce durably before signing; persist signed bytes before one raw send; keep accepted transactions unresolved until a durable terminal chain outcome.
- Detect local exact-journal rollback from witness records, reject a fresh approval for an already claimed operation, and require journal/witness consistency before any generic submission.
- Permanently quarantine exact operations from generic submission and atomically install descriptor-only, terminal-evidence-bound generic restore authorization.
- Inventory every reachable mount and state artifact; refuse unknown artifacts and preserve unrelated SQLite, WAL, exporter, cursor, retry, FPC, and epoch state.
- Enforce separate limits of one TEE finalization signature request, one L1 transaction signing, and one `eth_sendRawTransaction` call.
- Add exact-head CI for clean runtime staging, CLI smoke, complete source tests, and all production build inputs with a checksum-pinned toolchain bootstrap.
