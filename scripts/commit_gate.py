#!/usr/bin/env python3
"""The commit gate the tracked hooks in .githooks and CI's Commit gate job run (2.1-M14, 2.1-M195 to 2.1-M199, 2.1-M228,
2.1-M229, 2.1-Q224, 2.1-Q225; contracts §12; ADR 0028 Agent enforcement).

    python3 scripts/commit_gate.py pre-commit             the staged change's tool checks
    python3 scripts/commit_gate.py commit-msg <file>      the message and diff rules on the index tree
    python3 scripts/commit_gate.py pre-merge-commit       a merge's tool checks, as pre-commit
    python3 scripts/commit_gate.py pr <base> <head> [--body-file <f>] [--vitest]
                                                          every commit of base..head with this (the head's) gate
    python3 scripts/commit_gate.py tree <before> <after>  a push to main: each first-parent commit names its PR
    python3 scripts/commit_gate.py planted <dir>...       each policy/fixtures/rules/<rule>/case.json, in a temp repository

pre-commit runs scripts/gate.py's commit lane over the staged change (2.1-M198, 2.1-M230): only .beads/ runs nothing;
only documentation runs AGENTS.md's Docs row; code runs `npm run typecheck` offline (2.1-Q205), and Rust `cargo fmt`
with the policy families (2.1-M201).

A commit is judged from files only, never gh, bd or the network (2.1-M197). Its family changes come from
`node policy/check.mjs --diff <parent> <tree>`, and the authority table holds them:
  - an added or raised ratchet entry, a raised or removed budget, a lowered or removed floor and its patterns, a header
    change (but a widened scope or an earlier lane) and a deleted family need an open bead and a Q row present in the
    ledger at the merge base, both named in the message (gate-loosening-authority); an M or E row authorises nothing;
  - a family's creating commit names its ledger id, E and M rows included (gate-first-baseline);
  - lowered, removed and renamed entries are free, but in guarded-files, where removing or renaming an entry needs a Q
    row and adding one is free only with the file it guards, created in the same commit;
  - a flake-quarantine entry added or raised needs only its own open bead with an assignee or owner (2.1-Q242);
  - a guarded file changed, deleted or renamed needs a merge-base Q row; policy/ratchets/coverage.json also an open bead
    and both numbers: a floor's old and new value, or for an exclusion change two measured values (gate-guarded-file);
  - an inventory row demoted to advice or process, and a rules.json or primitives.json row dropped or made planned, need
    a merge-base Q row (gate-inventory-demotion);
  - deleted, reworded and loosened tests: scripts/deletion_guard.py (gate-test-deleted, -reworded, -loosened);
  - an attribution trailer or footer, or the word Claude, in a message or PR body (gate-no-attribution).
A bead is read from the commit's tree, then the integration tip (branch.<branch>.canopiIntegration), then the working
tree, the first holding it deciding; in CI (pr mode, GITHUB_ACTIONS=true) from the commit's tree, then the PR head, so a
bead a later commit closes still authorises the commit made while it was open. Q rows come from docs/decisions/*.md at the merge base
(merge-base(HEAD, origin/main) locally, of base and head in pr mode) through check_docs.ledger_rows. A merge is judged
on what differs from every parent (--cc). An amend is read from the parent git's argv (/proc); where that is unreadable
the commit is judged against HEAD and HEAD^ and the stricter verdict holds.
"""
from collections import Counter
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # the gate writes nothing into the tree it judges, no __pycache__ either
sys.path.insert(0, str(ROOT / "scripts"))
import deletion_guard  # noqa: E402

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
BEAD = re.compile(r"\bcanopi-[a-z0-9]+(?:\.[0-9]+)*\b")
LEDGER_ID = re.compile(r"\b\d+\.\d+-[EMQ]\d+[a-z]?\b")
Q_ROW = re.compile(r"^\d+\.\d+-Q\d+[a-z]?$")
ATTRIBUTION = re.compile(r"\bClaude\b|noreply@anthropic\.com")
PR_SUBJECT = re.compile(r"\(#\d+\)\s*$|^Merge pull request #\d+ ")
# The scripts the gate imports: planted cases copy them with policy/ into their temporary repository.
GATE_SCRIPTS = ("commit_gate.py", "deletion_guard.py", "check_docs.py", "check_docs_model.py", "change_coupling.py")
GATE_FILES = ("scripts/commit_gate.py", "scripts/deletion_guard.py", "policy/check.mjs", ".github/workflows/commit-gate.yml")
RATCHETS = "policy/ratchets"
GUARDED = f"{RATCHETS}/guarded-files.json"
COVERAGE = f"{RATCHETS}/coverage.json"
FLAKES = "flake-quarantine"
TABLES = ("policy/rules.json", "policy/primitives.json")
INVENTORY = "policy/inventory.json"
LANES = ("commit", "push", "ci")
CLOSED = ("closed", "tombstone")


class GitFailed(Exception):
    """A git query the gate depends on failed: the commit is refused, never read as passing."""


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


def git_ok(*args):
    result = git(*args)
    if result.returncode != 0:
        raise GitFailed(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def show(rev, path):
    """A file's text at a revision (a commit or tree id), None when absent; the working tree when rev is None."""
    if rev is None:
        file = ROOT / path
        return file.read_text(encoding="utf-8") if file.is_file() else None
    result = git("cat-file", "blob", f"{rev}:{path}")
    return result.stdout if result.returncode == 0 else None


def load_json(rev, path):
    text = show(rev, path)
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


# --- pre-commit (the tool checks) -----------------------------------------------------------------------------------

def run(command, cwd=ROOT, env=None):
    print(f"commit gate: {' '.join(command)}", file=sys.stderr)
    return subprocess.run(command, cwd=cwd, env=env).returncode


def pre_commit():
    paths = [p for p in git_ok("diff", "--cached", "--name-only", "-z").split("\0") if p]
    if all(p.startswith(".beads/") for p in paths):
        return 0
    return run([sys.executable, "scripts/gate.py", "affected", "--staged"])


# --- resolution: beads and Q rows from files only (2.1-M197) ---------------------------------------------------------

class Authority:
    def __init__(self, merge_base, sources):
        self.merge_base = merge_base
        self.sources = sources  # revisions to read .beads/issues.jsonl from, None for the working tree
        self._beads = {}
        from check_docs import ledger_rows
        self.q_rows = set()
        listing = git_ok("ls-tree", "-z", "--name-only", merge_base, "--", "docs/decisions/").split("\0")
        for name in sorted(n for n in listing if n.endswith(".md")):
            for _, header, cells in ledger_rows(show(merge_base, name) or ""):
                if cells and "id" in header and len(cells) == len(header) and Q_ROW.match(cells[header.index("id")]):
                    self.q_rows.add(cells[header.index("id")])

    def reading(self, sources):
        """This authority reading beads from `sources` instead, sharing the Q rows and the records read so far."""
        other = copy.copy(self)
        other.sources = sources
        return other

    def records(self, source):
        if source not in self._beads:
            records = {}
            for line in (show(source, ".beads/issues.jsonl") or "").splitlines():
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict) and isinstance(record.get("id"), str):
                    records[record["id"]] = record
            self._beads[source] = records
        return self._beads[source]

    def bead(self, ident):
        for source in self.sources:
            if ident in self.records(source):
                return self.records(source)[ident]
        return None

    def bead_open(self, ident):
        record = self.bead(ident)
        return bool(record) and record.get("status") not in CLOSED

    def owned(self, ident):
        record = self.bead(ident) or {}
        return self.bead_open(ident) and bool(record.get("assignee") or record.get("owner"))

    def cites_q(self, message):
        return any(i in self.q_rows for i in LEDGER_ID.findall(message))

    def why_not(self, message, bead=True):
        """None when the message names an open bead (when needed) and a merge-base Q row, else what is missing."""
        ids = LEDGER_ID.findall(message)
        missing = []
        if bead and not any(self.bead_open(b) for b in BEAD.findall(message)):
            named = ", ".join(f"{b} ({'closed' if self.bead(b) else 'absent'})" for b in BEAD.findall(message)) or "none"
            missing.append(f"an open bead (named: {named})")
        if not self.cites_q(message):
            named = ", ".join(i for i in ids) or "none"
            missing.append(f"a Q row on the merge base {self.merge_base[:9]} (named: {named}; an E or M row, or a Q row "
                           "added on the branch, authorises nothing)")
        return " and ".join(missing) or None


# --- judging one commit -----------------------------------------------------------------------------------------------

def family_changes(parent, tree):
    result = subprocess.run(["node", "policy/check.mjs", "--diff", parent, tree], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise GitFailed(f"node policy/check.mjs --diff {parent} {tree} failed: {result.stderr.strip()}")
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def changed(parent, tree):
    """[(status, old path, new path)] with git -M renames."""
    parts = git_ok("diff", "-M", "--name-status", "-z", parent, tree).split("\0")
    out, i = [], 0
    while i < len(parts) and parts[i]:
        status = parts[i]
        if status[0] in "RC":
            out.append((status[0], parts[i + 1], parts[i + 2]))
            i += 3
        else:
            out.append((status[0], parts[i + 1], parts[i + 1]))
            i += 2
    return out


def shape(doc):
    return "budget" if "budgets" in (doc or {}) else "floor" if "floors" in (doc or {}) else "ratchet"


def header_free(base, head, fields):
    """A widened scope or an earlier lane, and nothing else, loosens nothing."""
    if not set(fields) <= {"scope", "lane"}:
        return False
    widened = set(base.get("scope", [])) <= set(head.get("scope", []))
    earlier = LANES.index(head.get("lane", "ci")) <= LANES.index(base.get("lane", "ci"))
    return widened and earlier


def numbers(message):
    text = BEAD.sub(" ", LEDGER_ID.sub(" ", message))
    return {float(n) for n in re.findall(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])", text)}


def judge_families(parent, tree, message, auth, changes, files):
    findings = []
    created = {new for status, _, new in files if status == "A"}
    for c in changes:
        family, kind, key = c["family"], c["change"], c.get("key")
        doc = load_json(tree, f"{RATCHETS}/{family}.json") or load_json(parent, f"{RATCHETS}/{family}.json") or {}
        base_doc = load_json(parent, f"{RATCHETS}/{family}.json") or {}
        what = f"{family}: {kind}{f' {key}' if key else ''}"
        if kind == "created":
            if doc.get("ledger") not in LEDGER_ID.findall(message):
                findings.append(("gate-first-baseline", f"{what}: the creating commit names the family's ledger id {doc.get('ledger')}"))
            continue
        if f"{RATCHETS}/{family}.json" == GUARDED:
            if not (kind == "added" and key in created) and not auth.cites_q(message):
                findings.append(("gate-guarded-file", f"{what} needs a Q row on the merge base, or for an added entry "
                                                      "the file it guards created in the same commit (2.1-Q225, 2.1-M229)"))
            continue
        if family == FLAKES and kind in ("added", "raised"):
            bead = ((doc.get("entries") or {}).get(key) or {}).get("bead")
            if not (bead and auth.owned(bead)):
                findings.append(("gate-loosening-authority", f"{what} needs its own open bead with an assignee or owner "
                                                             f"(entry bead: {bead or 'none'}; 2.1-Q242)"))
            continue
        loosening = {
            "ratchet": ("added", "raised", "deleted"),
            "budget": ("raised", "removed", "deleted"),
            "floor": ("lowered", "removed", "floor-globs", "deleted"),
        }[shape(doc)]
        if kind == "header" and not header_free(base_doc, doc, c.get("fields", [])) or kind in loosening:
            why = auth.why_not(message)
            if why:
                findings.append(("gate-loosening-authority", f"{what} needs {why}"))
    return findings


def judge_guarded(parent, tree, message, auth, changes, files):
    guarded = (load_json(parent, GUARDED) or {}).get("entries") or {}
    findings = []
    for status, old, new in files:
        if old not in guarded:
            continue
        what = f"{old} ({'deleted' if status == 'D' else f'renamed to {new}' if old != new else 'changed'})"
        why = auth.why_not(message, bead=old == COVERAGE)
        if why:
            findings.append(("gate-guarded-file", f"{what}: a guarded file needs {why} (2.1-Q225)"))
            continue
        if old == COVERAGE:
            moved = [c for c in changes if c["family"] == "coverage" and c["change"] in ("raised", "lowered")]
            needed = [float(v) for c in moved for v in (c["from"], c["to"])]
            have = numbers(message)
            if any(v not in have for v in needed) or (not moved and len(have) < 2):
                need = ", ".join(f"{v:g}" for v in needed) if moved else "the measured value before and after"
                findings.append(("gate-guarded-file", f"{what}: the message names both numbers ({need}; ADR 0028 Coverage)"))
    return findings


def state(row):
    value = row.get("state") if isinstance(row, dict) else None
    return value if isinstance(value, str) else next(iter(value), None) if isinstance(value, dict) and value else None


def rows(doc, key="rules"):
    if isinstance(doc, list):
        return [r for r in doc if isinstance(r, dict) and "id" in r]
    found = (doc or {}).get(key) if isinstance(doc, dict) else None
    if found is None and isinstance(doc, dict):
        found = next((v for v in doc.values() if isinstance(v, list)), [])
    return [r for r in found or [] if isinstance(r, dict) and "id" in r]


def judge_demotions(parent, tree, message, auth, paths):
    if auth.cites_q(message):
        return []
    findings = []
    if INVENTORY in paths:
        now = {r["id"]: r for r in rows(load_json(tree, INVENTORY))}
        for row in rows(load_json(parent, INVENTORY)):
            after = now.get(row["id"])
            if state(row) in ("exists", "planned") and after and state(after) in ("advice", "process"):
                findings.append(("gate-inventory-demotion", f"{INVENTORY}: {row['id']} moves from {state(row)} to "
                                                            f"{state(after)} without a merge-base Q row (ctr §12)"))
    for table in (t for t in TABLES if t in paths):
        now = {r["id"]: r for r in rows(load_json(tree, table))}
        for row in rows(load_json(parent, table)):
            after = now.get(row["id"])
            if row.get("status") != "planned" and (after is None or after.get("status") == "planned"):
                findings.append(("gate-inventory-demotion", f"{table}: rule {row['id']} is {'dropped' if after is None else 'made planned'} "
                                                            "without a merge-base Q row (2.1-M229)"))
    return findings


def deleted_code(parent, tree):
    """deletion_guard.deleted_code of a commit, for Retires-test."""
    return deletion_guard.deleted_code(changed(parent, tree), lambda p: show(parent, p), lambda p: show(tree, p))


def judge_tests(parent, tree, message, auth, changes, files):
    tests = [(None if s == "A" else old, None if s == "D" else new) for s, old, new in files
             if deletion_guard.is_test_file(old) or deletion_guard.is_test_file(new)]
    if not tests:
        return []
    quarantined = {}
    for c in changes:
        if c["family"] == FLAKES and c["change"] in ("added", "raised"):
            entry = ((load_json(tree, f"{RATCHETS}/{FLAKES}.json") or {}).get("entries") or {}).get(c["key"]) or {}
            if entry.get("bead") and auth.owned(entry["bead"]):
                quarantined[c["key"]] = entry["bead"]
    contents = [(old, new, show(parent, old) if old else "", show(tree, new) if new else "") for old, new in tests]
    retires = deletion_guard.RETIRES.search(message)
    return deletion_guard.judge(contents, message, authorised=auth.cites_q(message),
                                deleted_code=deleted_code(parent, tree) if retires else {}, quarantined=quarantined,
                                bead_open=auth.bead_open, read=lambda p: show(parent, p))


def judge(parents, tree, message, auth):
    """Findings [(rule, text)] for a commit of `tree` over `parents` (a merge judged on what differs from every one)."""
    parents = parents or [EMPTY_TREE]
    changes = family_changes(parents[0], tree)
    files = changed(parents[0], tree)
    if len(parents) > 1:
        same = lambda c: (c["family"], c.get("key"))  # noqa: E731
        for other in parents[1:]:
            theirs = {same(c) for c in family_changes(other, tree)}
            changes = [c for c in changes if same(c) in theirs]
            touched = {p for _, old, new in changed(other, tree) for p in (old, new)}
            files = [f for f in files if f[1] in touched or f[2] in touched]
    findings = [("gate-no-attribution", f"the message names {m.group(0)!r}: no attribution trailer, footer or tool name "
                                        "(AGENTS.md Commits; 2.1-M230)") for m in ATTRIBUTION.finditer(message)][:1]
    paths = {p for _, old, new in files for p in (old, new)}
    findings += judge_families(parents[0], tree, message, auth, changes, files)
    findings += judge_guarded(parents[0], tree, message, auth, changes, files)
    findings += judge_demotions(parents[0], tree, message, auth, paths)
    findings += judge_tests(parents[0], tree, message, auth, changes, files)
    return findings


# --- modes ------------------------------------------------------------------------------------------------------------

def report(label, findings):
    for rule, text in findings:
        print(f"{label}: {rule}: {text}")
    return bool(findings)


def bead_sources(first, head=None):
    """Where a commit's beads are read, the first holding one deciding (2.1-M197): `first` (the commit's own tree), then
    in CI the PR head `head` and nothing else, locally the integration tip and the working tree."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        return [first] + ([head] if head else [])
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.strip()
    tip = git("config", "--get", f"branch.{branch}.canopiIntegration").stdout.strip() if branch else ""
    return [first] + ([tip] if tip and git("rev-parse", "--verify", "--quiet", tip).returncode == 0 else []) + [None]


def amending():
    """True or False from the parent git's argv (git accepts `--am` as a prefix of --amend), None when unreadable."""
    try:
        argv = Path(f"/proc/{os.getppid()}/cmdline").read_bytes().decode("utf-8", "replace").split("\0")
    except OSError:
        return None
    return any(len(a) >= 4 and "--amend".startswith(a) for a in argv)


def commit_msg(path):
    message = "\n".join(l for l in Path(path).read_text(encoding="utf-8").splitlines() if not l.startswith("#"))
    tree = git_ok("write-tree").strip()
    head = git("rev-parse", "--verify", "--quiet", "HEAD").stdout.strip()
    merging = git("rev-parse", "--verify", "--quiet", "MERGE_HEAD").stdout.strip()
    base = git_ok("merge-base", head or "origin/main", "origin/main").strip()
    auth = Authority(base, bead_sources(tree))
    if merging:
        candidates = [[head, *git_ok("rev-parse", "MERGE_HEAD").split()]]
    elif not head:
        candidates = [[]]
    else:
        before = git("rev-parse", "--verify", "--quiet", f"{head}^").stdout.strip()
        amend = amending()
        candidates = [[before] if before else []] if amend else [[head]] if amend is False else [[head], [before] if before else []]
    findings = []
    for parents in candidates:
        findings += [f for f in judge(parents, tree, message, auth) if f not in findings]
    if report("commit gate", findings):
        print("commit gate: refused; fix the commit or its message (the rules: scripts/commit_gate.py)", file=sys.stderr)
        return 1
    return 0


def pr(base, head, body_file=None, vitest=False):
    mb = git_ok("merge-base", base, head).strip()
    auth = Authority(mb, bead_sources(head, head))
    failed = False
    if body_file:
        body = Path(body_file).read_text(encoding="utf-8")
        failed |= report("PR body", [("gate-no-attribution", f"names {m.group(0)!r}") for m in ATTRIBUTION.finditer(body)][:1])
    revs = git_ok("rev-list", "--reverse", "--topo-order", f"{base}..{head}").split()
    before_gate, gate_changes, judged = [], [], []
    for rev in revs:
        parents = git_ok("rev-list", "--parents", "-n", "1", rev).split()[1:]
        subject = git_ok("log", "-1", "--format=%s", rev).strip()
        label = f"{rev[:9]} {subject[:60]}"
        if not parents or show(parents[0], "scripts/commit_gate.py") is None:
            before_gate.append(label)
            continue
        message = git_ok("log", "-1", "--format=%B", rev)
        judged.append((rev, parents[0], message))
        files = {p for _, old, new in changed(parents[0], rev) for p in (old, new)}
        if files & set(GATE_FILES):
            gate_changes.append(label)
        failed |= report(label, judge(parents, f"{rev}^{{tree}}", message, auth.reading(bead_sources(rev, head))))
    if vitest:
        failed |= report("vitest list", vitest_pass(mb, head, judged, auth))
    for label in before_gate:
        print(f"before the gate (its parent has no scripts/commit_gate.py; not judged): {label}")
    for label in gate_changes:
        print(f"changes the gate's own files: {label}")
    print(f"commit gate: {len(revs)} commit(s), {len(before_gate)} before the gate: {'RED' if failed else 'OK'}")
    return 1 if failed else 0


def tree_mode(before, after):
    failed = False
    for line in git_ok("rev-list", "--first-parent", "--reverse", "--format=%s", f"{before}..{after}").splitlines():
        if line.startswith("commit "):
            rev = line.split()[1]
            continue
        if not PR_SUBJECT.search(line):
            failed |= report(f"{rev[:9]} {line[:60]}", [("gate-squash-subject", "names no PR ((#NN) or Merge pull request "
                                                                                 "#NN): not checked by a PR (2.1-M228)")])
    print(f"commit gate tree: {'RED' if failed else 'OK'}")
    return 1 if failed else 0


def vitest_pass(mb, head, commits, auth):
    """Vitest titles (.each rows, template literals) lost between the merge base and head, read by `vitest list
    --staticParse=false` on a base tree linking head's node_modules (the F3b-c2 probe): the base lists each test file
    deleted, changed or renamed (its old path), the head each one changed, renamed or added, so a move into any file
    passes. A lost title needs a route in a commit that touched its file (commits: [(rev, parent, message)]): that
    commit cites a merge-base Q row, names it in Retires-test (deleting code under test), or replaces it by a title
    that commit adds (vitest list of the commit's own test files): quoted (one lost title each, its own file first) or
    as the new title of Rewords-test in the same file."""
    base_files, head_files, renamed = deletion_guard.web_tests(changed(mb, head))
    if not base_files:
        return []
    base, unread = deletion_guard.listed_at(ROOT, mb, base_files)
    if unread:
        print(f"vitest list could not read these at the base; the per-commit regex reading stands for them: {', '.join(unread)}")
    head_titles, _ = deletion_guard.listed_at(ROOT, None, head_files)
    was, now = Counter(name for name, _ in base), Counter(name for name, _ in head_titles)
    candidates = {name.split(" > ")[-1] for name in now if was[name] < now[name]}
    own = {}  # rev -> [(title, path)] the commit adds and no lost title has used yet
    findings = []
    for name, file in sorted(set(base)):
        if was[name] <= now[name]:
            continue
        path, title = f"desktop/web/{file}", name.split(" > ")[-1]
        touching = [(rev, parent, message) for rev, parent, message in commits
                    if {path, renamed.get(path)} & {p for _, old, new in changed(parent, rev) for p in (old, new)}]
        paths = (path, renamed.get(path, path))
        if not any(routes(title, paths, mb, rev, parent, message, auth, candidates, own) for rev, parent, message in touching):
            findings.append(("gate-test-deleted", f"'{name}' ({file}) is gone at head with no route in a commit that "
                                                  "touched its file"))
    return findings


def routes(title, paths, mb, rev, parent, message, auth, candidates, own):
    """Whether one commit's message routes the loss of `title` from its file (paths: its base and head path;
    vitest_pass). A replacement title is taken
    from what that commit adds (own[rev], listed once and only when the message names a head-added title) and used up."""
    if auth.cites_q(message):
        return True
    retired = {t.strip() for t in deletion_guard.RETIRES.findall(message)}
    path = paths[0]
    if title in retired and deletion_guard.code_under_test(path, show(mb, path), deleted_code(parent, rev)):
        return True
    rewords = [new.strip() for old, new in deletion_guard.REWORDS.findall(message) if old.strip() == title]
    if not rewords and not any(deletion_guard.quoted(t, message) for t in candidates):
        return False
    if rev not in own:
        own[rev] = deletion_guard.commit_added(ROOT, rev, parent, changed(parent, rev))
    free, renamed = own[rev]
    same = {*paths, *(renamed.get(p, p) for p in paths)}
    pick = next((i for i, (t, p) in enumerate(free) if t in rewords and p in same), None)
    if pick is None:
        quoted = [i for i, (t, _) in enumerate(free) if deletion_guard.quoted(t, message)]
        pick = next((i for i in quoted if free[i][1] in same), quoted[0] if quoted else None)
    if pick is None:
        return False
    free.pop(pick)
    return True


def planted(dirs):
    """Each planted case (base files, head files, message; `mode` tree for a subject case) judged in a temporary
    repository outside the calling tree, holding this gate and policy/: one JSON line {file, rules} per case."""
    for name in dirs:
        case_file = Path(name) / "case.json" if Path(name).is_dir() else Path(name)
        case = json.loads(case_file.read_text(encoding="utf-8"))
        scratch = Path(tempfile.mkdtemp(prefix="canopi-gate-planted-"))
        try:
            repo = scratch / "repo"
            shutil.copytree(ROOT / "policy", repo / "policy", ignore=shutil.ignore_patterns("fixtures"))
            for script in GATE_SCRIPTS:
                (repo / "scripts").mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / "scripts" / script, repo / "scripts" / script)
            env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1", GITHUB_ACTIONS="true")
            sh = lambda *a: subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=planted", "-c",  # noqa: E731
                                            "user.email=planted@example.invalid", *a], cwd=repo, env=env, check=True,
                                           capture_output=True, text=True).stdout.strip()
            sh("init", "-q", "-b", "main")
            revs = []
            for files, message in ((case.get("base", {}), "chore: base"), (case.get("head", {}), case["message"])):
                for path, text in files.items():
                    target = repo / path
                    if text is None:
                        target.unlink()
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(text if isinstance(text, str) else json.dumps(text, indent=2) + "\n", encoding="utf-8")
                sh("add", "-A")
                sh("commit", "-q", "--allow-empty", "-m", message)
                revs.append(sh("rev-parse", "HEAD"))
            mode = case.get("mode", "pr")
            result = subprocess.run([sys.executable, "scripts/commit_gate.py", mode, *revs], cwd=repo, env=env,
                                    capture_output=True, text=True)
            fired = sorted({m.group(1) for m in re.finditer(r": (gate-[a-z-]+): ", result.stdout)})
            if result.returncode not in (0, 1):
                raise OSError(f"{case_file}: the gate exited {result.returncode}: {result.stderr.strip()}")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        print(json.dumps({"file": str(name), "rules": fired}))
    return 0


def main(argv):
    mode, args = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    try:
        if mode == "pre-commit" or mode == "pre-merge-commit":
            return 1 if pre_commit() else 0
        if mode == "commit-msg" and args:
            return commit_msg(args[0])
        if mode == "pr" and len(args) >= 2:
            body = args[args.index("--body-file") + 1] if "--body-file" in args else None
            return pr(args[0], args[1], body, "--vitest" in args)
        if mode == "tree" and len(args) == 2:
            return tree_mode(*args)
        if mode == "planted" and args:
            return planted(args)
    except GitFailed as error:
        print(f"commit gate: {error}; refusing (fetch origin/main if it is missing)", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"commit gate: {error.strerror or error}: {error.filename or ''}; refusing", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("commit gate: interrupted; nothing was written", file=sys.stderr)
        return 130
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
