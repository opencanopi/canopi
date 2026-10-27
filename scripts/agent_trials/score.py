#!/usr/bin/env python3
"""Score one agent change trial (ADR 0028 stopping rule and trials; 2.1-Q226).

  score.py run <task> <worktree> --start COMMIT [--transcript JSONL] [--run N] [--phase P] [--json OUT] [--no-gates]

<task> is t1..t8 (tasks/<task>.json); --start is the run's start commit (the one `prepare` made). A run counts the
committed, staged, unstaged and untracked changes against --start and writes one JSON record:

- files changed, lines added and removed, test files changed (`git diff --numstat`, untracked files whole);
- areas: a production file's area is its policy/layers.json row's `area` (longest row wins) under desktop/web/src,
  its crate's package name for a file inside a Cargo package, else `desktop/web/<dir>` or the top directory; tests
  have none;
- owners: every touched path in layer-table coordinates goes through the scenario owner matcher
  (policy/adapters/scenario-owners.mjs counted() and ownerOf(), 2.1-M170): tests and generated files are no modules,
  and the locale family and documentation (.md) are no owner either; `touched` and `missed` are the task's owners hit
  and not, `outside` the counted modules no owner covers (the wrong-owner edits);
- gates for the changed area, each pass or fail with its log beside the record. Each trial worktree builds Rust in
  its own CARGO_TARGET_DIR under .rq-scratch/targets/<worktree name> (2.1-M201);
- with --transcript, the trial agent's metrics read by transcript.py (the one transcript reader): files read,
  tokens, gate failures before green. Without a transcript, or with a missing one, those keys are absent, never 0.
Violations caught only by review stay the reviewer's field (ADR 0028), filled in by hand.

The layer table, rules and matcher are this checkout's (the harness); the trial worktree only supplies the diff.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    from . import transcript as transcripts
except ImportError:  # run as a script
    import transcript as transcripts

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SRC = "desktop/web/src/"
MATCHER = "policy/adapters/scenario-owners.mjs"
LAYERS = "policy/layers.json"
NO_OWNER = ("i18n/",)
TRANSCRIPT_METRICS = ("files_read", "files_read_list", "tokens", "gate_failures", "gate_green")
REPO_TEST = re.compile(r"(?:^|/)(?:__tests__|tests|e2e)/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|/|_)tests?\.rs$|(?:^|/)e2e\.rs$|(?:^|/)test_[^/]*\.py$")
SRC_TEST = re.compile(r"\.(?:test|spec)\.tsx?$")


class Refused(Exception):
    """A run the scorer refuses (stale seed, bad input); its message names the next step."""


def git(wt, *args):
    return subprocess.run(["git", "-C", str(wt), *args], check=True, capture_output=True, text=True).stdout


def load_tasks():
    return {p.stem: json.loads(p.read_text()) for p in sorted((HERE / "tasks").glob("t*.json"))}


def coordinate(path):
    """A repository path in layer-table coordinates (relative to desktop/web/src for a frontend module)."""
    return path[len(SRC):] if path.startswith(SRC) else path


def is_src_coordinate(root, module):
    return (Path(root) / SRC / module.split("/")[0]).exists()


def owner_exists(root, module):
    base = Path(root) / (SRC if is_src_coordinate(root, module) else "") / module.rstrip("/")
    return base.is_dir() if module.endswith("/") else base.is_file()


# ---------------------------------------------------------------- diff


def changes(wt, start):
    """{path: (added, removed)} against start, untracked files counted whole; sorted by path."""
    files = {}
    for line in git(wt, "diff", "--numstat", "--no-renames", start).splitlines():
        added, removed, path = line.split("\t", 2)
        files[path] = (int(added) if added != "-" else 0, int(removed) if removed != "-" else 0)
    for path in git(wt, "ls-files", "--others", "--exclude-standard").splitlines():
        try:
            n = len((Path(wt) / path).read_text(errors="replace").splitlines())
        except OSError:
            n = 0
        files[path] = (n, 0)
    return dict(sorted(files.items()))


def layer_rows(root):
    return json.loads((Path(root) / LAYERS).read_text())["layers"]


def row_for(rows, module):
    best = None
    for row in rows:
        p = row.get("path", "")
        covers = module.startswith(p) if p.endswith("/") else module == p
        if covers and (best is None or len(p) > len(best["path"])):
            best = row
    return best


def is_test(rows, path):
    if path.startswith(SRC):
        row = row_for(rows, coordinate(path))
        return bool(SRC_TEST.search(path)) or (row is not None and row.get("layer") == "test")
    return bool(REPO_TEST.search(path))


def crate_of(wt, path):
    """The package name of the Cargo package holding path, or None."""
    parent = (Path(wt) / path).parent
    while parent != Path(wt) and Path(wt) in parent.parents:
        manifest = parent / "Cargo.toml"
        if manifest.is_file():
            m = re.search(r'^\[package\][^\[]*?^name\s*=\s*"([^"]+)"', manifest.read_text(), re.M | re.S)
            if m:
                return m.group(1)
        parent = parent.parent
    return None


def area(rows, wt, path):
    """The area a production file belongs to (see the header), or None for a file of no area."""
    if path.startswith(SRC):
        row = row_for(rows, coordinate(path))
        return row.get("area") if row else None
    crate = crate_of(wt, path)
    if crate:
        return crate
    parts = path.split("/")
    if path.startswith("desktop/web/") and len(parts) > 3:
        return "desktop/web/" + parts[2]
    return parts[0] if len(parts) > 1 else "(repo root)"


# ---------------------------------------------------------------- owners

NODE_MATCHER = """
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const m = await import(pathToFileURL(input.matcher).href);
const ctx = m.context(input.root);
const modules = m.counted(input.touched, input.owners, ctx);
const ownerOf = Object.fromEntries(modules.map((x) => [x, m.ownerOf(x, input.owners, ctx.moves) ?? null]));
const owners = input.owners.map((o) => m.ownerOf(typeof o === 'string' ? o : o.module, [o], ctx.moves));
process.stdout.write(JSON.stringify({ modules, ownerOf, owners }));
"""


def match_owners(root, touched, owners):
    """The task's owners against the touched coordinates, through the scenario owner matcher (node)."""
    payload = json.dumps({"matcher": str(Path(root) / MATCHER), "root": str(root), "touched": touched, "owners": owners})
    proc = subprocess.run(["node", "--input-type=module", "-e", NODE_MATCHER], input=payload, capture_output=True, text=True)
    if proc.returncode != 0:
        raise Refused(f"the owner matcher failed: {proc.stderr.strip()}")
    got = json.loads(proc.stdout)
    modules = [m for m in got["modules"] if not m.startswith(NO_OWNER) and not m.endswith(".md")]
    hit = {got["ownerOf"][m] for m in modules if got["ownerOf"][m]}
    return {
        "touched": sorted(o for o in got["owners"] if o in hit),
        "missed": sorted(o for o in got["owners"] if o not in hit),
        "outside": sorted(m for m in modules if not got["ownerOf"][m]),
    }


# ---------------------------------------------------------------- gates


def target_dir(wt):
    common = Path(git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir").strip())
    return common.parent / ".rq-scratch" / "targets" / Path(wt).name


def related_tests(wt, changed):
    web = Path(wt) / "desktop/web"
    tests = [p for p in (web / "src").rglob("*") if p.is_file() and re.search(r"\.test\.[tj]sx?$", p.name)]
    picked = set()
    for path in changed:
        p = Path(wt) / path
        if not path.startswith(SRC):
            continue
        if re.search(r"\.test\.[tj]sx?$", path) and p.exists():
            picked.add(p)
            continue
        if not path.endswith((".ts", ".tsx")):
            continue
        stem = re.sub(r"\.tsx?$", "", Path(path).name)
        stem = Path(path).parent.name if stem == "index" else stem
        pat = re.compile(r"""['"/]""" + re.escape(stem) + r"""(\.tsx?|/index)?['"]""")
        for t in tests:
            if t.name.startswith(stem + ".") or pat.search(t.read_text(errors="replace")):
                picked.add(t)
    return sorted(str(t.relative_to(web)) for t in picked)


def run_gate(name, cmd, cwd, logdir, env=None):
    log = logdir / f"{name}.log"
    with open(log, "w") as fh:
        fh.write(f"$ (cd {cwd}) {' '.join(cmd)}\n")
        fh.flush()
        rc = subprocess.run(cmd, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT, env=dict(os.environ, **(env or {}))).returncode
    print(f"  {name}: {'pass' if rc == 0 else 'FAIL'} ({log})", flush=True)
    return {"gate": name, "result": "pass" if rc == 0 else "fail", "log": str(log)}


def run_gates(wt, changed, logdir):
    results, web = [], Path(wt) / "desktop/web"
    frontend = any(p.startswith("desktop/web/") for p in changed)
    contracts = any(p.startswith("common-types/") for p in changed)
    rust = [p for p in changed if p.endswith((".rs", "Cargo.toml"))]
    python = any(p.startswith("scripts/") and p.endswith(".py") for p in changed)
    if contracts:
        results.append(run_gate("check-types", ["npm", "run", "check:types"], web, logdir))
    if frontend or contracts:
        results.append(run_gate("typecheck", ["npm", "run", "typecheck"], web, logdir))
        tests = related_tests(wt, changed)
        (logdir / "vitest-files.txt").write_text("".join(f"{t}\n" for t in tests))
        if tests:
            results.append(run_gate("vitest", ["npx", "vitest", "run", "--maxWorkers=2", *tests], web, logdir))
        else:
            results.append({"gate": "vitest", "result": "skipped (no related tests)", "log": None})
        results.append(run_gate("test-policies", ["npm", "run", "test:policies"], web, logdir))
    if rust:
        env = {"CANOPI_SKIP_BUNDLED_DB": "1", "CARGO_TARGET_DIR": str(target_dir(wt))}
        results.append(run_gate("clippy", ["cargo", "clippy", "-p", "canopi-desktop", "--all-targets", "--", "-D", "warnings"], wt, logdir, env))
        mods = sorted({Path(p).parent.name if Path(p).stem in ("mod", "lib", "main") else Path(p).stem
                       for p in rust if p.startswith("desktop/src/")})
        results.append(run_gate("cargo-test-desktop", ["cargo", "test", "-p", "canopi-desktop", "--", *mods], wt, logdir, env))
        if contracts:
            results.append(run_gate("cargo-test-common-types", ["cargo", "test", "-p", "common-types"], wt, logdir, env))
    if python:
        results.append(run_gate("python-unittest", ["python3", "-m", "unittest", "discover", "-s", "scripts"], wt, logdir))
    return results


# ---------------------------------------------------------------- run


def score_run(task, wt, start, *, gates=True, logdir=None, root=REPO, transcript=None):
    """One run's record (see the header). The harness root supplies the layer table and the owner matcher."""
    wt = Path(wt).resolve()
    start = git(wt, "rev-parse", start).strip()
    files = changes(wt, start)
    rows = layer_rows(root)
    areas = {}
    for path in files:
        if is_test(rows, path):
            continue
        name = area(rows, wt, path)
        if name:
            areas.setdefault(name, []).append(path)
    owners = match_owners(root, [coordinate(p) for p in files], task["owners"])
    report = {
        "task": task["id"], "start": start, "head": git(wt, "rev-parse", "HEAD").strip(), "status": "scored",
        "files_changed": len(files),
        "lines_added": sum(a for a, _ in files.values()), "lines_removed": sum(r for _, r in files.values()),
        "test_files_changed": sum(1 for p in files if is_test(rows, p)),
        "areas": dict(sorted(areas.items())), "area_count": len(areas),
        "owners": owners, "owners_touched": len(owners["touched"]), "wrong_owner": len(owners["outside"]),
        "files": {p: {"added": a, "removed": r} for p, (a, r) in files.items()},
        "gates": [],
        "reviewer": {"violations": None, "notes": ""},
    }
    if transcript is not None:
        missing = not Path(transcript).is_file()
        report["transcript"] = {"path": str(transcript), "missing": missing}
        if not missing:
            report.update(transcripts.metrics(transcript, worktree=str(wt)))
    else:
        report["transcript"] = None
    if gates and files:
        logdir.mkdir(parents=True, exist_ok=True)
        report["gates"] = run_gates(wt, list(files), logdir)
    report["all_gates_pass"] = all(g["result"] != "fail" for g in report["gates"])
    return report


def default_out(task_id, phase, run):
    return REPO / ".rq-scratch" / "trials" / phase / f"{task_id}-r{run}.json"


def cmd_run(a):
    tasks = load_tasks()
    if a.task not in tasks:
        raise Refused(f"no task {a.task}; the tasks are {', '.join(tasks)}")
    out = Path(a.json) if a.json else default_out(a.task, a.phase, a.run)
    report = score_run(tasks[a.task], a.worktree, a.start, gates=not a.no_gates, logdir=out.with_suffix(".logs"), transcript=a.transcript)
    report.update({"run": a.run, "phase": a.phase})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"{a.task} run {a.run} at {a.phase}: {report['files_changed']} files, +{report['lines_added']} -{report['lines_removed']}, "
          f"{report['area_count']} areas, owners {report['owners_touched']}/{len(tasks[a.task]['owners'])}, wrong owner {report['wrong_owner']}")
    print(f"record: {out}")
    return 0 if report["all_gates_pass"] else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    run = sub.add_parser("run")
    run.add_argument("task")
    run.add_argument("worktree")
    run.add_argument("--start", required=True)
    run.add_argument("--run", type=int, default=1)
    run.add_argument("--phase", default="baseline")
    run.add_argument("--transcript")
    run.add_argument("--json")
    run.add_argument("--no-gates", action="store_true")
    a = ap.parse_args(argv)
    try:
        return {"run": cmd_run}[a.mode](a)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
