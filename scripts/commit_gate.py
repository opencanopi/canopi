#!/usr/bin/env python3
"""The commit gate the tracked hooks in .githooks run (2.1-M14, 2.1-M196; ADR 0028 Agent enforcement).

    python3 scripts/commit_gate.py pre-commit           the staged change's checks
    python3 scripts/commit_gate.py commit-msg <file>    the message and diff rules (chunk 2; passes until then)
    python3 scripts/commit_gate.py pre-merge-commit     a merge commit's checks (chunk 2; passes until then)

pre-commit takes a fast path by what is staged (2.1-Q223): a commit staging only .beads/ runs nothing; one staging only
documentation (docs/**, *.md, with .beads/ allowed beside them) runs AGENTS.md's Docs row, `check_docs.py` and its
`--drift` against the merge base with origin/main; anything else runs `npm run typecheck` in desktop/web, the one
typecheck command (2.1-Q205), offline as the commit lane is (npm_config_offline=true). A git query that fails (no
origin/main to take the merge base from, an unreadable index) refuses the commit.
"""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


class GitFailed(Exception):
    """A git query the gate depends on failed: the commit is refused, never read as passing."""


def git_ok(*args):
    result = git(*args)
    if result.returncode != 0:
        raise GitFailed(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def staged():
    return [p for p in git_ok("diff", "--cached", "--name-only", "-z").split("\0") if p]


def is_bead(path):
    return path.startswith(".beads/")


def is_doc(path):
    return path.startswith("docs/") or path.endswith(".md")


def run(command, cwd=ROOT, env=None):
    print(f"commit gate: {' '.join(command)}", file=sys.stderr)
    return subprocess.run(command, cwd=cwd, env=env).returncode


def docs_row():
    status = run([sys.executable, "scripts/check_docs.py"])
    base = git_ok("merge-base", "HEAD", "origin/main").strip()
    return status or run([sys.executable, "scripts/check_docs.py", "--drift", base])


def typecheck():
    env = {**os.environ, "npm_config_offline": "true"}
    return run(["npm", "run", "typecheck"], cwd=ROOT / "desktop/web", env=env)


def pre_commit():
    paths = staged()
    if all(is_bead(p) for p in paths):
        return 0
    if all(is_bead(p) or is_doc(p) for p in paths):
        return docs_row()
    return typecheck()


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    if mode == "pre-commit":
        try:
            return 1 if pre_commit() else 0
        except GitFailed as error:
            print(f"commit gate: {error}; refusing the commit (fetch origin/main if it is missing)", file=sys.stderr)
            return 1
    if mode in ("commit-msg", "pre-merge-commit"):
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
