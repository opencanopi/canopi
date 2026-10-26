"""The test-deletion guard the commit gate runs on each commit (contracts §12; ADR 0028; 2.1-Q224, 2.1-M199, 2.1-M229).

Named so `unittest discover`'s test_*.py pattern never imports it. It reads tests by regex over a commit's base and head
text, for TS/TSX tests and Playwright specs (`it`/`test` titles), Rust `#[test]` functions and Python `test_` methods:

- a title gone at head that no changed file re-adds (a move, in any file, passes with no trailer) needs a route: the
  message quotes ('…', "…", `…`) the title of a test the commit adds, which replaces that one deleted test (in its own
  file first) with no fewer assertions; or it cites a merge-base Q row; or it carries `Retires-test: <title> — <why>`
  while the commit deletes code under test (code_under_test) (gate-test-deleted);
- `Rewords-test: <old> -> <new>` passes a reworded title in the same file with no fewer assertions; without it, or in
  another file or with fewer assertions, the reword is refused (gate-test-reworded);
- in a kept test, unless the message cites a merge-base Q row or retires it: fewer expect or assert calls, a matcher
  swap from the closed list, or a new skip (gate-test-loosened). A new skip carrying `flake-quarantine: <bead>` passes
  when the commit adds that open bead's entry for the file to the flake-quarantine family (2.1-Q242).

`vitest list --json --staticParse=false` (titles from `.each` and template literals) runs once per PR in CI, base
against head, from scripts/commit_gate.py's vitest_pass; this module holds the per-commit reading and vitest_titles.
"""
from collections import Counter
import json
from pathlib import Path
import posixpath
import re
import subprocess

TEST_FILE = re.compile(r"\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|/)(?:e2e|e2e-release|__tests__)/.*\.[cm]?[jt]sx?$"
                       r"|(?:^|/)test_[^/]*\.py$|\.rs$")
JS = re.compile(r"\.[cm]?[jt]sx?$")
JS_TEST = re.compile(r"""(?<![\w.$])(?:it|test)(?:\.(?:only|skip|fixme|todo|fails|concurrent|sequential|each\([^)]*\)"""
                     r"""|skipIf\([^)]*\)|runIf\([^)]*\)))*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1""")
RUST_TEST = re.compile(r"#\[(?:[\w:]+::)?test\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)")
PY_TEST = re.compile(r"^\s*def\s+(test_\w+)\s*\(", re.MULTILINE)
ASSERTS = {
    "js": re.compile(r"(?<![\w.$])expect(?:\.soft|\.poll)?\s*\(|(?<![\w.$])assert(?:\.\w+)?\s*\("),
    "rs": re.compile(r"\b(?:debug_)?(?:prop_)?assert(?:_eq|_ne|_matches)?!\s*[(\[{]"),
    "py": re.compile(r"\bself\.assert\w+\s*\(|^\s*assert\b", re.MULTILINE),
}
# The closed matcher-swap list (2.1-M199): (strict, looser) counted per test.
SWAPS = [
    (r"\.toStrictEqual\(", r"\.toEqual\("), (r"\.toEqual\(", r"\.toMatchObject\("),
    (r"\.toBe\((?!\))", r"\.toBe(?:Truthy|Defined)\(\)"), (r"\.toHaveBeenCalledWith\(", r"\.toHaveBeenCalled\(\)"),
    (r"\.toThrow\((?!\))", r"\.toThrow\(\)"), (r"\bassert_eq!", r"\bassert!"), (r"\.assertEqual\(", r"\.assertTrue\("),
]
SKIPS = re.compile(r"(?<![\w$])(?:it|test|describe)\.(?:skip|fixme|todo)\b|\.skipIf\(|#\[ignore\b|@unittest\.skip"
                   r"|@pytest\.mark\.skip")
FLAKE = re.compile(r"flake-quarantine:[ \t]*(canopi-[a-z0-9]+(?:\.[0-9]+)*)?")
RETIRES = re.compile(r"^Retires-test:\s*(.+?)\s+(?:—|--)\s+\S", re.MULTILINE)
REWORDS = re.compile(r"^Rewords-test:\s*(.+?)\s+->\s+(.+?)\s*$", re.MULTILINE)
RUST_TEST_ITEM = re.compile(r"#\[cfg\(test\)\]|" + RUST_TEST.pattern)
# A Playwright spec or a Rust integration test covers its package's src/, which it never imports relatively.
OUTSIDE = re.compile(r"^((?:.*/)?)(?:e2e|e2e-release|tests)/")
IMPORT = re.compile(r"""(?:from|import|require\(|import\()\s*['"](\.{1,2}/[^'"]+)['"]""")


def quoted(title, message):
    """Whether `message` names `title` in quotes: a title that merely occurs in a sentence names nothing."""
    return bool(re.search(r"['\"`\u2018\u201c]" + re.escape(title) + r"['\"`\u2019\u201d]", message))


def is_test_file(path):
    return bool(path and TEST_FILE.search(path))


def language(path):
    return "js" if JS.search(path) else "rs" if path.endswith(".rs") else "py"


def tests(path, text):
    """{title: [body, ...]} for each test in `text`: a call's balanced parentheses (TS), a function's braces (Rust), a
    method's indented block (Python)."""
    if not text:
        return {}
    kind = language(path)
    pattern = JS_TEST if kind == "js" else RUST_TEST if kind == "rs" else PY_TEST
    found = {}
    for match in pattern.finditer(text):
        title = match.group(2) if kind == "js" else match.group(1)
        found.setdefault(title, []).append(body(kind, text, match))
    return found


def body(kind, text, match):
    if kind == "py":
        indent = len(match.group(0)) - len(match.group(0).lstrip())
        lines = text[match.end():].split("\n")
        end = next((i for i, line in enumerate(lines[1:], 1)
                    if line.strip() and len(line) - len(line.lstrip()) <= indent), len(lines))
        return "\n".join(lines[:end])
    start = match.end() if kind == "js" else text.find("{", match.end())
    depth, i, quote = 1 if kind == "js" else 0, start, None
    while i < len(text):
        c = text[i]
        if quote:
            i += 2 if c == "\\" else 1
            quote = None if c == quote else quote
            continue
        if text.startswith("//", i):
            newline = text.find("\n", i)
            i = len(text) if newline == -1 else newline
            continue
        if c in "\"`" or (c == "'" and kind == "js"):
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return text[start:]


def asserts(path, bodies):
    return sum(len(ASSERTS[language(path)].findall(body)) for body in bodies)


def swaps(bodies_before, bodies_after):
    before, after = "".join(bodies_before), "".join(bodies_after)
    return [f"{strict} to {loose}".replace("\\", "") for strict, loose in SWAPS
            if len(re.findall(strict, after)) < len(re.findall(strict, before))
            and len(re.findall(loose, after)) > len(re.findall(loose, before))]


def flake_markers(text):
    """The beads named by `flake-quarantine:` markers in `text`; a marker naming no bead is None."""
    return [m.group(1) for m in FLAKE.finditer(text or "")]


def imported(path, text):
    """Repository paths (without extension) a test file's relative imports name."""
    base = posixpath.dirname(path)
    return {re.sub(r"\.[cm]?[jt]sx?$", "", posixpath.normpath(posixpath.join(base, spec))) for spec in IMPORT.findall(text or "")}


def code_lines(path, text):
    """A file's non-test lines: none for a test file, a Rust file's lines outside its #[cfg(test)] items and #[test]
    functions."""
    if not text or (is_test_file(path) and not path.endswith(".rs")):
        return Counter()
    if path.endswith(".rs"):
        kept, end = [], 0
        for match in RUST_TEST_ITEM.finditer(text):
            if match.start() < end:
                continue
            brace, semicolon = text.find("{", match.end()), text.find(";", match.end())
            stop = semicolon + 1 if semicolon != -1 and (brace == -1 or semicolon < brace) else \
                brace + len(body("rs", text, match)) if brace != -1 else len(text)
            kept.append(text[end:match.start()])
            end = stop
        text = "".join(kept) + text[end:]
    return Counter(line.strip() for line in text.splitlines() if line.strip())


def deletes_code(path, old_text, new_text):
    """Whether a change to `path` removes non-test code (code_lines)."""
    return bool(code_lines(path, old_text) - code_lines(path, new_text))


def code_under_test(path, text, deleted_code):
    """Whether code was deleted from a module the test imported or sat beside, or for a Playwright spec or a Rust
    integration test (OUTSIDE), from its package's src/."""
    names = imported(path, text)
    outside = OUTSIDE.match(path)
    for other in deleted_code:
        if outside and other.startswith(f"{outside.group(1)}src/"):
            return True
        stem = re.sub(r"\.[cm]?[jt]sx?$", "", other)
        if posixpath.dirname(other) == posixpath.dirname(path) or stem in names or stem.removesuffix("/index") in names:
            return True
    return False


def judge(files, message, *, authorised, deleted_code, quarantined, bead_open):
    """Findings [(rule, text)] for one commit.

    files: [(base path or None, head path or None, base text, head text)] for each changed test file (a rename keeps
    both paths); authorised: the message cites a merge-base Q row; deleted_code: paths the commit removes code_lines
    from; quarantined: {path: bead} entries the commit adds or raises in flake-quarantine; bead_open(bead) -> bool.
    """
    before, after = Counter(), Counter()
    where_before, where_after, parsed = {}, {}, []
    for old, new, old_text, new_text in files:
        was, now = tests(old, old_text) if old else {}, tests(new, new_text) if new else {}
        parsed.append((old, new, old_text, new_text, was, now))
        for title, bodies in was.items():
            before[title] += len(bodies)
            where_before.setdefault(title, (old, bodies, old_text))
        for title, bodies in now.items():
            after[title] += len(bodies)
            where_after.setdefault(title, (new, bodies))
    deleted = [t for t in before if after[t] < before[t]]
    added = [t for t in after if before[t] < after[t]]
    replacements = [t for t in added if quoted(t, message)]
    retired = {m.strip() for m in RETIRES.findall(message)}
    findings = []
    reworded, used = set(), set()
    for old_title, new_title in REWORDS.findall(message):
        old_title, new_title = old_title.strip(), new_title.strip()
        if old_title not in deleted or new_title not in added:
            findings.append(("gate-test-reworded", f"Rewords-test: {old_title} -> {new_title} names no deleted and added pair"))
            continue
        (old_path, old_bodies, _), (new_path, new_bodies) = where_before[old_title], where_after[new_title]
        same_file = new_path in {old_path} | {n for o, n, *_ in files if o == old_path}
        if not same_file or asserts(new_path, new_bodies) < asserts(old_path, old_bodies):
            why = "moves it to another file" if not same_file else "has fewer assertions"
            findings.append(("gate-test-reworded", f"'{old_title}' -> '{new_title}' {why}; that is a deletion"))
        reworded |= {old_title, new_title}
    for title in deleted:
        if title in reworded or authorised:
            continue
        path, bodies, text = where_before[title]
        if title in retired:
            if code_under_test(path, text, deleted_code):
                continue
            findings.append(("gate-test-deleted", f"{path}: Retires-test: {title} deletes no code the test imported or sat beside"))
            continue
        free = [t for t in replacements if t not in reworded | used]
        if free:
            new = next((t for t in free if where_after[t][0] == path), free[0])
            used.add(new)
            new_path, new_bodies = where_after[new]
            if asserts(new_path, new_bodies) < asserts(path, bodies):
                findings.append(("gate-test-deleted", f"{path}: '{title}' is replaced by '{new}', which has fewer "
                                                      "assertions: that is a deletion"))
            continue
        rewords = [t for t in added if t not in reworded and t not in used and where_after[t][0] == path]
        if rewords:
            findings.append(("gate-test-reworded", f"{path}: '{title}' looks reworded to '{rewords[0]}': add "
                                                   f"Rewords-test: {title} -> {rewords[0]}"))
        else:
            findings.append(("gate-test-deleted", f"{path}: '{title}' is deleted with no route: quote its replacement "
                                                  "test's title, cite a merge-base Q row, or add Retires-test: <title> — "
                                                  "<why> and delete its code"))
    for old, new, old_text, new_text, was, now in parsed:
        if not (old and new):
            continue
        for title in sorted(set(was) & set(now)):
            if authorised or title in retired:
                continue
            less = asserts(new, now[title]) < asserts(old, was[title])
            for why in (["fewer expect or assert calls"] if less else []) + swaps(was[title], now[title]):
                findings.append(("gate-test-loosened", f"{new}: '{title}': {why}"))
        new_skips = len(SKIPS.findall(new_text)) - len(SKIPS.findall(old_text))
        if new_skips <= 0 or authorised:
            continue
        markers = Counter(flake_markers(new_text)) - Counter(flake_markers(old_text))
        good = [b for b in markers.elements() if b and bead_open(b) and quarantined.get(new) == b]
        if len(good) < new_skips:
            findings.append(("gate-test-loosened", f"{new}: {new_skips} new skip(s) without a route: a skip carries "
                                                   "`flake-quarantine: <open bead>` and the commit adds that bead's "
                                                   "flake-quarantine entry for this file, or the message cites a merge-base Q row"))
    return findings


def vitest_titles(web, files, out):
    """([(full test name, file relative to `web`)] across `files`, the files vitest could not list): one run, then one
    per file on a failure."""
    def listed(batch):
        result = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "list", "--staticParse=false", f"--json={out}",
                                 *batch], cwd=web, capture_output=True, text=True)
        if result.returncode != 0 or not out.exists():
            return None
        names = [(entry["name"], Path(entry["file"]).relative_to(web.resolve()).as_posix())
                 for entry in json.loads(out.read_text(encoding="utf-8"))]
        out.unlink()
        return names
    if not files:
        return [], []
    names = listed(files)
    if names is not None:
        return names, []
    names, unread = [], []
    for file in files:
        one = listed([file])
        names, unread = (names + one, unread) if one is not None else (names, unread + [file])
    return names, unread
