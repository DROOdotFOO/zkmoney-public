#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import signal
import selectors
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable, NoReturn, Sequence

EXPECTED_STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
EXPECTED_PREDICATE_TYPE = "https://in-toto.io/attestation/release/v0.2"
EXPECTED_VERIFICATION_MEDIA_TYPE = (
    "application/vnd.dev.sigstore.verificationresult+json;version=0.1"
)


class VerificationFailure(Exception):
    pass


class GlobalDeadlineExceeded(VerificationFailure):
    pass


class AttestationCutoffExceeded(VerificationFailure):
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
    _MAX_WAIT_SLICE_SECONDS = 0.05

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        started = clock()
        if not math.isfinite(started):
            fail("monotonic clock returned a malformed value")
        self._last = started
        self._end = started + seconds
        if not math.isfinite(self._end):
            fail("monotonic deadline is malformed")
        self._expired = False

    def expire(self) -> None:
        self._expired = True

    def raise_if_expired(self) -> None:
        if self._expired:
            raise GlobalDeadlineExceeded("global wall-clock deadline expired")

    def _sleep_slice(self, seconds: float) -> None:
        time.sleep(seconds)

    def wait(
        self,
        seconds: float,
        phase: str,
        reserve_seconds: float = 0,
    ) -> None:
        if reserve_seconds:
            self.remaining_before_reserve(reserve_seconds, phase)
        else:
            self.remaining(phase)
        target = self._last + seconds
        if not math.isfinite(target):
            fail("monotonic retry target is malformed")

        while True:
            self.raise_if_expired()
            if reserve_seconds:
                budget = self.remaining_before_reserve(reserve_seconds, phase)
            else:
                budget = self.remaining(phase)
            remaining_interval = target - self._last
            if remaining_interval <= 0:
                return
            sleep_seconds = min(
                self._MAX_WAIT_SLICE_SECONDS,
                remaining_interval,
                budget,
            )
            self.raise_if_expired()
            self._sleep_slice(sleep_seconds)
            self.raise_if_expired()

    def remaining(self, phase: str) -> float:
        self.raise_if_expired()
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

    def remaining_before_reserve(self, reserve_seconds: float, phase: str) -> float:
        remaining = self.remaining(phase) - reserve_seconds
        if remaining <= 0:
            raise AttestationCutoffExceeded(
                f"attestation cutoff reached during {phase}; "
                f"{reserve_seconds:g}-second finalization reserve is required"
            )
        return remaining

    def confirm_output_publication(self) -> None:
        self.remaining("publishing verified attestation")


@dataclass(frozen=True)
class ActiveProcessGroup:
    process: subprocess.Popen[bytes]
    process_group_id: int


class CommandRunner:
    _MANAGED_SIGNALS = {signal.SIGALRM, signal.SIGCHLD}

    def __init__(self, deadline: Deadline, request_timeout: float):
        self.deadline = deadline
        self.request_timeout = request_timeout
        self.active_group: ActiveProcessGroup | None = None
        self._deferred_signal_error: OSError | None = None
        self._deadline_signal_sent = False

    def _spawn_process(self, argv: Sequence[str]) -> subprocess.Popen[bytes]:
        return subprocess.Popen(
            list(argv),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env={**os.environ, "GH_HOST": "github.com"},
        )

    @staticmethod
    def _send_process_group_signal(process_group_id: int) -> None:
        os.killpg(process_group_id, signal.SIGKILL)

    @classmethod
    def _signal_process_group(cls, process_group_id: int) -> bool:
        try:
            cls._send_process_group_signal(process_group_id)
        except ProcessLookupError:
            return False
        except OSError as error:
            raise VerificationFailure(
                f"failed to terminate GitHub command process group "
                f"{process_group_id}: {error}"
            ) from error
        return True


    @staticmethod
    def _confirm_process_group_absent(process_group_id: int) -> None:
        expires_at = time.monotonic() + 1
        while True:
            try:
                os.killpg(process_group_id, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                pass
            except OSError as error:
                raise VerificationFailure(
                    f"failed to confirm GitHub command process group "
                    f"{process_group_id} termination: {error}"
                ) from error
            if time.monotonic() >= expires_at:
                raise VerificationFailure(
                    f"GitHub command process group {process_group_id} "
                    "still exists after termination"
                )
            time.sleep(0.01)

    @staticmethod
    def _close_process_pipes(process: subprocess.Popen[bytes]) -> None:
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()

    @classmethod
    def _reap_process_group_leader(cls, active_group: ActiveProcessGroup) -> None:
        try:
            active_group.process.wait(timeout=1)
        except subprocess.TimeoutExpired as error:
            raise VerificationFailure(
                "failed to reap GitHub command process-group leader after termination"
            ) from error

    def interrupt_active_group(self) -> None:
        active_group = self.active_group
        if active_group is None:
            return
        try:
            self._send_process_group_signal(active_group.process_group_id)
        except ProcessLookupError:
            return
        except OSError as error:
            self._deferred_signal_error = error
        else:
            self._deadline_signal_sent = True

    def raise_if_deferred_signal_failed(self) -> None:
        if self._deferred_signal_error is None:
            return
        error = self._deferred_signal_error
        raise VerificationFailure(
            "failed to terminate GitHub command process group from deadline alarm: "
            f"{error}"
        ) from error

    def _finalize_process_group(
        self,
        active_group: ActiveProcessGroup,
        previous_sigchld_handler: signal.Handlers,
        original_signal_mask: set[signal.Signals],
    ) -> None:
        signal.pthread_sigmask(signal.SIG_BLOCK, self._MANAGED_SIGNALS)
        cleanup_error: VerificationFailure | None = None
        retry_signal_after_reap = isinstance(
            self._deferred_signal_error, PermissionError
        )
        try:
            try:
                signal_sent = self._signal_process_group(
                    active_group.process_group_id
                )
                self._deadline_signal_sent = (
                    self._deadline_signal_sent or signal_sent
                )
            except VerificationFailure as error:
                cleanup_error = error
                retry_signal_after_reap = retry_signal_after_reap or isinstance(
                    error.__cause__, PermissionError
                )
            self._close_process_pipes(active_group.process)
            try:
                self._reap_process_group_leader(active_group)
            except VerificationFailure as error:
                if cleanup_error is None:
                    cleanup_error = error
            if retry_signal_after_reap and active_group.process.returncode is not None:
                try:
                    signal_sent = self._signal_process_group(
                        active_group.process_group_id
                    )
                except VerificationFailure as error:
                    if (
                        isinstance(error.__cause__, PermissionError)
                        and self._deadline_signal_sent
                    ):
                        try:
                            self._confirm_process_group_absent(
                                active_group.process_group_id
                            )
                        except VerificationFailure as confirmation_error:
                            cleanup_error = confirmation_error
                        else:
                            cleanup_error = None
                            self._deferred_signal_error = None
                    else:
                        cleanup_error = error
                else:
                    self._deadline_signal_sent = (
                        self._deadline_signal_sent or signal_sent
                    )
                    cleanup_error = None
                    self._deferred_signal_error = None
        finally:
            if self.active_group is active_group:
                self.active_group = None
            signal.signal(signal.SIGCHLD, previous_sigchld_handler)
            signal.pthread_sigmask(signal.SIG_SETMASK, original_signal_mask)
        if cleanup_error is not None:
            raise cleanup_error

    @staticmethod
    def _collect_output(
        active_group: ActiveProcessGroup,
        timeout: float,
        child_exited: Callable[[], bool],
    ) -> tuple[bytes, bytes]:
        process = active_group.process
        if process.stdout is None or process.stderr is None:
            fail("GitHub command output pipes are unavailable")
        stdout_fd = process.stdout.fileno()
        stderr_fd = process.stderr.fileno()
        output = {stdout_fd: bytearray(), stderr_fd: bytearray()}
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        selector.register(process.stderr, selectors.EVENT_READ)
        expires_at = time.monotonic() + timeout
        try:
            while selector.get_map() or not child_exited():
                remaining = expires_at - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(process.args, timeout)
                for key, _events in selector.select(min(remaining, 0.05)):
                    chunk = os.read(key.fd, 64 * 1024)
                    if chunk:
                        output[key.fd].extend(chunk)
                        continue
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
        finally:
            selector.close()
        return bytes(output[stdout_fd]), bytes(output[stderr_fd])

    def run(
        self,
        argv: Sequence[str],
        phase: str,
        finalization_reserve_seconds: float = 0,
    ) -> subprocess.CompletedProcess[bytes]:
        if finalization_reserve_seconds:
            remaining = self.deadline.remaining_before_reserve(
                finalization_reserve_seconds, phase
            )
        else:
            remaining = self.deadline.remaining(phase)
        timeout = min(self.request_timeout, remaining)
        if timeout <= 0:
            raise GlobalDeadlineExceeded(f"global deadline expired before {phase}")
        cutoff_limits_command = (
            finalization_reserve_seconds > 0 and remaining <= self.request_timeout
        )

        child_exited = False

        def record_child_exit(_signum: int, _frame: object) -> None:
            nonlocal child_exited
            child_exited = True

        previous_sigchld_handler = signal.getsignal(signal.SIGCHLD)
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, self._MANAGED_SIGNALS)
        self._deadline_signal_sent = False
        active_group: ActiveProcessGroup | None = None
        timeout_error: subprocess.TimeoutExpired | None = None
        try:
            try:
                signal.signal(signal.SIGCHLD, record_child_exit)
                process = self._spawn_process(argv)
                active_group = ActiveProcessGroup(process, process.pid)
                self.active_group = active_group
            finally:
                if active_group is None:
                    signal.signal(signal.SIGCHLD, previous_sigchld_handler)
                    command_mask = previous_mask
                else:
                    command_mask = previous_mask - {signal.SIGCHLD}
                signal.pthread_sigmask(signal.SIG_SETMASK, command_mask)

            try:
                stdout, stderr = self._collect_output(
                    active_group, timeout, lambda: child_exited
                )
            except subprocess.TimeoutExpired as error:
                timeout_error = error
                stdout = b""
                stderr = b""
        finally:
            if active_group is not None:
                self._finalize_process_group(
                    active_group, previous_sigchld_handler, previous_mask
                )

        self.raise_if_deferred_signal_failed()
        self.deadline.raise_if_expired()

        if timeout_error is not None:
            if cutoff_limits_command:
                raise AttestationCutoffExceeded(
                    f"attestation cutoff reached during {phase}; "
                    f"{finalization_reserve_seconds:g}-second "
                    "finalization reserve is required"
                ) from timeout_error
            raise VerificationFailure(
                f"{phase} timed out after {timeout:.3f} seconds"
            ) from timeout_error
        if finalization_reserve_seconds:
            self.deadline.remaining_before_reserve(finalization_reserve_seconds, phase)
        else:
            self.deadline.remaining(phase)
        return subprocess.CompletedProcess(
            argv, active_group.process.returncode, stdout, stderr
        )


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
        finalization_reserve_seconds: float,
    ):
        self.identity = identity
        self.runner = runner
        self.deadline = deadline
        self.max_attempts = max_attempts
        self.interval_seconds = interval_seconds
        self.finalization_reserve_seconds = finalization_reserve_seconds
        self.release_id: int | None = None
        self.baseline_assets = self.local_assets("baseline local asset inventory")

    def parse_json(self, payload: bytes, phase: str) -> object:
        try:
            text = payload.decode("utf-8", errors="strict")
            value = json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail(f"{phase} returned malformed JSON")
        return value

    def require_success_json(
        self,
        command: Sequence[str],
        phase: str,
        finalization_reserve_seconds: float = 0,
    ) -> object:
        result = self.runner.run(command, phase, finalization_reserve_seconds)
        if result.returncode != 0:
            fail(f"{phase} failed with exit status {result.returncode}")
        if result.stderr:
            fail(f"{phase} wrote unexpected stderr")
        return self.parse_json(result.stdout, phase)

    def remaining(self, phase: str, finalization_reserve_seconds: float = 0) -> float:
        if finalization_reserve_seconds:
            return self.deadline.remaining_before_reserve(
                finalization_reserve_seconds, phase
            )
        return self.deadline.remaining(phase)

    def local_assets(
        self, phase: str, finalization_reserve_seconds: float = 0
    ) -> tuple[Asset, ...]:
        self.remaining(phase, finalization_reserve_seconds)
        try:
            entries = list(self.identity.evidence_directory.iterdir())
        except OSError as error:
            fail(f"cannot enumerate local release assets: {error.strerror}")
        if not entries:
            fail("release evidence directory contains no assets")
        assets: list[Asset] = []
        for path in entries:
            self.remaining(phase, finalization_reserve_seconds)
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
                        self.remaining(phase, finalization_reserve_seconds)
                        digest.update(chunk)
            except OSError as error:
                fail(f"cannot read local release asset {path.name}: {error.strerror}")
            assets.append(Asset(path.name, metadata.st_size, digest.hexdigest()))
        names = [asset.name for asset in assets]
        if len(names) != len(set(names)):
            fail("local release asset names are not unique")
        self.remaining(phase, finalization_reserve_seconds)
        return tuple(sorted(assets))

    def api(
        self, endpoint: str, phase: str, finalization_reserve_seconds: float = 0
    ) -> object:
        return self.require_success_json(
            ["gh", "api", "--hostname", "github.com", endpoint],
            phase,
            finalization_reserve_seconds,
        )

    @staticmethod
    def require_git_object(
        value: object,
        expected_type: str,
        expected_sha: str,
        failure_message: str,
    ) -> None:
        if not isinstance(value, dict):
            fail(failure_message)
        object_type = value.get("type")
        object_sha = value.get("sha")
        if (
            not isinstance(object_type, str)
            or not isinstance(object_sha, str)
            or object_type != expected_type
            or object_sha != expected_sha
        ):
            fail(failure_message)

    def verify_identity(
        self, phase: str, finalization_reserve_seconds: float = 0
    ) -> None:
        identity = self.identity
        repository = self.api(
            f"repos/{identity.repository}",
            f"{phase}: repository",
            finalization_reserve_seconds,
        )
        if (
            not isinstance(repository, dict)
            or repository.get("full_name") != identity.repository
        ):
            fail(f"{phase}: repository identity drifted")

        release = self.api(
            f"repos/{identity.repository}/releases/tags/{identity.tag}",
            f"{phase}: release",
            finalization_reserve_seconds,
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
            finalization_reserve_seconds,
        )
        if not isinstance(tag_ref, dict):
            fail(f"{phase}: tag reference drifted")
        self.require_git_object(
            tag_ref.get("object"),
            "tag",
            identity.tag_object,
            f"{phase}: tag reference drifted",
        )

        tag_object = self.api(
            f"repos/{identity.repository}/git/tags/{identity.tag_object}",
            f"{phase}: tag object",
            finalization_reserve_seconds,
        )
        if not isinstance(tag_object, dict):
            fail(f"{phase}: tag object response has the wrong type")
        target = tag_object.get("object")
        verification = tag_object.get("verification")
        if (
            tag_object.get("tag") != identity.tag
            or not isinstance(verification, dict)
            or verification.get("verified") is not True
        ):
            fail(f"{phase}: signed tag object or target drifted")
        self.require_git_object(
            target,
            "commit",
            identity.target_commit,
            f"{phase}: signed tag object or target drifted",
        )

        current_assets = self.local_assets(
            f"{phase}: local asset inventory", finalization_reserve_seconds
        )
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
            reserve = self.finalization_reserve_seconds
            self.deadline.remaining_before_reserve(
                reserve, f"attempt {attempt} admission"
            )
            self.verify_identity(
                f"attempt {attempt} pre-attestation",
                reserve,
            )
            result = self.runner.run(
                command,
                f"attempt {attempt}: release attestation",
                reserve,
            )
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
            remaining = self.deadline.remaining_before_reserve(
                reserve, "attestation retry sleep"
            )
            if self.interval_seconds >= remaining:
                raise AttestationCutoffExceeded(
                    "attestation retry sleep would enter the "
                    f"{reserve:g}-second finalization reserve"
                )
            print(
                f"immutable release attestation pending; retrying attempt {attempt + 1} of {self.max_attempts}",
                file=sys.stderr,
            )
            self.deadline.wait(
                self.interval_seconds,
                "attestation retry sleep",
                reserve,
            )
            self.deadline.remaining_before_reserve(reserve, "attestation retry sleep")
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

    def _write_temporary_output_bytes(
        self,
        output_file: BinaryIO,
        attestation: bytes,
    ) -> None:
        output_file.write(attestation)

    def write_temporary_output(self, attestation: bytes) -> Path:
        output = self.identity.output
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.name}.",
            suffix=".tmp",
            dir=output.parent,
        )
        temporary_output = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=True) as output_file:
                self._write_temporary_output_bytes(output_file, attestation)
                output_file.flush()
                os.fsync(output_file.fileno())
            self.deadline.remaining("temporary verified attestation completion")
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temporary_output.unlink(missing_ok=True)
            raise
        return temporary_output

    def run(self) -> Path:
        attestation = self.verify_attestation()
        self.verify_identity("post-attestation identity")
        self.verify_assets()
        self.verify_identity("post-asset identity")
        self.deadline.remaining("writing verified attestation")
        temporary_output = self.write_temporary_output(attestation)
        try:
            self.deadline.remaining("verified attestation completion")
        except BaseException:
            temporary_output.unlink(missing_ok=True)
            raise
        return temporary_output


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
    finalization_reserve_seconds = parse_positive_float(
        "RELEASE_VERIFY_FINALIZATION_RESERVE_SECONDS", "120"
    )
    if finalization_reserve_seconds >= deadline_seconds:
        fail(
            "RELEASE_VERIFY_FINALIZATION_RESERVE_SECONDS must be positive and "
            "strictly less than RELEASE_VERIFY_DEADLINE_SECONDS"
        )
    identity = parse_identity(argv)
    deadline = Deadline(deadline_seconds)
    runner = CommandRunner(deadline, request_timeout)

    def deadline_alarm(_signum: int, _frame: object) -> None:
        deadline.expire()
        runner.interrupt_active_group()

    temporary_output: Path | None = None
    try:
        previous_handler = signal.signal(signal.SIGALRM, deadline_alarm)
        signal.setitimer(signal.ITIMER_REAL, deadline_seconds)
        try:
            temporary_output = Verifier(
                identity,
                runner,
                deadline,
                max_attempts,
                interval_seconds,
                finalization_reserve_seconds,
            ).run()
            deadline.confirm_output_publication()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
        deadline.raise_if_expired()
        if temporary_output is None:
            fail("verified attestation temporary output is missing")
        os.replace(temporary_output, identity.output)
        temporary_output = None
        return 0
    finally:
        if temporary_output is not None:
            temporary_output.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except VerificationFailure as error:
        print(f"immutable release verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
