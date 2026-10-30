"""AGENTS.md's Quality gates rows against scripts/gate.py's table (2.1-M198, 2.1-M226), called from check_docs.py.

gate.py holds each area's AGENTS.md row (its Change and Run cells) beside the checks it runs, and test_gate_table.py pins
each row to those checks; this compares the rows, in order, with the table AGENTS.md shows.
"""
import importlib.util
from pathlib import Path

HEADING = "## Quality gates"


def gate_rows(root):
    """The (Change, Run) rows of root's scripts/gate.py, in table order."""
    spec = importlib.util.spec_from_file_location(f"gate_table_{abs(hash(str(root)))}", Path(root) / "scripts/gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return [(area.label, area.run) for area in module.AREAS]


def agents_rows(text):
    table = text.split(HEADING, 1)[1].split("\n\n", 2)[1]
    rows = []
    for line in table.splitlines()[2:]:
        change, _, run = line.strip().removeprefix("| ").removesuffix(" |").partition(" | ")
        rows.append((change, run))
    return rows


def check_gate_rows(root):
    agents, gate = Path(root) / "AGENTS.md", Path(root) / "scripts/gate.py"
    text = agents.read_text(encoding="utf-8") if agents.is_file() else ""
    if HEADING not in text:
        return [f"AGENTS.md has no {HEADING} table for scripts/gate.py's rows (2.1-M198)"] if gate.is_file() else []
    if not gate.is_file():
        return [f"AGENTS.md: {HEADING} rows need their table, and scripts/gate.py is missing (2.1-M198)"]
    ours, theirs = agents_rows(text), gate_rows(root)
    errors = []
    for index in range(max(len(ours), len(theirs))):
        shown = ours[index] if index < len(ours) else None
        table = theirs[index] if index < len(theirs) else None
        if shown != table:
            errors.append(f"AGENTS.md: {HEADING} row {index + 1} differs from scripts/gate.py (2.1-M198): AGENTS.md has "
                          f"{'| ' + ' | '.join(shown) + ' |' if shown else 'no row'}, gate.py "
                          f"{'| ' + ' | '.join(table) + ' |' if table else 'no row'}")
    return errors
