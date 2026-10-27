"""Stable-fix preflight: every release/2.0 fix after the cut is tracked and reaches main (2.1-M215, 2.1-Q202).

Each non-merge commit of `--ref` after its cut (the merge base with `--main`) carries `Stable-fix: <bead>`; each
bead is in main's `.beads/issues.jsonl`; and a main commit names it, by its own `Stable-fix:` trailer or by the bead
id in its subject (the fix landed on main first). The cut's first commit is exempt when it is CI-only: it drops
husky's `prepare` script from desktop/web/package.json and changes nothing else but `.github/workflows/`.

The ref must also carry main's release interface (`npm run tauri`, the root-base Web build, the one notices file),
since the Release Candidate builds it with main's tools (2.1-M216); its marker is the `tauri` package script. Until
one stable fix ports that interface to release/2.0, a candidate there fails closed.
Only main's copy of the Release Candidate builds a candidate (`gh workflow run release-candidate.yml --ref main -f
ref=<ref>`; its first step refuses any other branch) and runs this from main's checkout when the ref is on release/2.0
and not on main. A dispatch with `--ref release/2.0` would run that branch's copy instead, so the ref may carry no
copy that runs off main: 2.0.x's is deleted by the cut's CI-only first commit, or by a stable fix once cut.
Run as `python3 -I scripts/stable_fix_preflight.py --repo . --ref <ref> [--name <dispatched ref>] --main origin/main`;
exit 1 names every violation. `--name` is the ref as dispatched (CI checks it out and passes `--ref HEAD`): the
messages and the dispatch they print name it, never HEAD.
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
RELEASE_CANDIDATE = ".github/workflows/release-candidate.yml"
# The Release Candidate's first step: refuse any branch but main (the same line in main's workflow).
MAIN_ONLY = "if: github.ref != 'refs/heads/main'"


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


def release_interface(repo: str, ref: str, name: str) -> list[str]:
    """main's tools build the ref only once release/2.0 carries main's release interface (the port stable fix)."""
    scripts = json.loads(git(repo, "show", f"{ref}:{PACKAGE}")).get("scripts", {})
    if "tauri" in scripts:
        return []
    return [f"{name} has no `tauri` script in {PACKAGE}: port main's release interface to release/2.0 (npm run "
            "tauri, build:web at the root base, the one notices file) as one stable fix, then dispatch again"]


def runs_off_main(repo: str, ref: str) -> bool:
    """The ref carries a Release Candidate a `--ref <ref>` dispatch would run (absent, or main's refusing copy, not)."""
    shown = subprocess.run(["git", "-C", repo, "show", f"{ref}:{RELEASE_CANDIDATE}"], capture_output=True, text=True,
                           check=False)
    return shown.returncode == 0 and MAIN_ONLY not in shown.stdout


def violations(repo: str, ref: str, main: str, name: str) -> list[str]:
    cut = git(repo, "merge-base", ref, main).strip()
    commits = git(repo, "rev-list", "--reverse", "--no-merges", f"{cut}..{ref}").split()
    if not commits:
        return []
    beads = known_beads(repo, main)
    by_trailer, subjects = main_names(repo, main)
    found = []
    if runs_off_main(repo, ref):
        found.append(f"{name}'s {RELEASE_CANDIDATE} runs off main: a dispatch with --ref {name} would build with it and "
                     "skip this preflight. Delete it in a stable fix (Stable-fix: <bead>; the cut's CI-only first "
                     f"commit if {name} is not pushed yet), and build with main's copy: gh workflow run "
                     f"release-candidate.yml --ref main -f ref={name}")
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
    parser.add_argument("--name", help="the ref as dispatched, named in messages (default: --ref)")
    parser.add_argument("--main", required=True, help="main's ref, fetched with its history")
    args = parser.parse_args(argv)
    name = args.name or args.ref
    try:
        found = release_interface(args.repo, args.ref, name) + violations(args.repo, args.ref, args.main, name)
    except subprocess.CalledProcessError as error:
        print(f"ERROR: git {' '.join(error.cmd[3:])}: {error.stderr.strip()}", file=sys.stderr)
        return 1
    for violation in found:
        print(f"ERROR: {violation}", file=sys.stderr)
    if found:
        return 1
    print(f"Stable-fix preflight: every {name} commit after the cut is tracked and named on {args.main}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
