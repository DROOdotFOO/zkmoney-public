#!/usr/bin/env python3
from __future__ import annotations

import stat
import subprocess
import sys
from pathlib import Path
from typing import NoReturn, Sequence


class SourceVerificationFailure(Exception):
    pass


def fail(message: str) -> NoReturn:
    raise SourceVerificationFailure(message)


def git(*arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"git {' '.join(arguments)} failed")
    if result.stderr:
        fail(f"git {' '.join(arguments)} wrote unexpected stderr")
    return result.stdout.strip()


def require_sha1(value: str, name: str) -> None:
    if len(value) != 40 or any(
        character not in "0123456789abcdef" for character in value
    ):
        fail(f"{name} must be a lowercase SHA-1")


def verify(argv: Sequence[str]) -> None:
    if len(argv) != 4:
        fail(
            "usage: verify_publish_source.py SOURCE_COMMIT SOURCE_TAG TAG_OBJECT VERIFIER_PATH"
        )
    source_commit, source_tag, tag_object, verifier_raw = argv
    require_sha1(source_commit, "source commit")
    require_sha1(tag_object, "tag object")
    if not source_tag or any(
        not (character.isalnum() or character in "._-") for character in source_tag
    ):
        fail("source tag is malformed")

    if git("rev-parse", "HEAD") != source_commit:
        fail("checked-out HEAD does not equal the admitted source commit")
    if git("rev-parse", f"refs/tags/{source_tag}^{{tag}}") != tag_object:
        fail("signed annotated tag object does not equal the admitted tag object")
    if git("rev-parse", f"refs/tags/{source_tag}^{{}}") != source_commit:
        fail("signed annotated tag does not resolve to the admitted source commit")

    verifier = Path(verifier_raw)
    if verifier.is_absolute() or ".." in verifier.parts:
        fail("verifier path must be repository-relative")
    try:
        metadata = verifier.lstat()
    except FileNotFoundError:
        fail("release verifier script is missing")
    if not stat.S_ISREG(metadata.st_mode):
        fail("release verifier script is not a regular repository file")
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", verifier.as_posix()],
        capture_output=True,
        text=True,
        check=False,
    )
    if (
        tracked.returncode != 0
        or tracked.stderr
        or tracked.stdout.strip() != verifier.as_posix()
    ):
        fail("release verifier script is not tracked at the expected path")
    expected_blob = git("rev-parse", f"HEAD:{verifier.as_posix()}")
    current_blob = git("hash-object", "--", verifier.as_posix())
    if current_blob != expected_blob:
        fail("release verifier script differs from the admitted source commit")
    if git("status", "--porcelain=v1", "--untracked-files=all"):
        fail("checked-out source worktree is not clean")


def main(argv: Sequence[str]) -> int:
    verify(argv)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SourceVerificationFailure as error:
        print(f"publish source verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
