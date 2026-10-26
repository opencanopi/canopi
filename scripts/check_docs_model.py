"""The layer diagram check (2.1-M192, ADR 0028; Phase 0 F1a).

The components page draws the module layers as Mermaid subgraphs L0 to L5. Each node names one or more
module paths under desktop/web/src, with an optional leading rank, an optional ", owner <role>" and the
(2.1) mark of a part not built yet. The diagram must equal policy/layers.json, read as plain JSON: a path
is drawn in its row's layer, with a rank and an owner exactly when its row has them, marked (2.1) exactly
when the row is new or the path is a destination still to come, and every ranked or new row that heads its
layer is drawn. check_docs.py runs this over every architecture page; a page with no layer subgraphs is
not checked.
"""
import json
import re

LAYER_TABLE = "policy/layers.json"
TARGET_MARK = "(2.1)"
SUBGRAPH = re.compile(r'^\s*subgraph\s+(L[0-5])\b')
NODE = re.compile(r'^\s*\w+\["([^"]*)"\]')
PATH = re.compile(r"(?<![\w./-])([A-Za-z_.][\w.-]*/[\w./-]*)")
LABEL = re.compile(r"^(?:(\d+)\s+)?(.*?)(?:,\s*owner\s+(.+?))?$")


def bare(path):
    return path[:-1] if path.endswith("/") else path


def layer_nodes(text):
    """(line number, layer, label) for each node inside a layer subgraph of the page's Mermaid blocks."""
    nodes, layer, fence = [], None, False
    for number, line in enumerate(text.splitlines(), 1):
        if line.strip().startswith("```"):
            fence, layer = not fence, None
            continue
        if not fence:
            continue
        sub = SUBGRAPH.match(line)
        if sub:
            layer = sub[1]
        elif line.strip() == "end":
            layer = None
        elif layer and NODE.match(line):
            nodes.append((number, layer, NODE.match(line)[1]))
    return nodes


def check_layer_diagram(file, root):
    """Errors where the page's layer diagram and policy/layers.json disagree (see the module comment)."""
    nodes = layer_nodes(file.read_text(encoding="utf-8"))
    if not nodes:
        return []
    relative = file.relative_to(root).as_posix()
    try:
        rows = json.loads((root / LAYER_TABLE).read_text(encoding="utf-8"))["layers"]
    except (OSError, ValueError, KeyError, TypeError):
        return [f"{relative}:{nodes[0][0]}: {LAYER_TABLE} is missing or unreadable; the layer diagram is held to it"]
    by_path = {bare(row["path"]): row for row in rows}
    errors, drawn = [], set()
    for number, layer, label in nodes:
        marked = TARGET_MARK in label
        rank, rest, owner = LABEL.match(label.replace(TARGET_MARK, "").strip()).groups()
        at = f"{relative}:{number}:"
        for token in PATH.findall(rest):
            path = bare(token)
            row = by_path.get(path)
            if row is None:
                movers = [r for r in rows if "destination" in r and (bare(r["destination"]) + "/").startswith(path + "/")]
                if not movers:
                    errors.append(f"{at} {token} is no row or destination of {LAYER_TABLE}")
                elif movers[0]["layer"] != layer:
                    errors.append(f"{at} {token} is the destination of an {movers[0]['layer']} row, drawn in {layer}")
                elif not marked:
                    errors.append(f"{at} {token} is a destination not built yet; mark it {TARGET_MARK}")
                continue
            drawn.add(path)
            if row["layer"] != layer:
                errors.append(f"{at} {token} is {row['layer']} in {LAYER_TABLE}, drawn in {layer}")
            if str(row.get("rank", "")) != (rank or ""):
                errors.append(f"{at} {token} has rank {row.get('rank', 'none')} in {LAYER_TABLE}, drawn {rank or 'none'}")
            if row.get("owner") != owner:
                errors.append(f"{at} {token} is owned by {row.get('owner', 'no one')} in {LAYER_TABLE}, drawn {owner or 'no one'}")
            new = row.get("status") == "new"
            if marked and not new:
                errors.append(f"{at} {token} is built in {LAYER_TABLE}; drop {TARGET_MARK}")
            elif new and not marked:
                errors.append(f"{at} {token} is new in {LAYER_TABLE}; mark it {TARGET_MARK}")
    for row in rows:
        path = bare(row["path"])
        parents = [p for p in by_path if path.startswith(p + "/")]
        parent = by_path[max(parents, key=len)] if parents else None
        heads = parent is None or parent["layer"] != row["layer"]
        if (row.get("rank") is not None or row.get("status") == "new") and heads and path not in drawn:
            rank = f", rank {row['rank']}" if row.get("rank") is not None else ""
            errors.append(f"{relative}: {row['path']} ({row['layer']}{rank}) is in {LAYER_TABLE} but not drawn")
    return errors
