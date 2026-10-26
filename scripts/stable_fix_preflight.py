"""Stable-fix preflight: every release/2.0 fix after the cut is tracked and reaches main (2.1-M215, 2.1-Q202).

Each non-merge commit of `--ref` after its cut (the merge base with `--main`) carries `Stable-fix: <bead>`; each
bead is in main's `.beads/issues.jsonl`; and a main commit names it, by its own `Stable-fix:` trailer or by the bead
id in its subject (the fix landed on main first). The cut's first commit is exempt when it is CI-only: it drops
husky's `prepare` script from desktop/web/package.json and changes nothing else but `.github/workflows/`.

The Release Candidate workflow runs it from main's tools when the ref is on release/2.0, since PRs into release/2.0
run that branch's own workflow files. Run as `python3 -I scripts/stable_fix_preflight.py --repo . --ref <ref>
--main origin/main`; exit 1 names every violation.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

TRAILER = "Stable-fix"
PACKAGE = "desktop/web/package.json"
PREPARE_RE = re.compile(r'^\s*"prepare":\s*".*\bhusky\b.*",?\s*$')
BEAD_RE = re.compile(r"canopi-[0-9a-z]+(?:\.[0-9]+)*")


def git(repo: str, *args: str) -> str:
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def named_in(subject: str, bead: str) -> bool:
    """The bead id appears in the subject as itself, not as a prefix of a longer id."""
    return re.search(rf"(?<![\w.-]){re.escape(bead)}(?![\w-]|\.[0-9])", subject) is not None


def trailers(repo: str, commit: str) -> list[str]:
    values = git(repo, "log", "-1", f"--format=%(trailers:key={TRAILER},valueonly)", commit)
    return [value.strip() for value in values.splitlines() if value.strip()]


def is_ci_only_cut(repo: str, commit: str) -> bool:
    """The cut's first commit: husky's `prepare` dropped, and nothing changed beyond it but workflows."""
    paths = [path for path in git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).splitlines() if path]
    if PACKAGE not in paths or any(path != PACKAGE and not path.startswith(".github/workflows/") for path in paths):
        return False
    before = git(repo, "show", f"{commit}^:{PACKAGE}").splitlines()
    after = git(repo, "show", f"{commit}:{PACKAGE}").splitlines()
    dropped = [index for index, line in enumerate(before) if PREPARE_RE.match(line)]
    if len(dropped) != 1:
        return False
    kept = before[:dropped[0]] + before[dropped[0] + 1:]
    # The line before may lose the comma the dropped last entry needed; nothing else may differ.
    return [line.rstrip(",") for line in kept] == [line.rstrip(",") for line in after]


def main_names(repo: str, main: str) -> tuple[set[str], list[str]]:
    """Beads main's commits name by trailer, and main's subjects."""
    log = git(repo, "log", main, f"--format=%s%x00%(trailers:key={TRAILER},valueonly,separator=%x01)%x1e")
    by_trailer, subjects = set(), []
    for record in log.split("\x1e"):
        subject, _, values = record.strip("\n").partition("\x00")
        if not subject:
            continue
        subjects.append(subject)
        by_trailer.update(value.strip() for value in values.split("\x01") if value.strip())
    return by_trailer, subjects


def known_beads(repo: str, main: str) -> set[str]:
    text = git(repo, "show", f"{main}:.beads/issues.jsonl")
    return {json.loads(line)["id"] for line in text.splitlines() if line.strip()}


def violations(repo: str, ref: str, main: str) -> list[str]:
    cut = git(repo, "merge-base", ref, main).strip()
    commits = git(repo, "rev-list", "--reverse", "--no-merges", f"{cut}..{ref}").split()
    if not commits:
        return []
    beads = known_beads(repo, main)
    by_trailer, subjects = main_names(repo, main)
    found = []
    for index, commit in enumerate(commits):
        short = commit[:12]
        named = trailers(repo, commit)
        if not named:
            if index == 0 and is_ci_only_cut(repo, commit):
                continue
            found.append(f"{short} carries no {TRAILER}: <bead> trailer")
            continue
        for bead in named:
            if not BEAD_RE.fullmatch(bead):
                found.append(f"{short} names {bead!r}, not a bead id")
            elif bead not in beads:
                found.append(f"{short}: {bead} is not in main's .beads/issues.jsonl")
            elif bead not in by_trailer and not any(named_in(subject, bead) for subject in subjects):
                found.append(f"{short}: no main commit names {bead} by its {TRAILER} trailer or in its subject")
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".")
    parser.add_argument("--ref", required=True, help="the release/2.0 ref the candidate builds")
    parser.add_argument("--main", required=True, help="main's ref, fetched with its history")
    args = parser.parse_args(argv)
    try:
        found = violations(args.repo, args.ref, args.main)
    except subprocess.CalledProcessError as error:
        print(f"ERROR: git {' '.join(error.cmd[3:])}: {error.stderr.strip()}", file=sys.stderr)
        return 1
    for violation in found:
        print(f"ERROR: {violation}", file=sys.stderr)
    if found:
        return 1
    print(f"Stable-fix preflight: every {args.ref} commit after the cut is tracked and named on {args.main}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
