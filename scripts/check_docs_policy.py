"""Decision-ledger and policy-table checks, called from check_docs.py (2.1-M226: new checks in sibling modules).

A decision ledger (docs/decisions/<release>.md) is the one append-only document: each row is a dated user
decision and names what implements it. `ledger_rows` is its one row reader; the ledger checks here and the
commit gate read rows through it.

- `check_ledger`: each row's shape (id of the file's release, date, implementation, cited ADRs exist).
- `ledger_drift` (`--drift`, 2.1-M194): every row of the base ledger is still there, matched by id, with its id,
  date, decision and user's words unchanged; its supersedes and implemented-by cells may be re-joined or extended
  but keep every id and ADR they cited.
- `missing_ids` (DR22): every full id in the tracked text, and every short id inside a ledger row, is a row.
- `check_suites` (2.1-M193): policy/suites.json rows name an existing test or a planned phase and bead.
- `check_owner_headers` (2.1-Q212): each file owner policy/primitives.json or policy/layers.json names opens with an
  `Owner of` header naming each rule it owns and an ADR; a file claiming `Owner of` is such an owner.
"""

import json
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


def ledger_ids(root):
    return {ident for path in (root / LEDGER_DIR).glob("*.md") for ident in ledger_rows(path.read_text(encoding="utf-8"))}


def missing_ids(root):
    """Ids no ledger row holds (DR22): a full id in any tracked text file, a short id inside a ledger row (read as
    its file's release). Binary files are skipped."""
    known = ledger_ids(root)
    found = []
    # git grep reads the tracked files of the working tree; -I skips binaries; exit 1 is no match.
    grep = subprocess.run(
        ["git", "grep", "-z", "-n", "-I", "-E", r"[0-9]+\.[0-9]+-[EMQ][0-9]"], cwd=root, capture_output=True, text=True
    )
    if grep.returncode > 1:
        raise RuntimeError(grep.stderr.strip())
    for line in grep.stdout.splitlines():
        path, number, text = line.split("\0", 2)
        found.extend((path, int(number), ident, ident) for ident in FULL_ID.findall(text))
    for path in sorted((root / LEDGER_DIR).glob("*.md")):
        prefix = release_prefix(path.name)
        if not prefix:
            continue
        for number, _, cells in ledger_table(path.read_text(encoding="utf-8")):
            for cell in cells or ():
                found.extend((path.relative_to(root).as_posix(), number, f"{ident} ({prefix}{ident})", f"{prefix}{ident}") for ident in SHORT_ID.findall(FULL_ID.sub(" ", cell)))
    found.sort(key=lambda site: site[:2])
    return [f"{path}:{number}: {shown} is in no decision ledger" for path, number, shown, ident in found if ident not in known]


SUITES = "policy/suites.json"
RULES = "policy/rules.json"


def check_suites(root):
    """The contract-suite registry (contracts §13, 2.1-M193), a hand-edited table: each row's test exists, or the
    row is planned for a policy/rules.json phase with a bead."""
    path = root / SUITES
    if not path.is_file():
        return [f"{SUITES}: missing; the contract-suite registry (2.1-M193)"]
    try:
        table = json.loads(path.read_text(encoding="utf-8"))
        phases = set(json.loads((root / RULES).read_text(encoding="utf-8")).get("phases", []))
    except (OSError, ValueError) as error:
        return [f"{SUITES}: unreadable with {RULES}: {error}"]
    if "rules" in table:
        return [f"{SUITES}: a top-level `rules` key would be read as a rule table (check.mjs loadTableRules)"]
    errors, seen = [], set()
    for row in table.get("suites", []):
        ident = row.get("id")
        if ident in seen:
            errors.append(f"{SUITES}: duplicate suite {ident}")
        seen.add(ident)
        if not row.get("sides"):
            errors.append(f"{SUITES}: suite {ident} names no sides")
        test, planned = row.get("test"), row.get("planned")
        if bool(test) == bool(planned):
            errors.append(f"{SUITES}: suite {ident} needs a test path or planned{{phase, bead}}")
        elif test and not (root / test).is_file():
            errors.append(f"{SUITES}: suite {ident} names test {test}, which does not exist")
        elif planned and planned.get("phase") not in phases:
            errors.append(f"{SUITES}: suite {ident} plans phase {planned.get('phase')}, which is not in {RULES} phases")
        elif planned and not planned.get("bead"):
            errors.append(f"{SUITES}: suite {ident} plans no bead")
    if not table.get("suites"):
        errors.append(f"{SUITES}: no suites")
    return errors


PRIMITIVES = "policy/primitives.json"
LAYERS = "policy/layers.json"
SOURCE = "desktop/web/src"
ADR_NUMBER = re.compile(r"\bADRs? \d{4}\b")
COMMENT_LINE = re.compile(r"^\s*(//|/\*|\*)")


def leading_comment(text):
    """The comment block a module opens with: its lines up to the first line of code (blank lines kept)."""
    lines = []
    for line in text.splitlines():
        if line.strip() and not COMMENT_LINE.match(line):
            break
        lines.append(line)
    return "\n".join(lines)


def file_owners(root):
    """{path: (rule ids, tables)} for every file (never a directory: 2.1-Q212) the policy tables name an owner:
    primitives.json rows' owner_today and also_owners and held entries' owner_today (with the rule id a held entry
    checks), layers.json layer rows with an owner and package rows' owner paths and globs."""
    owners = {}

    def add(path, rule, table):
        if path and path != "none" and (root / path).is_file():
            rules, tables = owners.setdefault(path, (set(), set()))
            if rule:
                rules.add(rule)
            tables.add(table)

    try:
        primitives = json.loads((root / PRIMITIVES).read_text(encoding="utf-8")) if (root / PRIMITIVES).is_file() else {}
        layers = json.loads((root / LAYERS).read_text(encoding="utf-8")) if (root / LAYERS).is_file() else {}
    except ValueError:
        return owners
    for row in primitives.get("rules", []):
        if row.get("status") == "planned":
            continue
        for path in [row.get("owner_today"), *row.get("also_owners", [])]:
            add(path, row.get("id"), PRIMITIVES)
    for entry in primitives.get("held", []):
        check = entry.get("check", "")
        add(entry.get("owner_today"), None if "/" in check else check, PRIMITIVES)
    for row in layers.get("layers", []):
        if row.get("owner") and row.get("status") != "new":
            add(f"{SOURCE}/{row['path']}", None, LAYERS)
    for row in layers.get("packages", []):
        owned = row.get("owner")
        for pattern in owned if isinstance(owned, list) else [owned] if owned else []:
            for match in sorted((root / SOURCE).glob(pattern)):
                add(match.relative_to(root).as_posix(), row.get("rule"), LAYERS)
    return owners


def check_owner_headers(root):
    """2.1-Q212: module headers only on the owner modules the tables name (owner role, invariants, ADR), checked
    against the tables both ways."""
    owners = file_owners(root)
    errors = []
    for file in sorted((root / SOURCE).rglob("*.ts*")):
        path = file.relative_to(root).as_posix()
        if not path.endswith((".ts", ".tsx")):
            continue
        header = leading_comment(file.read_text(encoding="utf-8"))
        claims = "Owner of" in header
        if path not in owners:
            if claims:
                errors.append(f"{path}: claims `Owner of` but no row of {PRIMITIVES} or {LAYERS} names it an owner (2.1-Q212)")
            continue
        rules, tables = owners[path]
        if not claims:
            named = ", ".join(sorted(rules)) or "a module"
            errors.append(f"{path}: an owner module ({named} in {', '.join(sorted(tables))}) has no `Owner of` header naming its role, invariants and ADR (2.1-Q212)")
            continue
        errors.extend(f"{path}: its owner header names no rule {rule}" for rule in sorted(rules) if not re.search(rf"(?<![\w-]){re.escape(rule)}(?![\w-])", header))
        if not ADR_NUMBER.search(header):
            errors.append(f"{path}: its owner header names no ADR (ADR NNNN)")
    return errors


INVENTORY = "policy/inventory.json"
STATES = ("advice", "process")


class RegistryError(Exception):
    """`node policy/check.mjs --list-rules` could not give the rule registry."""


def list_rules(root):
    """The rule registry (2.1-M186): ({active ids}, {planned ids}) from `node policy/check.mjs --list-rules`, run on
    each call and never committed. A missing node or a non-zero exit raises RegistryError: never skipped."""
    try:
        run = subprocess.run(["node", "policy/check.mjs", "--list-rules"], cwd=root, capture_output=True, text=True)
    except FileNotFoundError:
        raise RegistryError("policy/check.mjs --list-rules: node is not installed; the inventory and rule-id checks need it (never skipped)") from None
    if run.returncode != 0:
        raise RegistryError(f"policy/check.mjs --list-rules exited {run.returncode}: the rule registry is unreadable, so no inventory or rule-id check ran")
    active, planned = set(), set()
    for line in run.stdout.splitlines():
        words = line.split()
        if len(words) == 2 and words[1] == "planned":
            planned.add(words[0])
        elif len(words) == 1:
            active.add(words[0])
    return active, planned


def json_file(root, name, default=None):
    path = root / name
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default


def check_inventory(root, phase_close=None, registry=None):
    """The policy inventory (contracts §12:541-542, ADR 0028:14, 2.1-M193): `{version: 1, rows}`, one row per rule
    the ADRs, guides and AGENTS.md state, `{id, doc, quote, state}`. Its quote is in its doc; its state is
    exists{check} (a bare id of --list-rules or an existing test or script path), planned{phase, bead} (a
    policy/rules.json phase, refused at `--phase-close` of that phase or a later one), advice or process; a primitive
    row is `{id, doc, quote}` and reads its state from policy/primitives.json, which must hold its id."""
    if not (root / INVENTORY).is_file():
        return [f"{INVENTORY}: missing; the policy inventory (2.1-M193)"]
    try:
        table = json_file(root, INVENTORY)
        phases = json_file(root, RULES, {}).get("phases", [])
        primitives = {row.get("id") for row in json_file(root, PRIMITIVES, {}).get("rules", [])}
    except ValueError as error:
        return [f"{INVENTORY}: unreadable with {RULES} and {PRIMITIVES}: {error}"]
    if "rules" in table:
        return [f"{INVENTORY}: rows live under `rows`, never `rules` (check.mjs would read them as rule rows)"]
    try:
        active, _ = registry or list_rules(root)
    except RegistryError as error:
        return [str(error)]
    errors, seen = [], set()
    if table.get("version") != 1 or not table.get("rows"):
        errors.append(f"{INVENTORY}: version is 1 and rows is a non-empty list")
    if phase_close is not None and phase_close not in phases:
        errors.append(f"{INVENTORY}: --phase-close {phase_close} is not one of the {RULES} phases")
    for row in table.get("rows", []):
        ident, doc, quote, state = row.get("id"), row.get("doc", ""), row.get("quote", ""), row.get("state")
        if ident in seen:
            errors.append(f"{INVENTORY}: duplicate row {ident}")
            continue
        seen.add(ident)
        if not (root / doc).is_file():
            errors.append(f"{INVENTORY}: {ident} names doc {doc or '(none)'}, which does not exist")
        elif not quote or quote not in (root / doc).read_text(encoding="utf-8"):
            errors.append(f"{INVENTORY}: {ident} quotes {json.dumps(quote)}, which {doc} no longer holds")
        if state is None:
            if ident not in primitives:
                errors.append(f"{INVENTORY}: {ident} has no state and is no {PRIMITIVES} row (a primitive row is {{id, doc, quote}})")
        elif state in STATES:
            continue
        elif isinstance(state, dict) and list(state) == ["exists"] and isinstance(state["exists"], dict):
            check = state["exists"].get("check", "")
            if check not in active and not (check and (root / check).is_file()):
                errors.append(f"{INVENTORY}: {ident} names check {check}, which is neither a rule in --list-rules nor an existing test or script")
        elif isinstance(state, dict) and list(state) == ["planned"] and isinstance(state["planned"], dict):
            phase, bead = state["planned"].get("phase"), state["planned"].get("bead")
            if phase not in phases:
                errors.append(f"{INVENTORY}: {ident} plans phase {phase}, which is not in {RULES} phases")
            elif not bead:
                errors.append(f"{INVENTORY}: {ident} plans no bead")
            elif phase_close in phases and phases.index(phase) <= phases.index(phase_close):
                errors.append(f"{INVENTORY}: {ident} is still planned at the close of phase {phase_close} (phase {phase}, {bead})")
        else:
            errors.append(f"{INVENTORY}: {ident} state is exists{{check}}, planned{{phase, bead}}, advice or process, not {json.dumps(state)}")
    return errors


# A rule id in prose (2.1-M189, A10, ADR 0022:60): a backticked kebab-case token in an ADR's `## Checks` section, or
# one a tool name precedes in its sentence. Left out: a crate (a workspace member, or a `(2.1)` crate of
# docs/architecture), an HTML data attribute, and oxlint's own lint names (a token after `oxlint` is a lint the
# `oxlint` family keys as `oxlint:<rule>`, never a policy id).
RULE_TOOLS = re.compile(r"(?<![\w-])(?:dependency-cruiser|ast-grep|clippy|knip|jscpd|cargo-deny)(?![\w-])")
RULE_TOKEN = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`")
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-Z`(])")
PLANNED_CRATE = re.compile(r"\b(canopi-[a-z0-9]+(?:-[a-z0-9]+)*) \(2\.1\)")


def known_crates(root):
    import tomllib

    names = set()
    try:
        members = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))["workspace"]["members"]
    except (OSError, KeyError, ValueError):
        members = []
    for member in members:
        manifest = root / member / "Cargo.toml"
        if manifest.is_file():
            names.add(tomllib.loads(manifest.read_text(encoding="utf-8")).get("package", {}).get("name"))
    for page in (root / "docs/architecture").glob("*.md"):
        names.update(PLANNED_CRATE.findall(page.read_text(encoding="utf-8")))
    return names


def rule_id_citations(root):
    """(doc, line, token) for each rule id the ADRs, guides and AGENTS.md name."""
    crates = known_crates(root)
    docs = sorted((root / "docs/adr").glob("*.md")) + sorted((root / "docs/guides").glob("*.md")) + [root / "AGENTS.md"]
    for doc in (d for d in docs if d.is_file()):
        in_checks = False
        for number, line in enumerate(prose(doc.read_text(encoding="utf-8")).splitlines(), 1):
            if line.startswith("#"):
                in_checks = doc.parent.name == "adr" and re.match(r"^##\s+Checks\s*$", line) is not None
                continue
            for sentence in SENTENCE_BREAK.split(line):
                for match in RULE_TOKEN.finditer(sentence):
                    token = match[1]
                    if token in crates or token.startswith("data-"):
                        continue
                    if in_checks or RULE_TOOLS.search(sentence[:match.start()]):
                        yield doc.relative_to(root).as_posix(), number, token


def check_rule_ids(root, registry=None):
    """Each rule id an ADR's Checks section or a tool-led sentence names is in `--list-rules`, active or planned."""
    try:
        active, planned = registry or list_rules(root)
    except RegistryError as error:
        return [str(error)]
    return sorted(
        f"{doc}:{line}: rule id {token} is not in policy/check.mjs --list-rules (add its rule row, planned until built)"
        for doc, line, token in rule_id_citations(root) if token not in active | planned
    )


def check_policy(root, phase_close=None):
    """The inventory and rule-id checks over one registry run; a registry failure is one error."""
    try:
        registry = list_rules(root)
    except RegistryError as error:
        return [str(error)]
    return check_inventory(root, phase_close, registry) + check_rule_ids(root, registry)
