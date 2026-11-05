# Changelog

## Unreleased

- Add a fail-closed `relay-exact` runtime for one approved, finalized withdrawal operation.
- Consume approval with conditional S3 creation, compliance Object Lock retention, exact-version verification, and no local-only fallback.
- Bind source, image, host, schema, Portal, operation, complete state inventory, canonical-state digest, and witness authority in approval and monotonic claim evidence.
- Persist generic and exact signed bytes and pre-send state before one raw send; make unknown outcomes durable and non-retryable across restart.
- Detect local exact-journal rollback from witness records and require journal/witness consistency before any generic submission.
- Permanently quarantine exact operations from generic submission and add descriptor-only, terminal-evidence-bound generic restore authorization.
- Inventory every reachable mount and state artifact; refuse unknown artifacts and preserve unrelated SQLite, WAL, exporter, cursor, retry, FPC, and epoch state.
- Enforce separate limits of one TEE finalization signature request, one L1 transaction signing, and one `eth_sendRawTransaction` call.
- Add exact-head CI for the complete relayer build and test path.
