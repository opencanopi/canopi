#!/usr/bin/env python3
"""Fails for a Playwright image tag that differs from the locked @playwright/test version (AF23).

    python3 scripts/check_playwright_pins.py        check the repository
    python3 -m unittest scripts.test_check_playwright_pins

Browser baselines are made only in the mcr.microsoft.com/playwright image whose tag
is the @playwright/test version in desktop/web/package-lock.json; the browsers in
any other image drift from the installed test runner. Every image literal in a
tracked file (workflows, configs, scripts, READMEs) must name that version.
History is not read: .beads/ and docs/decisions/ record past tags on purpose.
A script that can read the lockfile does so instead of holding a literal.
Stdlib and git only.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCKFILE = "desktop/web/package-lock.json"
PACKAGE = "node_modules/@playwright/test"
IMAGE = re.compile(r"mcr\.microsoft\.com/playwright:v(\d+\.\d+\.\d+)")
# Records of past decisions and work, whose old tags are history, not pins.
HISTORY = (".beads", "docs/decisions")


def locked_version(root: Path) -> str:
    lock = json.loads((root / LOCKFILE).read_text(encoding="utf-8"))
    version = lock.get("packages", {}).get(PACKAGE, {}).get("version")
    if not version:
        raise SystemExit(f"{LOCKFILE} locks no @playwright/test version")
    return version


def check(root: Path) -> list[str]:
    """One problem per image literal whose tag is not the locked version."""
    version = locked_version(root)
    excludes = [f":(exclude){path}" for path in HISTORY]
    result = subprocess.run(
        ["git", "-C", str(root), "grep", "-n", "-I", "-E", IMAGE.pattern.replace(r"\d", "[0-9]"), "--", ".", *excludes],
        capture_output=True, text=True, check=False,
    )
    if result.returncode not in (0, 1):
        raise SystemExit(f"git grep failed: {result.stderr.strip()}")
    problems = []
    for line in result.stdout.splitlines():
        path, number, text = line.split(":", 2)
        for tag in IMAGE.findall(text):
            if tag != version:
                problems.append(f"{path}:{number}: playwright image v{tag}, but {LOCKFILE} locks @playwright/test {version}")
    return problems


def main() -> int:
    problems = check(ROOT)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print("Use the locked version in every copy (or read it from the lockfile).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
