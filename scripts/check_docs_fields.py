"""The class field check (2.1-M165, 2.1-M192, ADR 0028 Diagrams; Phase 0 F4).

A classDiagram class that names a type bindings-gen exports draws only that type's fields. A member's field is
its first identifier, after any Mermaid visibility (`+`, `-`, `#`, `~`) or none; prose after it, like
`(v10, optional)`, is read only for the (2.1) mark of a field not built yet. An unmarked field the type lacks fails, naming the class and the field; a marked
field the type has fails until the mark is dropped. A field the type flattens or skips is still a field, so
drawing it passes. A class the manifest does not list, or a whole class marked <<2.1>>, is left to the class
name check in check_docs.py. The manifest is desktop/web/src/generated/type-manifest.json, read as plain
JSON (no node or cargo in the docs gate); check:types keeps it fresh.
"""
import json
import re

try:
    from scripts.check_docs_model import TARGET_MARK
except ModuleNotFoundError:
    from check_docs_model import TARGET_MARK

TYPE_MANIFEST = "desktop/web/src/generated/type-manifest.json"
CLASS_OPEN = re.compile(r"^\s*class\s+(\w+)\s*\{\s*$")
FIELD = re.compile(r"^\s*[+\-#~]?\s*([A-Za-z_]\w*)(?!\w)")


def drawn_classes(text):
    """(class name, whether marked <<2.1>>, [(line number, field, marked)]) for each class block in the page's classDiagrams."""
    classes, fence, kind, current = [], False, None, None
    for number, line in enumerate(text.splitlines(), 1):
        if line.strip().startswith("```"):
            fence, kind, current = not fence, None, None
            continue
        if not fence:
            continue
        if kind is None and line.strip():
            kind = line.split()[0]
            continue
        if kind != "classDiagram":
            continue
        opened = CLASS_OPEN.match(line)
        if opened:
            current = [opened[1], False, []]
            classes.append(current)
        elif current and line.strip() == "}":
            current = None
        elif current and re.search(r"<<\s*2\.1\s*>>", line):
            current[1] = True
        elif current and FIELD.match(line):
            current[2].append((number, FIELD.match(line)[1], TARGET_MARK in line))
    return classes


def check_class_fields(file, root):
    """Errors where a page's classDiagram fields and the bindings type manifest disagree (see the module comment)."""
    classes = [entry for entry in drawn_classes(file.read_text(encoding="utf-8")) if entry[2] and not entry[1]]
    if not classes:
        return []
    relative = file.relative_to(root).as_posix()
    try:
        types = json.loads((root / TYPE_MANIFEST).read_text(encoding="utf-8"))
        fields = {entry["name"]: {field["name"] for field in entry["fields"]} for entry in types}
    except (OSError, ValueError, KeyError, TypeError):
        return [f"{relative}:{classes[0][2][0][0]}: {TYPE_MANIFEST} is missing or unreadable; class fields are held to it (run npm run gen:types)"]
    errors = []
    for name, _, members in classes:
        if name not in fields:
            continue
        for number, field, marked in members:
            if field not in fields[name] and not marked:
                errors.append(f"{relative}:{number}: {name} has no field {field} in {TYPE_MANIFEST}; mark it {TARGET_MARK} or fix the name")
            elif field in fields[name] and marked:
                errors.append(f"{relative}:{number}: {name} field {field} is built; drop {TARGET_MARK}")
    return errors
