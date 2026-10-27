#!/usr/bin/env python3
"""F1b c4 probe: the rule-id grammar over docs/adr, docs/guides and AGENTS.md (2.1-M189, A10, ADR 0022:60).

A backticked kebab-case token is a rule id when it sits in an ADR's `## Checks` section, or when a tool name
(dependency-cruiser, ast-grep, clippy, knip, jscpd, cargo-deny) precedes it in its sentence. Left out: a workspace
crate name (Cargo.toml's members), an HTML data attribute (`data-...`) and oxlint's own rule names (a token after
`oxlint` names an oxlint lint, which the `oxlint` family keys as `oxlint:<rule>`, never a policy id).

  python3 rule_ids.py <repo> <list-rules output>
"""
import pathlib
import re
import sys
import tomllib

root = pathlib.Path(sys.argv[1])
registry = {line.split()[0] for line in open(sys.argv[2]) if line.strip()}
TOOLS = re.compile(r'(?<![\w-])(?:dependency-cruiser|ast-grep|clippy|knip|jscpd|cargo-deny)(?![\w-])')
TOKEN = re.compile(r'`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`')
SENTENCE = re.compile(r'(?<=[.!?])\s+(?=[A-Z`(])')


def crates():
    names = set()
    for member in tomllib.loads((root / 'Cargo.toml').read_text())['workspace']['members']:
        manifest = root / member / 'Cargo.toml'
        if manifest.exists():
            names.add(tomllib.loads(manifest.read_text())['package']['name'])
    return names


CRATES = crates()
docs = sorted((root / 'docs/adr').glob('*.md')) + sorted((root / 'docs/guides').glob('*.md')) + [root / 'AGENTS.md']
for doc in docs:
    in_checks = False
    for number, line in enumerate(doc.read_text().split('\n'), 1):
        if line.startswith('#'):
            in_checks = doc.parent.name == 'adr' and re.match(r'^##\s+Checks\s*$', line) is not None
            continue
        for sentence in SENTENCE.split(line):
            for match in TOKEN.finditer(sentence):
                token = match.group(1)
                if token in CRATES or token.startswith('data-'):
                    continue
                why = 'checks' if in_checks else 'tool' if TOOLS.search(sentence[:match.start()]) else None
                if why:
                    print(f"{'known' if token in registry else 'MISS '} {why:6} {token:42} {doc.relative_to(root)}:{number}")
