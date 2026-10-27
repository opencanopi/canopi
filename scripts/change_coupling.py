#!/usr/bin/env python3
"""Change coupling and hotspots from git history, for the architecture review.

    python3 scripts/change_coupling.py [--since DATE|REF] [--top N] [--max-files N]
    python3 -m unittest scripts.test_change_coupling

Imports show static links; files that keep changing in the same commits show
the coupling that costs work. Three tables, in Markdown:
- files in different areas that change together: shared commits and the
  degree (shared / the rarer file's changes; 1.0 means the rarer file never
  changed alone);
- area pairs by shared commits;
- hotspots: changes times current line count.
An area is the owning folder (`web/app/lidar`, `desktop/services/lidar`,
`common-types`; the rest of desktop/web is `web-tooling/<folder>`, the rest of
desktop is `desktop-root`); a folder and its own subfolder are one area for
pairing. Docs, tracker files, locale and lock JSON, tests, generated files and
snapshots are not counted (CSS and contract JSON are): they change with everything and say nothing about
code structure. Merge commits and commits touching more than --max-files
counted files (mass renames, formatting) are skipped, and the skip count is
printed so the cut is never silent. Stdlib only.
"""

from __future__ import annotations

import argparse
import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

NOT_COUNTED = (
    re.compile(r"^(docs|\.beads|\.interface-design|\.github)/"),
    re.compile(r"\.(md|jsonl|lock|snap|png|svg)$"),
    re.compile(r"(^|/)(i18n/.*|package-lock|tsconfig[^/]*)\.json$"),
    re.compile(r"(^|/)(__tests__|e2e|tests|generated)/"),
    re.compile(r"\.(test|spec)\.tsx?$"),
    re.compile(r"(_tests|/tests)\.rs$"),
    # Ratchet baselines, planted violations and scenarios: data a code change produces, like snapshots.
    re.compile(r"^policy/(ratchets|fixtures|scenarios)/"),
)


def counted(path: str) -> bool:
    """Whether a changed path is code that says something about structure."""
    return not any(rule.search(path) for rule in NOT_COUNTED)


def area(path: str) -> str:
    """The owning folder: two folder levels under a source root, else a named root."""
    for root, label in (("desktop/web/src/", "web"), ("desktop/src/", "desktop")):
        if path.startswith(root):
            folders = path[len(root):].split("/")[:-1][:2]
            return "/".join([label, *folders])
    if path.startswith("desktop/web/"):
        rest = path[len("desktop/web/"):].split("/")
        return "web-tooling" + (f"/{rest[0]}" if len(rest) > 1 else "")
    if path.startswith("desktop/"):
        return "desktop-root"
    return path.split("/", 1)[0]


def nested(a: str, b: str) -> bool:
    """Whether one area holds the other (web/canvas and web/canvas/runtime): not a cross-area link."""
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


@dataclass(frozen=True)
class Pair:
    a: str
    b: str
    shared: int
    degree: float


@dataclass
class Report:
    pairs: list[Pair]
    area_pairs: Counter
    hotspots: list[tuple[str, int, int, int]]
    commits: int
    skipped: int = 0


def commits(repo: Path, since: str | None) -> list[list[str]]:
    args = ["git", "-C", str(repo), "-c", "core.quotepath=off", "log", "--no-merges", "--name-only", "--format=format:@@"]
    if since:
        args += [f"{since}..HEAD"] if not re.match(r"^\d{4}-\d{2}-\d{2}$", since) else [f"--since={since}"]
    out = subprocess.run(args, check=True, capture_output=True, text=True).stdout
    return [[line for line in chunk.splitlines() if line.strip()] for chunk in out.split("@@")[1:]]


def analyse(repo: Path, since: str | None, max_files: int = 40) -> Report:
    changes: Counter = Counter()
    together: Counter = Counter()
    area_pairs: Counter = Counter()
    kept = skipped = 0
    for files in commits(repo, since):
        code = sorted({f for f in files if counted(f)})
        if not code:
            continue
        if len(code) > max_files:
            skipped += 1
            continue
        kept += 1
        changes.update(code)
        for a, b in combinations(code, 2):
            if not nested(area(a), area(b)):
                together[(a, b)] += 1
        for x, y in combinations(sorted({area(f) for f in code}), 2):
            if not nested(x, y):
                area_pairs[(x, y)] += 1
    pairs = [
        Pair(a, b, n, n / min(changes[a], changes[b]))
        for (a, b), n in together.items()
        if n >= 2
    ]
    pairs.sort(key=lambda p: (-p.shared * p.degree, p.a, p.b))
    hotspots = []
    for path, n in changes.items():
        file = repo / path
        lines = sum(1 for _ in file.open(errors="replace")) if file.is_file() else 0
        if lines:
            hotspots.append((path, n, lines, n * lines))
    hotspots.sort(key=lambda h: (-h[3], h[0]))
    return Report(pairs, area_pairs, hotspots, kept, skipped)


def render(report: Report, top: int) -> str:
    out = [
        f"Commits counted: {report.commits}; skipped as mass edits: {report.skipped}.",
        "",
        "## Files that change together across areas",
        "",
        "| Shared | Degree | File | File |",
        "|---:|---:|---|---|",
    ]
    out += [f"| {p.shared} | {p.degree:.2f} | `{p.a}` | `{p.b}` |" for p in report.pairs[:top]]
    out += ["", "## Areas that change together", "", "| Shared commits | Area | Area |", "|---:|---|---|"]
    out += [f"| {n} | {a} | {b} |" for (a, b), n in report.area_pairs.most_common(top)]
    out += ["", "## Hotspots", "", "| Changes | Lines | Changes × lines | File |", "|---:|---:|---:|---|"]
    out += [f"| {n} | {lines} | {score} | `{path}` |" for path, n, lines, score in report.hotspots[:top]]
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--since", help="a date (YYYY-MM-DD) or a git ref; default: all history")
    parser.add_argument("--top", type=int, default=30)
    parser.add_argument("--max-files", type=int, default=40)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    print(render(analyse(repo, args.since, args.max_files), args.top), end="")


if __name__ == "__main__":
    main()
