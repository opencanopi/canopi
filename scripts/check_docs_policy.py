"""Decision-ledger and policy-table checks, called from check_docs.py (2.1-M226: new checks in sibling modules).

A decision ledger (docs/decisions/<release>.md) is the one append-only document: each row is a dated user
decision and names what implements it. `ledger_rows` is its one row reader; the ledger checks here and the
commit gate read rows through it.

- `check_ledger`: each row's shape (id of the file's release, date, implementation, cited ADRs exist).
- `ledger_drift` (`--drift`, 2.1-M194): every row of the base ledger is still there, matched by id, with its id,
  date, decision and user's words unchanged; its supersedes and implemented-by cells may be re-joined or extended
  but keep every id and ADR they cited.
"""

import re
import subprocess

# The columns every ledger table needs, and the ones whose cells never change once a row lands.
LEDGER_COLUMNS = ("id", "date", "implemented by")
FROZEN_COLUMNS = ("date", "decision", "user's words")
CITING_COLUMNS = ("supersedes / superseded by", "implemented by")
LEDGER_ID = re.compile(r"^\d+\.\d+-[A-Z]+\d+[a-z]?$")
LEDGER_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LEDGER_RELEASE = re.compile(r"^(\d+)-(\d+)$")
LEDGER_DIR = "docs/decisions"
# "ADR 0026", and lists such as "ADRs 0022, 0023 and 0030" or "ADRs 0015 to 0020".
ADR_CITATION = re.compile(r"\bADRs? (\d{4}(?:(?:, |,? and | to )\d{4})*)\b")
# A full id names its release (2.1-Q45, 2.1-Q35r); a short one (Q45) is read only inside a ledger row, where
# the file names the release: contract ids such as M0, F1 or R2 elsewhere are not ledger ids.
FULL_ID = re.compile(r"(?<![\w.])(\d+\.\d+-[EMQ]\d+[a-z]?)(?!\w)")
SHORT_ID = re.compile(r"(?<![\w.])([EMQ]\d+[a-z]?)(?!\w)")


class BaseNotFound(Exception):
    """The --drift base ref does not resolve to a commit."""

    def __init__(self, base):
        super().__init__(f"base {base} not found")


def prose(text):
    """`text` with fenced code blocks blanked, line numbers kept."""
    lines = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = None
            lines.append("")
        elif marker:
            fence = marker[1]
            lines.append("")
        else:
            lines.append(line)
    return "\n".join(lines)


def ledger_table(text):
    """Each table line of a ledger after its header: (line number, lower-cased header, cells). A header lacking a
    LEDGER_COLUMNS column yields once with cells None, and its rows are skipped."""
    header, skip = None, False
    for number, line in enumerate(prose(text).splitlines(), start=1):
        if not line.lstrip().startswith("|"):
            header, skip = None, False
            continue
        if skip:
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if header is None:
            header = [cell.lower() for cell in cells]
            if any(column not in header for column in LEDGER_COLUMNS):
                skip = True
                yield number, header, None
            continue
        if not all(set(cell) <= set("-: ") for cell in cells):
            yield number, header, cells


def ledger_rows(text):
    """The ledger's rows by id: {id: {column: cell}}; a duplicate id keeps its first row."""
    rows = {}
    for _, header, cells in ledger_table(text):
        if cells is not None and len(cells) == len(header):
            row = dict(zip(header, cells))
            rows.setdefault(row.get("id", ""), row)
    return rows


def release_prefix(name):
    """'2.1-' for a ledger file named 2-1.md, else None."""
    release = LEDGER_RELEASE.match(name.rsplit("/", 1)[-1].removesuffix(".md"))
    return f"{release[1]}.{release[2]}-" if release else None


def adr_citations(text):
    return {adr for group in ADR_CITATION.findall(text) for adr in re.findall(r"\d{4}", group)}


def check_ledger(file, root):
    """Every ledger row has a unique id of the file's release, a date and an implementation, and each ADR any cell cites exists."""
    errors = []
    relative = file.relative_to(root).as_posix()
    adrs = {path.name[:4] for path in (root / "docs/adr").glob("[0-9][0-9][0-9][0-9]-*.md")}
    prefix = release_prefix(file.name)
    seen, rows, bad_tables = set(), 0, 0
    for number, header, cells in ledger_table(file.read_text(encoding="utf-8")):
        if cells is None:
            errors.append(f"{relative}:{number}: a ledger table needs the columns {', '.join(LEDGER_COLUMNS)}")
            bad_tables += 1
            continue
        rows += 1
        if len(cells) != len(header):
            errors.append(f"{relative}:{number}: row has {len(cells)} cells, the header {len(header)}")
            continue
        row = dict(zip(header, cells))
        ident = row.get("id", "")
        if not LEDGER_ID.match(ident):
            errors.append(f"{relative}:{number}: ledger id {ident!r} is not <release>-<letter><number>")
        elif prefix and not ident.startswith(prefix):
            errors.append(f"{relative}:{number}: ledger id {ident} is not of this file's release {prefix[:-1]}")
        elif ident in seen:
            errors.append(f"{relative}:{number}: duplicate ledger id {ident}")
        seen.add(ident)
        if not LEDGER_DATE.match(row.get("date", "")):
            errors.append(f"{relative}:{number}: {ident} has no YYYY-MM-DD date")
        if not row.get("implemented by", ""):
            errors.append(f"{relative}:{number}: {ident} names no implementation")
        cited = {adr for cell in cells for adr in adr_citations(cell)}
        for adr in sorted(cited - adrs):
            errors.append(f"{relative}:{number}: {ident} cites ADR {adr}, which does not exist")
    if not rows and not bad_tables:
        errors.append(f"{relative}: a decision ledger needs a table of decisions")
    return errors


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def resolve_base(root, base):
    """The commit `base` names; BaseNotFound when it names none."""
    found = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"], cwd=root, capture_output=True, text=True
    )
    if found.returncode:
        raise BaseNotFound(base)
    return found.stdout.strip()


def cited(cell, prefix):
    """The ledger ids and ADRs a cell cites, short ids resolved to the row's release."""
    full = set(FULL_ID.findall(cell))
    short = {f"{prefix}{ident}" for ident in SHORT_ID.findall(FULL_ID.sub(" ", cell))} if prefix else set()
    return full | short | {f"ADR {adr}" for adr in adr_citations(cell)}


def tree_ledgers(root, commit):
    """{path: text} of the ledgers at `commit`, or in the working tree when `commit` is None."""
    if commit is None:
        return {path.relative_to(root).as_posix(): path.read_text(encoding="utf-8") for path in sorted((root / LEDGER_DIR).glob("*.md"))}
    paths = git(root, "ls-tree", "--name-only", commit, f"{LEDGER_DIR}/").splitlines()
    return {path: git(root, "show", f"{commit}:{path}") for path in paths if path.endswith(".md")}


def ledger_drift(root, base, head=None):
    """Rows of the ledgers at the merge base of `base` and `head` (HEAD) that the head ledgers (the working tree
    when `head` is None) deleted or edited (2.1-M194)."""
    resolve_base(root, base)
    merge_base = git(root, "merge-base", base, head or "HEAD").strip()
    before = {(path, ident): row for path, text in tree_ledgers(root, merge_base).items() for ident, row in ledger_rows(text).items()}
    after = {ident: row for text in tree_ledgers(root, head).values() for ident, row in ledger_rows(text).items()}
    errors = []
    for (path, ident), row in before.items():
        if ident not in after:
            errors.append(f"{path}: {ident} was deleted or its id edited; ledger rows are append-only (2.1-M194)")
            continue
        now = after[ident]
        for column in FROZEN_COLUMNS:
            if column in row and " ".join(row[column].split()) != " ".join(now.get(column, "").split()):
                errors.append(f"{path}: {ident} {column} cell was edited; a changed decision is a new row (2.1-M194)")
        prefix = release_prefix(path)
        for column in CITING_COLUMNS:
            for reference in sorted(cited(row.get(column, ""), prefix) - cited(now.get(column, ""), prefix)):
                errors.append(f"{path}: {ident} {column} no longer cites {reference} (2.1-M194)")
    return errors

