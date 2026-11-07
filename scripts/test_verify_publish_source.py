#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VERIFIER = Path(__file__).with_name("verify_publish_source.py")
TAG = "oxide-relayer-exact-v1.0.9"


def run(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)


class PublishSourceVerificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = tempfile.TemporaryDirectory()
        self.repository = Path(self.fixture.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "release-test@example.invalid")
        scripts = self.repository / "scripts"
        scripts.mkdir()
        self.verifier_path = scripts / "verify_immutable_release_attestation.py"
        self.verifier_path.write_text("print('verified')\n")
        self.git("add", self.verifier_path.relative_to(self.repository).as_posix())
        self.git("commit", "-qm", "Initial source")
        self.source_commit = self.git("rev-parse", "HEAD").stdout.strip()
        self.git("tag", "-a", TAG, "-m", "Release tag")
        self.tag_object = self.git(
            "rev-parse", f"refs/tags/{TAG}^{{tag}}"
        ).stdout.strip()

    def tearDown(self) -> None:
        self.fixture.cleanup()

    def git(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        result = run(["git", *arguments], self.repository)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        return result

    def verify(
        self,
        *,
        source_commit: str | None = None,
        tag_object: str | None = None,
        verifier: str = "scripts/verify_immutable_release_attestation.py",
    ) -> subprocess.CompletedProcess[str]:
        return run(
            [
                sys.executable,
                str(VERIFIER),
                source_commit or self.source_commit,
                TAG,
                tag_object or self.tag_object,
                verifier,
            ],
            self.repository,
        )

    def test_exact_admitted_source_passes(self) -> None:
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_admitted_source_commit_different_from_head_fails(self) -> None:
        result = self.verify(source_commit="f" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HEAD does not equal", result.stderr)

    def test_moved_tag_object_fails(self) -> None:
        result = self.verify(tag_object="f" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tag object does not equal", result.stderr)

    def test_tag_target_different_from_admitted_source_fails(self) -> None:
        (self.repository / "second.txt").write_text("second\n")
        self.git("add", "second.txt")
        self.git("commit", "-qm", "Second source")
        second_commit = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.verify(source_commit=second_commit)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not resolve", result.stderr)

    def test_dirty_worktree_fails(self) -> None:
        self.verifier_path.write_text("print('changed')\n")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the admitted source commit", result.stderr)

    def test_unrelated_dirty_worktree_fails(self) -> None:
        (self.repository / "dirty.txt").write_text("dirty\n")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("worktree is not clean", result.stderr)

    def test_missing_verifier_fails(self) -> None:
        self.verifier_path.unlink()
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("release verifier script is missing", result.stderr)

    def test_untracked_verifier_fails(self) -> None:
        untracked = self.repository / "scripts" / "untracked.py"
        untracked.write_text("print('untracked')\n")
        result = self.verify(verifier="scripts/untracked.py")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not tracked at the expected path", result.stderr)

    def test_symlink_verifier_fails(self) -> None:
        self.verifier_path.unlink()
        self.verifier_path.symlink_to("../second.py")
        result = self.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a regular repository file", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
