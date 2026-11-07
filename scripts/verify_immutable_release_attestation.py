#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, NoReturn, Sequence

EXPECTED_STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
EXPECTED_PREDICATE_TYPE = "https://in-toto.io/attestation/release/v0.2"
EXPECTED_VERIFICATION_MEDIA_TYPE = (
    "application/vnd.dev.sigstore.verificationresult+json;version=0.1"
)


class VerificationFailure(Exception):
    pass


class GlobalDeadlineExceeded(VerificationFailure):
    pass


def fail(message: str) -> NoReturn:
    raise VerificationFailure(message)


def parse_positive_float(name: str, default: str) -> float:
    raw = os.environ.get(name, default)
    try:
        value = float(raw)
    except ValueError:
        fail(f"{name} must be a positive finite number")
    if not math.isfinite(value) or value <= 0:
        fail(f"{name} must be a positive finite number")
    return value


def parse_nonnegative_float(name: str, default: str) -> float:
    raw = os.environ.get(name, default)
    try:
        value = float(raw)
    except ValueError:
        fail(f"{name} must be a non-negative finite number")
    if not math.isfinite(value) or value < 0:
        fail(f"{name} must be a non-negative finite number")
    return value


def parse_positive_int(name: str, default: str) -> int:
    raw = os.environ.get(name, default)
    if not raw.isdecimal() or int(raw) <= 0:
        fail(f"{name} must be a positive integer")
    return int(raw)


class Deadline:
    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        started = clock()
        if not math.isfinite(started):
            fail("monotonic clock returned a malformed value")
        self._last = started
        self._end = started + seconds
        if not math.isfinite(self._end):
            fail("monotonic deadline is malformed")

    def remaining(self, phase: str) -> float:
        now = self._clock()
        if not math.isfinite(now):
            fail("monotonic clock returned a malformed value")
        if now < self._last:
            fail("monotonic clock moved backwards")
        self._last = now
        remaining = self._end - now
        if remaining <= 0:
            raise GlobalDeadlineExceeded(f"global deadline expired during {phase}")
        return remaining


class CommandRunner:
    def __init__(self, deadline: Deadline, request_timeout: float):
        self.deadline = deadline
        self.request_timeout = request_timeout
        self.active_process: subprocess.Popen[bytes] | None = None

    def kill_active_group(self) -> None:
        process = self.active_process
        if process is None or process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            return

    def run(
        self, argv: Sequence[str], phase: str
    ) -> subprocess.CompletedProcess[bytes]:
        remaining = self.deadline.remaining(phase)
        timeout = min(self.request_timeout, remaining)
        if timeout <= 0:
            raise GlobalDeadlineExceeded(f"global deadline expired before {phase}")
        process = subprocess.Popen(
            list(argv),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env={**os.environ, "GH_HOST": "github.com"},
        )
        self.active_process = process
        try:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                self.kill_active_group()
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    pass
                raise VerificationFailure(
                    f"{phase} timed out after {timeout:.3f} seconds"
                ) from error
            self.deadline.remaining(phase)
            return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
        except GlobalDeadlineExceeded:
            self.kill_active_group()
            raise
        finally:
            self.active_process = None


@dataclass(frozen=True, order=True)
class Asset:
    name: str
    size: int
    sha256: str

    def api_identity(self) -> tuple[str, int, str]:
        return (self.name, self.size, f"sha256:{self.sha256}")

    def attestation_identity(self) -> tuple[str, str]:
        return (self.name, self.sha256)


@dataclass(frozen=True)
class ExpectedIdentity:
    repository: str
    tag: str
    tag_object: str
    target_commit: str
    evidence_directory: Path
    output: Path

    @property
    def hosted_repository(self) -> str:
        return f"github.com/{self.repository}"


class Verifier:
    def __init__(
        self,
        identity: ExpectedIdentity,
        runner: CommandRunner,
        deadline: Deadline,
        max_attempts: int,
        interval_seconds: float,
    ):
        self.identity = identity
        self.runner = runner
        self.deadline = deadline
        self.max_attempts = max_attempts
        self.interval_seconds = interval_seconds
        self.release_id: int | None = None
        self.baseline_assets = self.local_assets("baseline local asset inventory")

    def parse_json(self, payload: bytes, phase: str) -> object:
        try:
            text = payload.decode("utf-8", errors="strict")
            value = json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail(f"{phase} returned malformed JSON")
        return value

    def require_success_json(self, command: Sequence[str], phase: str) -> object:
        result = self.runner.run(command, phase)
        if result.returncode != 0:
            fail(f"{phase} failed with exit status {result.returncode}")
        if result.stderr:
            fail(f"{phase} wrote unexpected stderr")
        return self.parse_json(result.stdout, phase)

    def local_assets(self, phase: str) -> tuple[Asset, ...]:
        self.deadline.remaining(phase)
        try:
            entries = list(self.identity.evidence_directory.iterdir())
        except OSError as error:
            fail(f"cannot enumerate local release assets: {error.strerror}")
        if not entries:
            fail("release evidence directory contains no assets")
        assets: list[Asset] = []
        for path in entries:
            self.deadline.remaining(phase)
            if "\n" in path.name or "\r" in path.name:
                fail("release asset name contains a line break")
            try:
                metadata = path.lstat()
            except OSError as error:
                fail(
                    f"cannot inspect local release asset {path.name}: {error.strerror}"
                )
            if not stat.S_ISREG(metadata.st_mode):
                fail(f"local release asset is not a regular file: {path.name}")
            digest = hashlib.sha256()
            try:
                with path.open("rb") as asset_file:
                    while chunk := asset_file.read(1024 * 1024):
                        self.deadline.remaining(phase)
                        digest.update(chunk)
            except OSError as error:
                fail(f"cannot read local release asset {path.name}: {error.strerror}")
            assets.append(Asset(path.name, metadata.st_size, digest.hexdigest()))
        names = [asset.name for asset in assets]
        if len(names) != len(set(names)):
            fail("local release asset names are not unique")
        self.deadline.remaining(phase)
        return tuple(sorted(assets))

    def api(self, endpoint: str, phase: str) -> object:
        return self.require_success_json(
            ["gh", "api", "--hostname", "github.com", endpoint], phase
        )

    def verify_identity(self, phase: str) -> None:
        identity = self.identity
        repository = self.api(f"repos/{identity.repository}", f"{phase}: repository")
        if (
            not isinstance(repository, dict)
            or repository.get("full_name") != identity.repository
        ):
            fail(f"{phase}: repository identity drifted")

        release = self.api(
            f"repos/{identity.repository}/releases/tags/{identity.tag}",
            f"{phase}: release",
        )
        if not isinstance(release, dict):
            fail(f"{phase}: release response has the wrong type")
        observed_release_id = release.get("id")
        if type(observed_release_id) is not int or observed_release_id <= 0:
            fail(f"{phase}: release ID is malformed")
        if self.release_id is None:
            self.release_id = observed_release_id
        elif observed_release_id != self.release_id:
            fail(f"{phase}: release identity or immutable state drifted")
        if (
            release.get("tag_name") != identity.tag
            or release.get("draft") is not False
            or release.get("immutable") is not True
        ):
            fail(f"{phase}: release identity or immutable state drifted")
        published_assets = release.get("assets")
        if not isinstance(published_assets, list):
            fail(f"{phase}: published asset inventory has the wrong type")
        parsed_assets: list[tuple[str, int, str]] = []
        for asset in published_assets:
            if not isinstance(asset, dict):
                fail(f"{phase}: published asset entry has the wrong type")
            name = asset.get("name")
            size = asset.get("size")
            digest = asset.get("digest")
            if (
                not isinstance(name, str)
                or type(size) is not int
                or size < 0
                or not isinstance(digest, str)
            ):
                fail(f"{phase}: published asset entry is malformed")
            parsed_assets.append((name, size, digest))
        published_names = [asset[0] for asset in parsed_assets]
        if len(published_names) != len(set(published_names)):
            fail(f"{phase}: published asset names are not unique")

        tag_ref = self.api(
            f"repos/{identity.repository}/git/ref/tags/{identity.tag}",
            f"{phase}: tag reference",
        )
        if not isinstance(tag_ref, dict) or tag_ref.get("object") != {
            "type": "tag",
            "sha": identity.tag_object,
        }:
            fail(f"{phase}: tag reference drifted")

        tag_object = self.api(
            f"repos/{identity.repository}/git/tags/{identity.tag_object}",
            f"{phase}: tag object",
        )
        if not isinstance(tag_object, dict):
            fail(f"{phase}: tag object response has the wrong type")
        target = tag_object.get("object")
        verification = tag_object.get("verification")
        if (
            tag_object.get("tag") != identity.tag
            or target != {"type": "commit", "sha": identity.target_commit}
            or not isinstance(verification, dict)
            or verification.get("verified") is not True
        ):
            fail(f"{phase}: signed tag object or target drifted")

        current_assets = self.local_assets(f"{phase}: local asset inventory")
        if current_assets != self.baseline_assets:
            fail(f"{phase}: local release asset inventory drifted")
        expected_assets = sorted(asset.api_identity() for asset in self.baseline_assets)
        if sorted(parsed_assets) != expected_assets:
            fail(f"{phase}: published release asset inventory drifted")

    def validate_attestation(self, payload: bytes) -> None:
        document = self.parse_json(payload, "release attestation verification")
        if not isinstance(document, dict) or set(document) != {
            "attestation",
            "verificationResult",
        }:
            fail("release attestation response has an unexpected top-level schema")
        if not isinstance(document["attestation"], dict):
            fail("release attestation bundle has the wrong type")
        verification = document["verificationResult"]
        if not isinstance(verification, dict) or set(verification) != {
            "mediaType",
            "signature",
            "verifiedTimestamps",
            "verifiedIdentity",
            "statement",
        }:
            fail("release attestation verification result has an unexpected schema")
        if (
            verification["mediaType"] != EXPECTED_VERIFICATION_MEDIA_TYPE
            or not isinstance(verification["signature"], dict)
            or not isinstance(verification["verifiedTimestamps"], list)
            or len(verification["verifiedTimestamps"]) == 0
            or not isinstance(verification["verifiedIdentity"], dict)
        ):
            fail("release attestation verification metadata is malformed")
        statement = verification["statement"]
        if not isinstance(statement, dict) or set(statement) != {
            "_type",
            "subject",
            "predicateType",
            "predicate",
        }:
            fail("release attestation statement has an unexpected schema")
        if (
            statement["_type"] != EXPECTED_STATEMENT_TYPE
            or statement["predicateType"] != EXPECTED_PREDICATE_TYPE
        ):
            fail("release attestation statement type is unexpected")
        predicate = statement["predicate"]
        expected_predicate_keys = {
            "databaseId",
            "ownerId",
            "packageId",
            "purl",
            "repository",
            "repositoryId",
            "tag",
        }
        if (
            not isinstance(predicate, dict)
            or set(predicate) != expected_predicate_keys
            or not all(isinstance(value, str) for value in predicate.values())
        ):
            fail("release attestation predicate has an unexpected schema")
        if self.release_id is None:
            fail(
                "release attestation was checked before release identity was established"
            )
        expected_purl = f"pkg:github/{self.identity.repository}@{self.identity.tag}"
        if (
            predicate.get("databaseId") != str(self.release_id)
            or predicate.get("repository") != self.identity.repository
            or predicate.get("tag") != self.identity.tag
            or predicate.get("purl") != expected_purl
        ):
            fail("release attestation predicate identifies another release")
        subjects = statement["subject"]
        if (
            not isinstance(subjects, list)
            or len(subjects) != len(self.baseline_assets) + 1
        ):
            fail("release attestation subject cardinality is unexpected")
        tag_subject = subjects[0]
        if tag_subject != {
            "uri": expected_purl,
            "digest": {"sha1": self.identity.tag_object},
        }:
            fail("release attestation tag subject is unexpected")
        asset_subjects: list[tuple[str, str]] = []
        for subject in subjects[1:]:
            if not isinstance(subject, dict) or set(subject) != {"name", "digest"}:
                fail("release attestation asset subject is malformed")
            digest = subject["digest"]
            if (
                not isinstance(subject["name"], str)
                or not isinstance(digest, dict)
                or set(digest) != {"sha256"}
                or not isinstance(digest["sha256"], str)
            ):
                fail("release attestation asset digest is malformed")
            asset_subjects.append((subject["name"], digest["sha256"]))
        subject_names = [subject[0] for subject in asset_subjects]
        if len(subject_names) != len(set(subject_names)):
            fail("release attestation asset names are not unique")
        expected_subjects = sorted(
            asset.attestation_identity() for asset in self.baseline_assets
        )
        if sorted(asset_subjects) != expected_subjects:
            fail("release attestation asset subjects do not match the release")

    def verify_attestation(self) -> bytes:
        identity = self.identity
        command = [
            "gh",
            "release",
            "verify",
            identity.tag,
            "--repo",
            identity.hosted_repository,
            "--format",
            "json",
        ]
        expected_error = (
            f"no attestations for tag {identity.tag} (sha1:{identity.tag_object})\n"
        ).encode()
        for attempt in range(1, self.max_attempts + 1):
            self.verify_identity(f"attempt {attempt} pre-attestation")
            result = self.runner.run(command, f"attempt {attempt}: release attestation")
            if result.returncode == 0:
                if result.stderr:
                    fail("release attestation verification wrote unexpected stderr")
                self.validate_attestation(result.stdout)
                return result.stdout
            if (
                result.returncode != 1
                or result.stdout != b""
                or result.stderr != expected_error
            ):
                fail("release attestation verification returned a non-retryable result")
            if attempt == self.max_attempts:
                fail("release attestation remained unavailable at the attempt limit")
            remaining = self.deadline.remaining("attestation retry sleep")
            if self.interval_seconds >= remaining:
                raise GlobalDeadlineExceeded(
                    "global deadline would expire during attestation retry sleep"
                )
            print(
                f"immutable release attestation pending; retrying attempt {attempt + 1} of {self.max_attempts}",
                file=sys.stderr,
            )
            time.sleep(self.interval_seconds)
            self.deadline.remaining("attestation retry sleep")
        fail("release attestation verification did not complete")

    def verify_assets(self) -> None:
        verified = 0
        for asset in self.baseline_assets:
            path = self.identity.evidence_directory / asset.name
            result = self.runner.run(
                [
                    "gh",
                    "release",
                    "verify-asset",
                    self.identity.tag,
                    str(path),
                    "--repo",
                    self.identity.hosted_repository,
                ],
                f"asset verification: {asset.name}",
            )
            if result.returncode != 0:
                fail(
                    f"asset verification failed for {asset.name} with exit status {result.returncode}"
                )
            if result.stderr:
                fail(f"asset verification wrote unexpected stderr for {asset.name}")
            verified += 1
        if verified != len(self.baseline_assets):
            fail("not every release asset was verified")

    def run(self) -> None:
        attestation = self.verify_attestation()
        self.verify_identity("post-attestation identity")
        self.verify_assets()
        self.verify_identity("post-asset identity")
        self.deadline.remaining("writing verified attestation")
        descriptor = os.open(
            self.identity.output,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        with os.fdopen(descriptor, "wb", closefd=True) as output_file:
            output_file.write(attestation)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.chmod(self.identity.output, 0o600)
        self.deadline.remaining("verified attestation completion")


def parse_identity(argv: Sequence[str]) -> ExpectedIdentity:
    if len(argv) != 6:
        fail(
            "usage: verify_immutable_release_attestation.py REPOSITORY TAG TAG_OBJECT TARGET_COMMIT EVIDENCE_DIRECTORY OUTPUT"
        )
    repository, tag, tag_object, target_commit, evidence, output = argv
    components = repository.split("/")
    if (
        len(components) != 2
        or not all(components)
        or any(
            not all(
                character.isalnum() or character in "._-" for character in component
            )
            for component in components
        )
    ):
        fail("repository must be an owner/name pair")
    if not tag or any(
        not (character.isalnum() or character in "._-") for character in tag
    ):
        fail("tag is malformed")
    if len(tag_object) != 40 or any(
        character not in "0123456789abcdef" for character in tag_object
    ):
        fail("tag object must be a lowercase SHA-1")
    if len(target_commit) != 40 or any(
        character not in "0123456789abcdef" for character in target_commit
    ):
        fail("target commit must be a lowercase SHA-1")
    evidence_path = Path(evidence)
    return ExpectedIdentity(
        repository,
        tag,
        tag_object,
        target_commit,
        evidence_path,
        Path(output),
    )


def main(argv: Sequence[str]) -> int:
    deadline_seconds = parse_positive_float("RELEASE_VERIFY_DEADLINE_SECONDS", "300")
    request_timeout = parse_positive_float(
        "RELEASE_VERIFY_REQUEST_TIMEOUT_SECONDS", "15"
    )
    interval_seconds = parse_nonnegative_float("RELEASE_VERIFY_INTERVAL_SECONDS", "10")
    max_attempts = parse_positive_int("RELEASE_VERIFY_MAX_ATTEMPTS", "30")
    identity = parse_identity(argv)
    deadline = Deadline(deadline_seconds)
    runner = CommandRunner(deadline, request_timeout)

    def deadline_alarm(_signum: int, _frame: object) -> NoReturn:
        runner.kill_active_group()
        raise GlobalDeadlineExceeded("global wall-clock deadline expired")

    previous_handler = signal.signal(signal.SIGALRM, deadline_alarm)
    signal.setitimer(signal.ITIMER_REAL, deadline_seconds)
    try:
        Verifier(identity, runner, deadline, max_attempts, interval_seconds).run()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except VerificationFailure as error:
        print(f"immutable release verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
