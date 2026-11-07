#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from verify_immutable_release_attestation import Deadline, VerificationFailure

REPOSITORY = "DROOdotFOO/zkmoney-public"
TAG = "oxide-relayer-exact-v1.0.9"
RELEASE_ID = 123456
TAG_OBJECT = "1" * 40
TARGET_COMMIT = "2" * 40
HOSTED_REPOSITORY = f"github.com/{REPOSITORY}"
VERIFIER = Path(__file__).with_name("verify_immutable_release_attestation.py")


def load_state() -> dict[str, object]:
    path = Path(os.environ["FAKE_GH_STATE"])
    if not path.exists():
        return {"calls": []}
    return json.loads(path.read_text())


def save_state(state: dict[str, object]) -> None:
    path = Path(os.environ["FAKE_GH_STATE"])
    temporary_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary_path.write_text(json.dumps(state, sort_keys=True))
    os.replace(temporary_path, path)


def increment(state: dict[str, object], key: str) -> int:
    value = int(state.get(key, 0)) + 1
    state[key] = value
    return value


def baseline_assets() -> list[dict[str, object]]:
    return json.loads(os.environ["FAKE_BASELINE_ASSETS"])


def valid_attestation() -> dict[str, object]:
    subjects: list[dict[str, object]] = [
        {
            "uri": f"pkg:github/{REPOSITORY}@{TAG}",
            "digest": {"sha1": TAG_OBJECT},
        }
    ]
    subjects.extend(
        {"name": asset["name"], "digest": {"sha256": asset["sha256"]}}
        for asset in baseline_assets()
    )
    return {
        "attestation": {"bundle": {}},
        "verificationResult": {
            "mediaType": "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
            "signature": {"certificate": {}},
            "verifiedTimestamps": [{"type": "transparency-log"}],
            "verifiedIdentity": {
                "subjectAlternativeName": "https://dotcom.releases.github.com",
                "issuer": "https://github.com/login/oauth",
            },
            "statement": {
                "_type": "https://in-toto.io/Statement/v1",
                "subject": subjects,
                "predicateType": "https://in-toto.io/attestation/release/v0.2",
                "predicate": {
                    "databaseId": str(RELEASE_ID),
                    "ownerId": "65291057",
                    "packageId": "1446630282",
                    "purl": f"pkg:github/{REPOSITORY}@{TAG}",
                    "repository": REPOSITORY,
                    "repositoryId": "1446630282",
                    "tag": TAG,
                },
            },
        },
    }


def encoded_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":")) + "\n"


def fake_gh_main(argv: list[str]) -> int:
    state = load_state()
    calls = state.setdefault("calls", [])
    assert isinstance(calls, list)
    calls.append(argv)
    outcomes = state.setdefault("outcomes", [])
    assert isinstance(outcomes, list)
    started_monotonic = time.monotonic()
    outcomes.append(
        {
            "status": None,
            "stdout": None,
            "stderr": None,
            "started_monotonic": started_monotonic,
        }
    )
    call_index = len(outcomes) - 1
    save_state(state)
    scenario = os.environ["FAKE_GH_SCENARIO"]

    def finish(status: int, stdout: str = "", stderr: str = "") -> int:
        outcomes[call_index] = {
            "status": status,
            "stdout": stdout,
            "stderr": stderr,
            "started_monotonic": started_monotonic,
        }
        save_state(state)
        sys.stdout.write(stdout)
        sys.stderr.write(stderr)
        return status

    def delay(kind: str, count: int) -> None:
        should_delay = (
            scenario == "all_commands_slow"
            or (scenario == "request_timeout" and kind == "repository" and count == 1)
            or (scenario == "asset_timeout" and kind == "asset")
            or (
                scenario == "final_identity_timeout"
                and kind == "repository"
                and count == 3
            )
        )
        if scenario == "child_process_timeout" and kind == "repository" and count == 1:
            sentinel = os.environ["FAKE_CHILD_SENTINEL"]
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import pathlib,time,sys; time.sleep(1); pathlib.Path(sys.argv[1]).write_text('survived')",
                    sentinel,
                ]
            )
            Path(os.environ["FAKE_CHILD_PID"]).write_text(str(child.pid))
            time.sleep(10)
        if should_delay:
            time.sleep(3)

    if len(argv) == 4 and argv[:3] == ["api", "--hostname", "github.com"]:
        endpoint = argv[3]
        if endpoint == f"repos/{REPOSITORY}":
            count = increment(state, "repository_calls")
            save_state(state)
            delay("repository", count)
            if scenario == "malformed_api_json" and count == 1:
                return finish(0, "{\n")
            if count == 1:
                evidence = Path(os.environ["FAKE_EVIDENCE"])
                if scenario == "local_asset_missing":
                    (evidence / "alpha.txt").unlink()
                elif scenario == "local_asset_added":
                    (evidence / "gamma.txt").write_text("gamma\n")
                elif scenario == "local_asset_changed":
                    (evidence / "alpha.txt").write_text("changed\n")
            repository = (
                "unexpected/repository"
                if scenario == "wrong_repository"
                else REPOSITORY
            )
            return finish(0, encoded_json({"full_name": repository}))
        if endpoint == f"repos/{REPOSITORY}/releases/tags/{TAG}":
            count = increment(state, "release_calls")
            assets = [
                {
                    "name": asset["name"],
                    "size": asset["size"],
                    "digest": f"sha256:{asset['sha256']}",
                }
                for asset in baseline_assets()
            ]
            release_id = RELEASE_ID
            release_tag = TAG
            immutable = True
            if scenario == "wrong_release_id":
                release_id = 999
            elif scenario == "wrong_tag":
                release_tag = "oxide-relayer-exact-v0.0.0"
            elif scenario == "mutable_release":
                immutable = False
            elif scenario == "published_asset_missing":
                assets.pop()
            elif scenario == "published_asset_added":
                assets.append(
                    {"name": "extra.txt", "size": 1, "digest": f"sha256:{'f' * 64}"}
                )
            elif scenario == "published_asset_changed":
                assets[0]["digest"] = f"sha256:{'f' * 64}"
            elif scenario == "duplicate_asset_names":
                assets.append(dict(assets[0]))
            elif scenario == "release_drift_after_attestation" and count >= 2:
                release_id = 999
            elif scenario == "asset_drift_after_attestation" and count >= 2:
                assets[0]["digest"] = f"sha256:{'f' * 64}"
            elif scenario == "final_identity_drift" and count >= 3:
                release_id = 999
            return finish(
                0,
                encoded_json(
                    {
                        "id": release_id,
                        "tag_name": release_tag,
                        "draft": False,
                        "immutable": immutable,
                        "assets": assets,
                    }
                ),
            )
        if endpoint == f"repos/{REPOSITORY}/git/ref/tags/{TAG}":
            increment(state, "tag_ref_calls")
            tag_object = "f" * 40 if scenario == "wrong_tag_object" else TAG_OBJECT
            return finish(
                0, encoded_json({"object": {"type": "tag", "sha": tag_object}})
            )
        if endpoint == f"repos/{REPOSITORY}/git/tags/{TAG_OBJECT}":
            increment(state, "tag_object_calls")
            target = "f" * 40 if scenario == "wrong_tag_target" else TARGET_COMMIT
            return finish(
                0,
                encoded_json(
                    {
                        "tag": TAG,
                        "object": {"type": "commit", "sha": target},
                        "verification": {"verified": True},
                    }
                ),
            )
        return finish(64, stderr=f"unexpected API endpoint: {endpoint}\n")

    expected_verify = [
        "release",
        "verify",
        TAG,
        "--repo",
        HOSTED_REPOSITORY,
        "--format",
        "json",
    ]
    if argv == expected_verify:
        count = increment(state, "verify_calls")
        if scenario in {
            "exact_transient_then_success",
            "transient_until_deadline",
            "transient_wrong_sha",
            "transient_wrong_tag",
            "transient_prefix",
            "transient_suffix",
            "transient_plural",
            "transient_stdout",
            "transient_wrong_status",
        }:
            if scenario == "transient_until_deadline" or count == 1:
                message = f"no attestations for tag {TAG} (sha1:{TAG_OBJECT})"
                if scenario == "transient_wrong_sha":
                    message = f"no attestations for tag {TAG} (sha1:{'f' * 40})"
                elif scenario == "transient_wrong_tag":
                    message = f"no attestations for tag wrong-tag (sha1:{TAG_OBJECT})"
                elif scenario == "transient_prefix":
                    message = (
                        f"warning: no attestations for tag {TAG} (sha1:{TAG_OBJECT})"
                    )
                elif scenario == "transient_suffix":
                    message += " retry later"
                elif scenario == "transient_plural":
                    message = f"no attestation for tag {TAG} (sha1:{TAG_OBJECT})"
                if scenario == "transient_stdout":
                    return finish(1, stdout="unexpected\n", stderr=message + "\n")
                if scenario == "transient_wrong_status":
                    return finish(2, stderr=message + "\n")
                return finish(1, stderr=message + "\n")
        failures = {
            "authentication_failure": (1, "HTTP 401: Bad credentials\n"),
            "permission_failure": (
                1,
                "HTTP 403: Resource not accessible by integration\n",
            ),
            "rate_limit_failure": (1, "HTTP 429: rate limit exceeded\n"),
            "network_failure": (1, "failed to connect to api.github.com\n"),
        }
        if scenario in failures:
            status, message = failures[scenario]
            return finish(status, stderr=message)
        attestation: object = valid_attestation()
        if scenario == "arbitrary_attestation_json":
            attestation = {}
        elif scenario == "multiple_attestations":
            attestation = [valid_attestation(), valid_attestation()]
        elif isinstance(attestation, dict):
            statement = attestation["verificationResult"]["statement"]
            predicate = statement["predicate"]
            subjects = statement["subject"]
            if scenario == "attestation_other_release":
                predicate["databaseId"] = "999"
            elif scenario == "attestation_wrong_repository":
                predicate["repository"] = "unexpected/repository"
            elif scenario == "attestation_wrong_tag":
                predicate["tag"] = "wrong-tag"
            elif scenario == "attestation_wrong_tag_object":
                subjects[0]["digest"]["sha1"] = "f" * 40
            elif scenario == "attestation_asset_missing":
                subjects.pop()
            elif scenario == "attestation_asset_added":
                subjects.append({"name": "extra.txt", "digest": {"sha256": "f" * 64}})
            elif scenario == "attestation_asset_changed":
                subjects[1]["digest"]["sha256"] = "f" * 64
        return finish(0, encoded_json(attestation))

    if (
        len(argv) == 6
        and argv[0:3] == ["release", "verify-asset", TAG]
        and argv[4:6] == ["--repo", HOSTED_REPOSITORY]
    ):
        count = increment(state, "asset_calls")
        save_state(state)
        delay("asset", count)
        expected_names = {asset["name"] for asset in baseline_assets()}
        if Path(argv[3]).name not in expected_names:
            return finish(64, stderr="unexpected asset path\n")
        if scenario == "asset_verification_failure":
            return finish(1, stderr="asset digest verification failed\n")
        return finish(0, stdout="verified\n")

    return finish(64, stderr=f"unexpected or mutating gh argv: {json.dumps(argv)}\n")


class VerifierBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = tempfile.TemporaryDirectory()
        self.root = Path(self.fixture.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "gh").symlink_to(Path(__file__).resolve())
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        self.state = self.root / "state.json"
        self.output = self.root / "verified.json"
        self.child_pid = self.root / "child.pid"
        self.child_sentinel = self.root / "child-survived"

    def tearDown(self) -> None:
        self.fixture.cleanup()

    def reset_evidence(self) -> list[dict[str, object]]:
        for path in self.evidence.iterdir():
            path.unlink()
        (self.evidence / "alpha.txt").write_text("alpha\n")
        (self.evidence / "beta.txt").write_text("beta\n")
        assets = []
        for path in sorted(self.evidence.iterdir()):
            payload = path.read_bytes()
            assets.append(
                {
                    "name": path.name,
                    "size": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
        return assets

    def invoke(
        self,
        scenario: str,
        *,
        deadline: float = 15,
        request_timeout: float = 1,
        interval: float = 0.01,
        attempts: int = 4,
    ) -> tuple[subprocess.CompletedProcess[str], float, dict[str, object]]:
        assets = self.reset_evidence()
        self.state.unlink(missing_ok=True)
        self.output.unlink(missing_ok=True)
        self.child_pid.unlink(missing_ok=True)
        self.child_sentinel.unlink(missing_ok=True)
        environment = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "PYTHONDONTWRITEBYTECODE": "1",
            "FAKE_GH_SCENARIO": scenario,
            "FAKE_GH_STATE": str(self.state),
            "FAKE_BASELINE_ASSETS": json.dumps(assets),
            "FAKE_EVIDENCE": str(self.evidence),
            "FAKE_CHILD_PID": str(self.child_pid),
            "FAKE_CHILD_SENTINEL": str(self.child_sentinel),
            "RELEASE_VERIFY_DEADLINE_SECONDS": str(deadline),
            "RELEASE_VERIFY_REQUEST_TIMEOUT_SECONDS": str(request_timeout),
            "RELEASE_VERIFY_INTERVAL_SECONDS": str(interval),
            "RELEASE_VERIFY_MAX_ATTEMPTS": str(attempts),
        }
        command = [
            sys.executable,
            str(VERIFIER),
            REPOSITORY,
            TAG,
            TAG_OBJECT,
            TARGET_COMMIT,
            str(self.evidence),
            str(self.output),
        ]
        started = time.monotonic()
        result = subprocess.run(
            command, capture_output=True, text=True, env=environment
        )
        finished = time.monotonic()
        elapsed = finished - started
        state = (
            json.loads(self.state.read_text()) if self.state.exists() else {"calls": []}
        )
        state["_test_finished_monotonic"] = finished
        return result, elapsed, state

    def assert_failure(self, scenario: str, message: str, **kwargs: object) -> None:
        result, _elapsed, state = self.invoke(scenario, **kwargs)
        self.assertNotEqual(result.returncode, 0, scenario)
        self.assertIn(message, result.stderr, scenario)
        self.assertFalse(self.output.exists(), scenario)
        self.assert_no_mutation_calls(state)

    def assert_no_mutation_calls(self, state: dict[str, object]) -> None:
        for call in state.get("calls", []):
            self.assertNotIn(
                call[:2],
                [
                    ["release", "create"],
                    ["release", "edit"],
                    ["release", "delete"],
                    ["release", "upload"],
                ],
            )

    def timed_out_command_elapsed(self, state: dict[str, object]) -> float:
        outcomes = state["outcomes"]
        assert isinstance(outcomes, list)
        timed_out = [outcome for outcome in outcomes if outcome["status"] is None]
        self.assertEqual(len(timed_out), 1)
        finished = state["_test_finished_monotonic"]
        started = timed_out[0]["started_monotonic"]
        assert isinstance(finished, float)
        assert isinstance(started, float)
        return finished - started

    def test_immediate_valid_attestation_success(self) -> None:
        result, _elapsed, state = self.invoke("immediate_success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(state["verify_calls"], 1)
        self.assertEqual(state["asset_calls"], 2)
        self.assertEqual(state["repository_calls"], 3)
        self.assert_no_mutation_calls(state)
        identity_calls = [
            ["api", "--hostname", "github.com", f"repos/{REPOSITORY}"],
            [
                "api",
                "--hostname",
                "github.com",
                f"repos/{REPOSITORY}/releases/tags/{TAG}",
            ],
            [
                "api",
                "--hostname",
                "github.com",
                f"repos/{REPOSITORY}/git/ref/tags/{TAG}",
            ],
            [
                "api",
                "--hostname",
                "github.com",
                f"repos/{REPOSITORY}/git/tags/{TAG_OBJECT}",
            ],
        ]
        expected_calls = [
            *identity_calls,
            [
                "release",
                "verify",
                TAG,
                "--repo",
                HOSTED_REPOSITORY,
                "--format",
                "json",
            ],
            *identity_calls,
            [
                "release",
                "verify-asset",
                TAG,
                str(self.evidence / "alpha.txt"),
                "--repo",
                HOSTED_REPOSITORY,
            ],
            [
                "release",
                "verify-asset",
                TAG,
                str(self.evidence / "beta.txt"),
                "--repo",
                HOSTED_REPOSITORY,
            ],
            *identity_calls,
        ]
        self.assertEqual(state["calls"], expected_calls)
        outcomes = state["outcomes"]
        self.assertEqual(len(outcomes), len(expected_calls))
        self.assertTrue(all(outcome["status"] == 0 for outcome in outcomes))
        self.assertTrue(all(outcome["stderr"] == "" for outcome in outcomes))
        self.assertEqual(
            [
                outcome["stdout"]
                for outcome in outcomes
                if outcome["stdout"] == "verified\n"
            ],
            ["verified\n", "verified\n"],
        )

    def test_exact_transient_then_success(self) -> None:
        result, _elapsed, state = self.invoke("exact_transient_then_success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["verify_calls"], 2)
        self.assertEqual(state["repository_calls"], 4)

    def test_identity_and_inventory_failures(self) -> None:
        cases = {
            "malformed_api_json": "malformed JSON",
            "mutable_release": "release identity or immutable state drifted",
            "wrong_repository": "repository identity drifted",
            "wrong_tag": "release identity or immutable state drifted",
            "wrong_tag_object": "tag reference drifted",
            "wrong_tag_target": "signed tag object or target drifted",
            "published_asset_missing": "published release asset inventory drifted",
            "published_asset_added": "published release asset inventory drifted",
            "published_asset_changed": "published release asset inventory drifted",
            "duplicate_asset_names": "published asset names are not unique",
            "local_asset_missing": "local release asset inventory drifted",
            "local_asset_added": "local release asset inventory drifted",
            "local_asset_changed": "local release asset inventory drifted",
            "wrong_release_id": "identifies another release",
        }
        for scenario, message in cases.items():
            with self.subTest(scenario=scenario):
                self.assert_failure(scenario, message)

    def test_nonretryable_transport_and_exact_message_failures(self) -> None:
        cases = {
            "authentication_failure": "non-retryable result",
            "permission_failure": "non-retryable result",
            "rate_limit_failure": "non-retryable result",
            "network_failure": "non-retryable result",
            "transient_wrong_sha": "non-retryable result",
            "transient_wrong_tag": "non-retryable result",
            "transient_prefix": "non-retryable result",
            "transient_suffix": "non-retryable result",
            "transient_plural": "non-retryable result",
            "transient_stdout": "non-retryable result",
            "transient_wrong_status": "non-retryable result",
        }
        for scenario, message in cases.items():
            with self.subTest(scenario=scenario):
                self.assert_failure(scenario, message)

    def test_attestation_schema_and_binding_failures(self) -> None:
        cases = {
            "arbitrary_attestation_json": "unexpected top-level schema",
            "multiple_attestations": "unexpected top-level schema",
            "attestation_other_release": "identifies another release",
            "attestation_wrong_repository": "identifies another release",
            "attestation_wrong_tag": "identifies another release",
            "attestation_wrong_tag_object": "tag subject is unexpected",
            "attestation_asset_missing": "subject cardinality is unexpected",
            "attestation_asset_added": "subject cardinality is unexpected",
            "attestation_asset_changed": "asset subjects do not match",
        }
        for scenario, message in cases.items():
            with self.subTest(scenario=scenario):
                self.assert_failure(scenario, message)

    def test_post_attestation_and_post_asset_drift(self) -> None:
        cases = {
            "release_drift_after_attestation": "post-attestation identity",
            "asset_drift_after_attestation": "post-attestation identity",
            "final_identity_drift": "post-asset identity",
        }
        for scenario, message in cases.items():
            with self.subTest(scenario=scenario):
                self.assert_failure(scenario, message)

    def test_asset_verification_failure(self) -> None:
        self.assert_failure("asset_verification_failure", "asset verification failed")

    def test_global_deadline_is_measured_wall_clock(self) -> None:
        result, elapsed, state = self.invoke(
            "all_commands_slow", deadline=2, request_timeout=10
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(
            "global wall-clock deadline expired" in result.stderr
            or "timed out after" in result.stderr
        )
        self.assertGreaterEqual(elapsed, 1.7)
        self.assertLess(elapsed, 2.75)
        self.assertEqual(len(state["calls"]), 1)
        print(f"MEASURED_GLOBAL_DEADLINE_2S={elapsed:.3f}s")

    def test_request_timeout_is_shorter_than_global_deadline(self) -> None:
        result, elapsed, state = self.invoke(
            "request_timeout", deadline=5, request_timeout=0.5
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("timed out after 0.500 seconds", result.stderr)
        self.assertLess(elapsed, 1.25)
        self.assertEqual(len(state["calls"]), 1)
        print(f"MEASURED_REQUEST_TIMEOUT_0_5S={elapsed:.3f}s")

    def test_slow_asset_verification_is_bounded(self) -> None:
        result, elapsed, state = self.invoke(
            "asset_timeout", deadline=5, request_timeout=0.5
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("asset verification: alpha.txt timed out", result.stderr)
        self.assertLess(elapsed, 5)
        command_elapsed = self.timed_out_command_elapsed(state)
        self.assertLess(command_elapsed, 1)
        self.assertEqual(state["asset_calls"], 1)
        print(
            f"MEASURED_ASSET_TIMEOUT_0_5S={command_elapsed:.3f}s "
            f"(helper {elapsed:.3f}s)"
        )

    def test_slow_final_identity_revalidation_is_bounded(self) -> None:
        result, elapsed, state = self.invoke(
            "final_identity_timeout", deadline=5, request_timeout=0.5
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("post-asset identity: repository timed out", result.stderr)
        self.assertLess(elapsed, 5)
        command_elapsed = self.timed_out_command_elapsed(state)
        self.assertLess(command_elapsed, 1)
        self.assertEqual(state["repository_calls"], 3)
        print(
            f"MEASURED_FINAL_IDENTITY_TIMEOUT_0_5S={command_elapsed:.3f}s "
            f"(helper {elapsed:.3f}s)"
        )

    def test_sleep_that_would_cross_deadline_is_omitted(self) -> None:
        result, elapsed, state = self.invoke(
            "transient_until_deadline",
            deadline=2,
            request_timeout=1,
            interval=2,
            attempts=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("would expire during attestation retry sleep", result.stderr)
        self.assertLess(elapsed, 2)
        self.assertEqual(state["verify_calls"], 1)
        print(f"MEASURED_SLEEP_OMITTED_2S_DEADLINE={elapsed:.3f}s")

    def test_exact_transient_response_is_bounded_by_real_deadline(self) -> None:
        result, elapsed, state = self.invoke(
            "transient_until_deadline",
            deadline=1,
            request_timeout=1,
            interval=0,
            attempts=100,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(
            "global wall-clock deadline expired" in result.stderr
            or "timed out after" in result.stderr
        )
        self.assertGreaterEqual(elapsed, 0.8)
        self.assertLess(elapsed, 1.75)
        self.assertGreaterEqual(state["verify_calls"], 1)
        print(f"MEASURED_TRANSIENT_GLOBAL_DEADLINE_1S={elapsed:.3f}s")

    def test_maximum_attempt_bound_remains_secondary(self) -> None:
        result, elapsed, state = self.invoke(
            "transient_until_deadline",
            deadline=15,
            request_timeout=1,
            interval=0,
            attempts=2,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("attempt limit", result.stderr)
        self.assertEqual(state["verify_calls"], 2)
        self.assertLess(elapsed, 15)

    def test_timed_out_process_group_leaves_no_child(self) -> None:
        result, elapsed, _state = self.invoke(
            "child_process_timeout", deadline=5, request_timeout=0.25
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(elapsed, 1)
        child_pid = int(self.child_pid.read_text())
        time.sleep(1.1)
        self.assertFalse(self.child_sentinel.exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)
        print(f"MEASURED_CHILD_GROUP_TIMEOUT_0_25S={elapsed:.3f}s")

    def test_monotonic_clock_rollback_and_malformed_values_fail_closed(self) -> None:
        values = iter([10.0, 9.0])
        deadline = Deadline(5, lambda: next(values))
        with self.assertRaisesRegex(VerificationFailure, "moved backwards"):
            deadline.remaining("rollback test")
        with self.assertRaisesRegex(VerificationFailure, "malformed value"):
            Deadline(5, lambda: float("nan"))

    def test_fake_gh_rejects_wrong_argv_and_mutation(self) -> None:
        assets = self.reset_evidence()
        environment = {
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            "FAKE_GH_SCENARIO": "immediate_success",
            "FAKE_GH_STATE": str(self.state),
            "FAKE_BASELINE_ASSETS": json.dumps(assets),
            "FAKE_EVIDENCE": str(self.evidence),
            "FAKE_CHILD_PID": str(self.child_pid),
            "FAKE_CHILD_SENTINEL": str(self.child_sentinel),
        }
        invalid_commands = [
            ["release", "verify", TAG, "--repo", HOSTED_REPOSITORY],
            ["release", "verify", TAG, "--format", "json", "--repo", HOSTED_REPOSITORY],
            ["release", "verify", TAG, "--repo", REPOSITORY, "--format", "json"],
            [
                "release",
                "verify",
                TAG,
                "--repo",
                HOSTED_REPOSITORY,
                "--format",
                "json",
                "--extra",
            ],
            [
                "release",
                "verify",
                TAG,
                "--repo",
                HOSTED_REPOSITORY,
                "--repo",
                HOSTED_REPOSITORY,
                "--format",
                "json",
            ],
            ["api", f"repos/{REPOSITORY}"],
            ["release", "create", TAG],
        ]
        for command in invalid_commands:
            with self.subTest(command=command):
                result = subprocess.run(
                    [str(self.bin / "gh"), *command],
                    capture_output=True,
                    text=True,
                    env=environment,
                )
                self.assertEqual(result.returncode, 64)
                self.assertEqual(result.stdout, "")
                self.assertNotEqual(result.stderr, "")


if __name__ == "__main__" and Path(sys.argv[0]).name == "gh":
    raise SystemExit(fake_gh_main(sys.argv[1:]))

if __name__ == "__main__":
    unittest.main(verbosity=2)
