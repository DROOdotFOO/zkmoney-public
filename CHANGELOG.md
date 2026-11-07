# Changelog

## 1.0.9

- Check out and verify the exact admitted signed-tag source before the sole immutable release-creation boundary.
- Bound every post-publication GitHub read and asset verification with one monotonic 300-second deadline, a real per-command 15-second process timeout, and process-group termination.
- Bind the verified GitHub release attestation to the immutable release ID, repository, tag object, tag target and complete asset inventory, with identity checks before and after asset verification.
- Exercise publish-job ordering, strict command arguments, retry classification, identity drift and measured timeout behavior before release qualification.
- Preserve the v1.0.8 tag, immutable release, image and evidence as frozen historical records; v1.0.9 uses distinct branch, tag, artifact and certificate identities.

## 1.0.8

- Qualify two byte-identical offline image builds, complete tests, source archive, SPDX SBOM, checksums, and runtime smoke before creating the release tag.
- Reuse one explicitly fetched Sigstore identity token for image signing, release and SBOM attestations, and release-manifest signing while preserving independent GitHub provenance and post-signature verification.
- Publish only the authoritative pre-tag image bytes after importing their exact qualification manifest, SBOM, and checksums into the sole tag-origin workflow attempt.

## 1.0.7

- Publish only from the exact signed release tag after immutable-release, tag/version, GitHub-hosted runner, and verified tag-target admission checks.
- Attach authoritative CI evidence through one staged `gh release create` invocation, then require the immutable GitHub release attestation and verify every attached asset.

## 1.0.6

- Disable both viem fallback-level and HTTP-level automatic retries so one exact or generic send boundary makes at most one `eth_sendRawTransaction` network call.
- Recheck every exact-operation irreversible boundary, reject replacement receipts, and commit rather than persist private witness coordinates in exact journal schema v4.

## 1.0.5

- Run the production-entrypoint smoke against the Linux Docker daemon without host sudo and expose only credential-free preflight failure reasons.

## 1.0.4

- Recompute exact Outbox roots with the indexer's `sha256Trunc(left || right)` Merkle algorithm and bind the actual typed L2-to-L1 sibling path.
- Verify Portal rollup identity, complete withdrawal economics and malformed public-call handling before operation consumption.
- Bound and wipe privileged runtime inputs, reject raw node and cloud credentials from the environment, and keep signer buffers unopened until all public configuration parses.
- Restore release-build type checking for the exact Outbox witness shape.
- Smoke the real image entrypoint against UID-1000 mode-0700 canonical state, root-only configuration, inherited stdin, and isolated control storage before candidate publication and after immutable-digest verification.

## 1.0.3

- Independently derive and verify the exact Portal deployment, registry, manifest, source transaction, public-call digest, operation identity, finalized source block, Outbox proof and economics before consuming the operation witness.
- Add a credential-free production-image preflight that exercises the real root initializer, canonical read-only mount checks, state inventory, privilege drop and final UID/GID/capability assertions without network or state mutation.
- Restrict root initialization to `DAC_READ_SEARCH`, `SETUID` and `SETGID`, then permanently drop to dedicated UID/GID 65532 before credential, witness, RPC, signing or transaction logic.
- Move the exact journal to physical schema v3, use normal SQLite locking so a clean close removes rollback journals, and keep witness quarantine reads scoped to exact-operation claims.
- Prevent public fixtures and durable witness/evidence projections from exposing private host or withdrawal linkage.

## 1.0.2

- Add a fail-closed fork-only `relay-exact` runtime for one Ed25519-approved v4 withdrawal operation, including signed execution windows and Stage A identity binding.
- Run the exact process as dedicated UID/GID 65532 after a root-only initializer opens protected inputs and drops privileges; no active, permitted, inheritable, or ambient capability remains, the bound is limited to the already-spent SETUID/SETGID transition, and no-new-privileges prevents reacquisition.
- Preflight legacy UID/GID 1000 canonical state, inventory, generic journal and clean-handoff evidence as root, retain only immutable identities, then keep every exact lease, journal and ambiguity write under runtime-owned control state.
- Consume each operation once with a stable operation-scoped conditional S3 claim, compliance Object Lock retention, exact-version verification, and no local-only fallback.
- Bind source, image, host, expected signer, schema, Portal, operation, complete state inventory, canonical-state digest, approval-signature commitment, and witness authority in approval and monotonic claim evidence without exposing the approval nonce or recipient linkage.
- Reserve generic signing identity, request digest, signer, chain and nonce durably before signing; persist signed bytes before one raw send; keep public-route and other accepted transactions unresolved until a receipt or proven mined replacement provides a durable terminal outcome.
- Detect local exact-journal rollback from witness records, reject a fresh approval for an already claimed operation, and require journal/witness consistency before any generic submission.
- Permanently quarantine exact operations from generic submission, atomically install signer-bound, descriptor-only, terminal-evidence-bound generic restore authorization, and expose an ephemeral PID-1 readiness marker only after all generic startup gates and workers initialize.
- Inventory every reachable mount and state artifact, including recoverable fixed control-marker writes; securely discard only torn, uncommitted temp writes under the active generic lease or a newly verified restore approval, refuse unknown artifacts, and preserve unrelated SQLite, WAL, exporter, cursor, retry, FPC, and epoch state.
- Enforce separate limits of one TEE finalization signature request, one L1 transaction signing, and one `eth_sendRawTransaction` call.
- Add exact-head CI for clean contract and runtime staging, production image assembly and CLI smoke, complete source tests, all production build inputs, and a checksum-keyed toolchain bootstrap.
