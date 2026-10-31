"""Offline checks for repository Markdown links, ADR status, docs placement, decision ledgers and the architecture model.

Checks inline links/images, reference definitions, and Markdown heading fragments.
Fenced code, inline code, and external URLs are excluded. This is intentionally
not a full Markdown renderer or a network/link availability checker. Size budgets
warn and never fail.

    python3 scripts/check_docs.py                      # the checks; exit 1 on an error
    python3 scripts/check_docs.py --drift origin/main  # guides to reread (advice); exit 1 if a deleted
                                                       # plan's decision is in no ledger row or ADR, a
                                                       # ledger row was deleted or edited, or the base
                                                       # does not resolve

Each guide's `Covers:` line names the code it rules: paths, folders ending in
`/`, or `none`. A changed file belongs to the guide with the longest matching
path; `--drift` names guides whose code changed while the guide did not.
"""

import argparse
from pathlib import Path
import os
import re
import subprocess
import sys
import tomllib

try:
    from scripts.change_coupling import counted
    from scripts.check_docs_fields import check_class_fields
    from scripts.check_docs_model import check_layer_diagram
    from scripts.check_docs_policy import BaseNotFound, check_ledger, check_owner_headers, check_policy, check_suites, ledger_drift, ledger_rows, missing_ids, prose, resolve_base
    from scripts.check_docs_gates import check_gate_rows
except ModuleNotFoundError:
    from change_coupling import counted
    from check_docs_fields import check_class_fields
    from check_docs_model import check_layer_diagram
    from check_docs_policy import BaseNotFound, check_ledger, check_owner_headers, check_policy, check_suites, ledger_drift, ledger_rows, missing_ids, prose, resolve_base
    from check_docs_gates import check_gate_rows
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
ADR_STATES = {"proposed", "accepted", "superseded", "rejected", "deprecated"}
LINK = re.compile(r"\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)")
REFERENCE = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)", re.MULTILINE)
# The v2 documentation layout: anything else under docs/ is evidence or history
# that belongs in bd or nowhere.
DOCS_FILES = {"README.md", "architecture.md", "workflow.md", "review-checklist.md"}
DOCS_DIRECTORIES = {"adr", "architecture", "decisions", "guides", "plans", "release-notes"}
LINE_BUDGETS = {
    "AGENTS.md": 120,
    "README.md": 80,
    "CONTEXT.md": 250,
    "docs/README.md": 60,
    "docs/architecture.md": 160,
    "docs/workflow.md": 100,
    "docs/review-checklist.md": 200,
}
# A guide states rules and boundaries; wiring lives in code comments and policy
# tests. Budgets in bytes stop the guides from growing by accretion again.
BYTE_BUDGETS = {
    "AGENTS.md": 11_000,
    "CONTEXT.md": 17_000,
    "docs/README.md": 4_100,
    "docs/architecture.md": 12_000,
    "docs/workflow.md": 8_000,
    "docs/review-checklist.md": 12_000,
    "docs/release-notes/v2.0.0.md": 14_000,
    "docs/architecture/README.md": 8_000,
    "docs/architecture/abstractions.md": 24_000,
    ".interface-design/system.md": 9_000,
}
GUIDE_BYTE_BUDGET = 12_000
MODEL_BYTE_BUDGET = 14_000
PATTERN_BYTE_BUDGET = 8_000
ADR_BUDGET = 60
# One idea per paragraph. Long paragraphs are how file-by-file narration crept
# into the guides; tables and reference definitions are exempt.
PARAGRAPH_BUDGET = 600
# Exempt: release notes, and the ONF adaptation plan, written before the budget
# reached docs/plans, whose long paragraphs are lists of upstream names.
PARAGRAPH_EXEMPT = (
    "docs/release-notes/",
    "docs/plans/onf-plugin-adaptation.md",
)


COVERS = re.compile(r"^Covers:\s*(.*)$", re.MULTILINE)


def covers(text):
    """The paths a guide's `Covers:` line names, [] for `none`, None without the line."""
    match = COVERS.search(text)
    if not match:
        return None
    return [] if match[1].strip() == "none" else re.findall(r"`([^`]+)`", match[1])


def anchors(text):
    used = set()
    for line in prose(text).splitlines():
        match = re.match(r"^#{1,6}\s+(.+?)(?:\s+#+)?$", line)
        if match:
            slug = re.sub(r"[^\w\- ]", "", match[1].lower()).replace(" ", "-")
            unique, suffix = slug, 0
            while unique in used:
                suffix += 1
                unique = f"{slug}-{suffix}"
            used.add(unique)
    used.update(re.findall(r'<a\s+(?:id|name)=["\']([^"\']+)', text))
    return used


def check_document(file, root):
    text = file.read_text(encoding="utf-8")
    body = prose(text)
    # Backtick-delimited examples are not navigable Markdown links.
    body = re.sub(r"(`+).*?\1", "", body)
    errors = []
    relative = file.relative_to(root).as_posix()
    for match in list(LINK.finditer(body)) + list(REFERENCE.finditer(body)):
        target = match[1].strip("<>")
        url = urlsplit(target)
        if url.scheme or url.netloc:
            continue
        path = unquote(url.path)
        dest = (root / path.lstrip("/") if path.startswith("/") else file.parent / path) if path else file
        line = body[:match.start()].count("\n") + 1
        if not dest.exists():
            errors.append(f"{relative}:{line}: missing target {target}")
        elif url.fragment and dest.suffix == ".md" and unquote(url.fragment) not in anchors(dest.read_text(encoding="utf-8")):
            errors.append(f"{relative}:{line}: missing heading {target}")

    if not relative.startswith(PARAGRAPH_EXEMPT):
        for number, line in enumerate(prose(text).splitlines(), start=1):
            if len(line) > PARAGRAPH_BUDGET and not line.lstrip().startswith("|") and not REFERENCE.match(line):
                errors.append(f"{relative}:{number}: paragraph of {len(line)} characters exceeds {PARAGRAPH_BUDGET}")
    if relative.startswith("docs/guides/"):
        paths = covers(text)
        if paths is None or (not paths and COVERS.search(text)[1].strip() != "none"):
            errors.append(f"{relative}: a guide needs a `Covers:` line naming the code it rules, or `none`")
        for path in paths or []:
            if not (root / path).exists() or path.endswith("/") != (root / path).is_dir():
                errors.append(f"{relative}: covers missing path {path}")
    if relative.startswith("docs/plans/") and not re.search(r"^Status:\s*\S", text, re.MULTILINE):
        errors.append(f"{relative}: a plan needs a `Status:` line (proposed, agreed, in progress)")
    if relative.startswith("docs/adr/"):
        status = re.search(r"^(?:status|Status):\s*(\w+)", text, re.MULTILINE)
        if not status or status[1].lower() not in ADR_STATES:
            errors.append(f"{relative}: missing/invalid ADR status")
        elif status[1].lower() == "superseded":
            replacement = re.search(r"^superseded_by:\s*(\S+)", text, re.MULTILINE)
            if not replacement or not (file.parent / replacement[1]).is_file():
                errors.append(f"{relative}: missing/invalid superseded_by target")
    return errors


def size_warnings(file, root):
    """Line and byte budgets, as warnings: a hard limit made trims drop rules (canopi-f47t.52.214).
    Over budget, move wiring into code comments and policy tests; never delete a rule to fit."""
    text = file.read_text(encoding="utf-8")
    relative = file.relative_to(root).as_posix()
    warnings = []
    budget = LINE_BUDGETS.get(relative) or (ADR_BUDGET if relative.startswith("docs/adr/") else None)
    lines = len(text.splitlines())
    if budget is not None and lines > budget:
        warnings.append(f"{relative}: {lines} lines exceeds its {budget}-line budget")
    byte_budget = BYTE_BUDGETS.get(relative)
    if byte_budget is None and relative.startswith("docs/guides/"):
        byte_budget = GUIDE_BYTE_BUDGET
    if byte_budget is None and relative.startswith("docs/architecture/"):
        byte_budget = MODEL_BYTE_BUDGET
    if byte_budget is None and relative.startswith(".interface-design/patterns/"):
        byte_budget = PATTERN_BYTE_BUDGET
    # The `Covers:` line is read by --drift, not prose, so it is outside the budget.
    size = len(re.sub(r"^Covers:.*\n\n?", "", text, flags=re.MULTILINE).encode("utf-8"))
    if byte_budget is not None and size > byte_budget:
        warnings.append(f"{relative}: {size} bytes exceeds its {byte_budget}-byte budget")
    return warnings


def check_placement(root):
    errors = []
    docs = root / "docs"
    for path in sorted(docs.rglob("*")) if docs.is_dir() else []:
        if not path.is_file():
            continue
        parts = path.relative_to(docs).parts
        allowed = parts[0] in DOCS_DIRECTORIES if len(parts) > 1 else parts[0] in DOCS_FILES
        if not allowed:
            errors.append(f"{path.relative_to(root).as_posix()}: outside the docs layout (see docs/README.md)")
    return errors


# The architecture model (docs/architecture/) draws the code in Mermaid. Each
# diagram says whether it is the current code or the 2.1 target; a target part
# not built yet carries "(2.1)" (a class "<<2.1>>"). Every code path, type,
# crate and state it names must exist unless marked, and a mark on something
# that exists fails, so the diagrams follow the code as phases land.
MODEL_DIR = "docs/architecture/"
TARGET_MARK = "(2.1)"
MODEL_LINE = re.compile(r"^Model: (current|target)$")
PATH_ROOTS = ("", "desktop/web/src/", "desktop/src/", "common-types/src/", "desktop/web/")
PATH_TOKEN = re.compile(r"(?<![\w./:-])([A-Za-z_.][\w.-]*/[\w./-]*)")
CRATE_TOKEN = re.compile(r"(?<![\w/.-])((?:canopi-[a-z]+(?:-[a-z]+)*|common-types|bindings-gen))(?![\w.-]|/)")
SOURCE_DIRS = ("desktop/src", "desktop/web/src", "common-types/src", "bindings-gen/src", "desktop/build.rs")
DECLARATION = re.compile(r"\b(?:struct|enum|type|interface|class|trait|const|function)\s+([A-Za-z_]\w*)")
RELATION = re.compile(r'^\s*(\w+)\s*(?:"[^"]*"\s*)?(?:<\|--|\*--|o--|-->|<--|--\*|--o|--\|>|\.\.>|<\.\.|\.\.\|>|<\|\.\.|--|\.\.)\s*(?:"[^"]*"\s*)?(\w+)')
STATE_EDGE = re.compile(r"^\s*(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)")


def mermaid_blocks(text):
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        if lines[index].strip() == "```mermaid":
            end = index + 1
            while end < len(lines) and lines[end].strip() != "```":
                end += 1
            header = [line.strip() for line in lines[max(0, index - 4):index] if line.strip()]
            yield index + 1, header, lines[index + 1:end]
            index = end
        index += 1


def labels(line):
    """Text a reader sees on one Mermaid line, split per node or message."""
    if re.match(r"^\s*(%%|classDef\b|style\b|linkStyle\b|class \w+(,\w+)* \w+$)", line):
        return []
    line = re.sub(r"<br\s*/?>|</?[a-z]+>", " ", line)
    found = re.findall(r'"([^"]*)"', line) + re.findall(r"\[([^\[\]\"]*)\]", line) + re.findall(r"\|([^|]*)\|", line)
    match = re.match(r"^\s*(?:participant|actor)\s+\S+\s+as\s+(.+)$", line) or re.match(r"^[^:\"]*:\s*(.+)$", line)
    if match:
        found.append(match[1])
    return found or [line]


def source_names(root):
    names = set()
    for base in SOURCE_DIRS:
        path = root / base
        files = [path] if path.is_file() else [*path.rglob("*.rs"), *path.rglob("*.ts"), *path.rglob("*.tsx")] if path.is_dir() else []
        for file in files:
            if "__tests__" in file.parts or ".test." in file.name or "node_modules" in file.parts:
                continue
            names.update(DECLARATION.findall(file.read_text(encoding="utf-8", errors="replace")))
    return names


def crate_graph(root):
    manifest = root / "Cargo.toml"
    if not manifest.is_file():
        return {}, set()
    workspace = tomllib.loads(manifest.read_text(encoding="utf-8")).get("workspace", {})
    names, paths, inherited = {}, {}, workspace.get("dependencies", {})
    for member in workspace.get("members", []):
        data = tomllib.loads((root / member / "Cargo.toml").read_text(encoding="utf-8"))
        names[member], paths[member] = data["package"]["name"], data
    edges = set()
    for member, data in paths.items():
        tables = [data.get("dependencies", {}), data.get("build-dependencies", {}), *(t.get("dependencies", {}) for t in data.get("target", {}).values())]
        for table in tables:
            for name, spec in table.items():
                # `{ workspace = true }` takes the root's [workspace.dependencies] entry, its path relative to the root.
                spec, base = (inherited.get(name), root) if isinstance(spec, dict) and spec.get("workspace") is True else (spec, root / member)
                if isinstance(spec, dict) and "path" in spec:
                    dep = (base / spec["path"]).resolve().relative_to(root.resolve()).as_posix()
                    edges.add((names[member], names.get(dep, name)))
    return names, edges


def enum_members(root, reference):
    """Variants of `path::Type` (Rust enum, TS enum or string union; `Type.field` reads one field's literals)."""
    path, _, name = reference.partition("::")
    file = next((root / base / path for base in PATH_ROOTS if (root / base / path).is_file()), None)
    if file is None or not name:
        return None
    name, _, field = name.partition(".")
    text = file.read_text(encoding="utf-8")
    match = re.search(rf"\benum\s+{name}\b[^{{]*\{{", text)
    if match:
        depth, body, start = 1, [], match.end()
        for position in range(start, len(text)):
            depth += {"{": 1, "}": -1, "(": 1, ")": -1}.get(text[position], 0)
            if depth == 0:
                body = text[start:position]
                break
        flat, depth = [], 0
        for char in body:
            depth += {"{": 1, "}": -1, "(": 1, ")": -1}.get(char, 0)
            flat.append(char if depth == 0 or char in "{(" else " ")
        flat = re.sub(r"//[^\n]*|#\[[^\]]*\]", "", "".join(flat))
        return set(re.findall(r"(?:^|,)\s*([A-Za-z_]\w*)", flat, re.MULTILINE))
    if field:
        body = re.search(rf"\b(?:interface\s+{name}\b[^{{]*\{{|type\s+{name}\b\s*=)", text)
        member = body and re.search(rf"\b{field}\??:\s*([^\n;]+)", text[body.end():])
        if not member:
            return None
        literals = set(re.findall(r"['\"]([^'\"]+)['\"]", member[1]))
        alias = re.fullmatch(r"\s*([A-Za-z_]\w*)\s*", member[1])
        return enum_members(root, f"{path}::{alias[1]}") if alias else literals
    union = union_text(text, name)
    return None if union is None else set(re.findall(r"['\"]([^'\"]+)['\"]", union))


def union_text(text, name):
    """The right-hand side of `type Name = ...`: up to `;`, or the last line of a `|` continuation."""
    match = re.search(rf"\btype\s+{name}\b\s*=", text)
    if not match:
        return None
    lines = text[match.end():].split("\n")
    taken = [lines[0]]
    for line in lines[1:]:
        if ";" in taken[-1] or not line.strip().startswith("|"):
            break
        taken.append(line)
    return "\n".join(taken).split(";")[0]


def squash(name):
    return re.sub(r"[-_\s]", "", name).lower()


def check_model(file, root, names=None, crates=None):
    """Checks one docs/architecture/ page against the code (see the comment above MODEL_DIR)."""
    relative = file.relative_to(root).as_posix()
    text = file.read_text(encoding="utf-8")
    names = source_names(root) if names is None else names
    crate_names, crate_edges = crate_graph(root) if crates is None else crates
    crate_set = set(crate_names.values())
    errors = []

    def exists(token):
        token = token.split("::")[0].rstrip(".,;:)")
        return any((root / base / token).exists() for base in PATH_ROOTS)

    def check_refs(text_unit, line_number, current):
        marked = TARGET_MARK in text_unit
        if marked and current:
            errors.append(f"{relative}:{line_number}: a current diagram carries {TARGET_MARK}")
        for token in PATH_TOKEN.findall(text_unit):
            if "://" in token or re.search(r"[<>*{}]", token) or not re.search(r"[A-Za-z]", token.split("/")[0]):
                continue
            if not (token.endswith("/") or token.count("/") >= 2 or re.search(r"\.(tsx?|rs|json|toml|md|css|js|py|ya?ml|db)$", token.split("::")[0])):
                continue
            built = exists(token)
            if not built and not marked:
                errors.append(f"{relative}:{line_number}: {token} is not in the code; mark it {TARGET_MARK} or fix the path")
            elif built and marked and token.endswith((".ts", ".tsx", ".rs", ".json")):
                errors.append(f"{relative}:{line_number}: {token} is built; drop {TARGET_MARK}")
        for crate in CRATE_TOKEN.findall(text_unit):
            if crate not in crate_set and not marked:
                errors.append(f"{relative}:{line_number}: crate {crate} is not in the workspace; mark it {TARGET_MARK}")
            elif crate in crate_set and marked and "/" not in text_unit and not PATH_TOKEN.search(text_unit):
                errors.append(f"{relative}:{line_number}: crate {crate} is built; drop {TARGET_MARK}")

    in_fence = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            for code in re.finditer(r"`([^`]+)`(\s*\(2\.1\))?", line):
                if PATH_TOKEN.search(code[1]):
                    check_refs(code[1] + (" " + TARGET_MARK if code[2] else ""), number, False)

    for start, header, body in mermaid_blocks(text):
        model = next((MODEL_LINE.match(line)[1] for line in header if MODEL_LINE.match(line)), None)
        if model is None:
            errors.append(f"{relative}:{start}: a diagram needs a 'Model: current' or 'Model: target' line before it")
            continue
        current = model == "current"
        kind = body[0].split()[0] if body else ""
        for offset, line in enumerate(body[1:], 1):
            for unit in labels(line):
                check_refs(unit, start + offset, current)
        if kind == "classDiagram":
            classes, marked = set(), set()
            for line in body[1:]:
                declared = re.match(r"^\s*class\s+(\w+)", line)
                if declared:
                    classes.add(declared[1])
                relation = RELATION.match(line)
                if relation:
                    classes.update(relation.groups())
                annotated = re.match(r"^\s*<<\s*2\.1\s*>>\s+(\w+)", line)
                if annotated:
                    marked.add(annotated[1])
                    classes.add(annotated[1])
            for block in re.finditer(r"class\s+(\w+)\s*\{([^}]*)\}", "\n".join(body)):
                if re.search(r"<<\s*2\.1\s*>>", block[2]):
                    marked.add(block[1])
            if current and marked:
                errors.append(f"{relative}:{start}: a current diagram carries <<2.1>>")
            for name in sorted(classes):
                if name not in names and name not in marked:
                    errors.append(f"{relative}:{start}: type {name} is not in the code; annotate it <<2.1>>")
                elif name in names and name in marked:
                    errors.append(f"{relative}:{start}: type {name} is built; drop <<2.1>>")
        if kind.startswith("stateDiagram"):
            reference = next((line[len("Enum:"):].strip() for line in header if line.startswith("Enum:")), None)
            if reference is None:
                errors.append(f"{relative}:{start}: a state diagram needs an 'Enum: path::Type' line")
                continue
            states = set()
            for line in body[1:]:
                edge = STATE_EDGE.match(line)
                if edge:
                    states.update(state for state in edge.groups() if state != "[*]")
                declared = re.match(r"^\s*state\s+(\w+)\s*$", line)
                if declared:
                    states.add(declared[1])
            members = enum_members(root, reference.replace(TARGET_MARK, "").strip())
            if TARGET_MARK in reference:
                if members is not None:
                    errors.append(f"{relative}:{start}: {reference} is built; drop {TARGET_MARK}")
            elif members is None:
                errors.append(f"{relative}:{start}: {reference} names no enum or union in the code; mark it {TARGET_MARK}")
            else:
                drawn, real = {squash(s) for s in states}, {squash(m) for m in members}
                for state in sorted(drawn - real):
                    errors.append(f"{relative}:{start}: state {state} is not a member of {reference}")
                for member in sorted(real - drawn):
                    errors.append(f"{relative}:{start}: {reference} member {member} is not drawn")
        if current and kind in ("flowchart", "graph") and any(line.startswith("Graph: cargo") for line in header):
            drawn = set()
            for line in body[1:]:
                ends = re.findall(r"(\w[\w-]*)(?:\[[^\]]*\]|\([^)]*\))?\s*-->\s*(\w[\w-]*)", line)
                for source, dest in ends:
                    drawn.add((source.replace("_", "-"), dest.replace("_", "-")))
            drawn = {edge for edge in drawn if edge[0] in crate_set and edge[1] in crate_set}
            for edge in sorted(crate_edges - drawn):
                errors.append(f"{relative}:{start}: crate edge {edge[0]} --> {edge[1]} is in Cargo.toml but not drawn")
            for edge in sorted(drawn - crate_edges):
                errors.append(f"{relative}:{start}: crate edge {edge[0]} --> {edge[1]} is drawn but not in Cargo.toml")
    return errors


def documents(root):
    files = [root / p for p in ("AGENTS.md", "CONTEXT.md", "README.md", "desktop/web/ui-gallery/README.md", ".beads/README.md")]
    for directory in ("docs", ".interface-design"):
        files.extend((root / directory).rglob("*.md"))
    return [file for file in sorted(set(files)) if file.is_file()]


def check(root, phase_close=None):
    ledgers = sorted((root / "docs/decisions").glob("*.md"))
    return check_placement(root) + [
        error for file in documents(root) for error in check_document(file, root)
    ] + [error for file in ledgers for error in check_ledger(file, root) + missing_successors(file, root)] + check_models(root) + missing_ids(root) + check_suites(root) + check_owner_headers(root) + check_policy(root, phase_close) + check_gate_rows(root)


SUCCESSOR_COLUMN = "supersedes / superseded by"
# A clause of the successor column that changes an earlier row; the ids after its verb are the rows it changes.
CHANGES_ROW = re.compile(r"\b(?:supersedes|amends|narrows|drops|replaces|revises|withdraws)\b.*")
SHORT_ID = re.compile(r"\b(?:\d+\.\d+-)?([A-Z]+\d+[a-z]?)\b")


def missing_successors(file, root):
    """The ledger header's rule: a superseded or amended row names its successor. A row whose successor column changes
    an earlier row of the same ledger (supersedes, amends, narrows, drops, replaces, revises or withdraws it) needs that
    row's successor column to name it back, by short or full id."""
    relative = file.relative_to(root).as_posix()
    rows = ledger_rows(file.read_text(encoding="utf-8"))
    errors = []
    for ident, row in rows.items():
        prefix, _, short = ident.rpartition("-")
        for clause in row.get(SUCCESSOR_COLUMN, "").split(";"):
            change = CHANGES_ROW.search(clause)
            if not change:
                continue
            for target in dict.fromkeys(f"{prefix}-{name}" for name in SHORT_ID.findall(change[0])):
                if target == ident or target not in rows:
                    continue
                if not re.search(rf"(?<![\w.-])(?:{re.escape(prefix)}-)?{short}\b", rows[target].get(SUCCESSOR_COLUMN, "")):
                    errors.append(f"{relative}: {target} does not name {ident}, which {change[0].strip()}")
    return errors


def check_models(root):
    pages = sorted((root / MODEL_DIR).glob("*.md"))
    if not pages:
        return []
    names, crates = source_names(root), crate_graph(root)
    return [error for page in pages for error in check_model(page, root, names, crates) + check_layer_diagram(page, root) + check_class_fields(page, root)]


def owner(path, guides):
    """The guide whose covered path matches `path` longest, or None."""
    matches = [
        (len(covered), guide)
        for guide, paths in guides.items()
        for covered in paths
        if path == covered or (covered.endswith("/") and path.startswith(covered))
    ]
    return max(matches)[1] if matches else None


def drift(root, changed):
    """Guides whose covered code is in `changed` while the guide is not: {guide: [files]}."""
    guides = {
        file.relative_to(root).as_posix(): covers(file.read_text(encoding="utf-8")) or []
        for file in sorted((root / "docs/guides").glob("*.md"))
    }
    stale = {}
    for path in changed:
        guide = owner(path, guides) if counted(path) else None
        if guide and guide not in changed:
            stale.setdefault(guide, []).append(path)
    return stale


def uncited_decisions(text, ledger_ids, adrs):
    """Lines of a plan's Decisions sections that cite neither a ledger id nor an existing ADR."""
    lost, level = [], None
    for line in prose(text).splitlines():
        heading = re.match(r"^(#{1,6})\s+(.*)", line)
        if heading:
            within = level is not None and len(heading[1]) > level
            if not within:
                level = len(heading[1]) if "decision" in heading[2].lower() else None
            continue
        item = re.match(r"^\s*(?:[-*]|\d+\.|\|)\s*(.*)", line)
        if level is None or not item or set(item[1]) <= set("-:| "):
            continue
        cited = set(re.findall(r"\b\d+\.\d+-[A-Z]+\d+[a-z]?\b", line)) & ledger_ids
        cited |= {adr for adr in re.findall(r"(?:ADR[ -]?|adr/)(\d{4})", line) if adr in adrs}
        if not cited:
            lost.append(line.strip()[:120])
    return lost


def lost_decisions(root, base):
    """Plans deleted since `base` whose Decisions sections hold a decision no ledger row or ADR records."""
    resolve_base(root, base)
    deleted = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=D", f"{base}...HEAD", "--", "docs/plans/"],
        cwd=root, check=True, capture_output=True, text=True,
    ).stdout.split()
    ledger_ids = {ident for file in (root / "docs/decisions").glob("*.md") for ident in ledger_rows(file.read_text(encoding="utf-8"))}
    adrs = {path.name[:4] for path in (root / "docs/adr").glob("[0-9][0-9][0-9][0-9]-*.md")}
    lost = {}
    for plan in deleted:
        text = subprocess.run(["git", "show", f"{base}:{plan}"], cwd=root, check=True, capture_output=True, text=True).stdout
        if lines := uncited_decisions(text, ledger_ids, adrs):
            lost[plan] = lines
    return lost


def changed_files(root, base):
    resolve_base(root, base)
    diff = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...HEAD"], cwd=root, check=True, capture_output=True, text=True
    )
    return set(diff.stdout.split())


def drift_main(root, base):
    """`--drift <base>`: guides to reread (advice); fails on a deleted plan's unrecorded decision, an edited or deleted
    ledger row, or a base that does not resolve. Returns the exit status."""
    try:
        stale = drift(root, changed_files(root, base))
        lost = lost_decisions(root, base)
        edited = ledger_drift(root, base)
    except BaseNotFound as error:
        print(error, file=sys.stderr)
        return 1
    for guide, files in sorted(stale.items()):
        message = f"{len(files)} covered file(s) changed ({', '.join(sorted(files)[:3])}); rewrite the guide if a rule or boundary moved"
        # A notice annotation on the pull request in CI; advice, never a failure.
        print(f"::notice file={guide}::{message}" if os.environ.get("GITHUB_ACTIONS") else f"{guide}: {message}")
    print(f"Guide drift: {len(stale)} guide(s) to reread")
    # A built plan is deleted; its decisions live on in the ledger or an ADR first.
    for plan, lines in sorted(lost.items()):
        for line in lines:
            print(f"{plan}: deleted with a decision no ledger row or ADR records: {line}", file=sys.stderr)
    print(f"Deleted plans: {len(lost)} with unrecorded decisions")
    for error in edited:
        print(error, file=sys.stderr)
    print(f"Ledger rows: {len(edited)} deleted or edited")
    return 1 if lost or edited else 0


if __name__ == "__main__":
    # An unknown flag or a flag without its value exits 2 (argparse): a phase close never silently runs the plain check.
    parser = argparse.ArgumentParser(description="Canopi documentation checks", allow_abbrev=False)
    parser.add_argument("--drift", nargs="?", const="origin/main", metavar="BASE", help="guide drift, deleted plans and ledger edits since BASE")
    parser.add_argument("--phase-close", metavar="PHASE", help="also fail an inventory row still planned for PHASE or an earlier phase")
    parser.add_argument("--root", type=Path, default=ROOT, help="check another tree (the tests' fixtures)")
    args = parser.parse_args()
    if args.drift is not None:
        sys.exit(drift_main(args.root, args.drift))
    for warning in (warning for file in documents(args.root) for warning in size_warnings(file, args.root)):
        print(f"::warning::{warning}" if os.environ.get("GITHUB_ACTIONS") else f"warning: {warning}", file=sys.stderr)
    failures = check(args.root, args.phase_close)
    for failure in failures:
        print(failure, file=sys.stderr)
    print(f"Documentation checks: {len(failures)} error(s)")
    sys.exit(bool(failures))
