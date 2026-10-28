#!/usr/bin/env python3
"""Prepare and score one agent change trial (ADR 0028 stopping rule and trials; 2.1-Q226).

  score.py prepare <task> <start> <dir>
  score.py compare <baseline> <current>
  score.py run <task> <repo> --start COMMIT [--transcript JSONL] [--run N] [--phase P] [--json OUT] [--no-gates]

<task> is t1..t8 (tasks/<task>.json). prepare makes the trial repository in the new or empty <dir>: a repository of
its own whose one root commit, on main, is <start>'s tree with this harness directory removed, so the trial agent never
reads the tasks, seeds or scorer, and the task's seed applied, so the seed is never counted as the agent's change. Only
that commit's objects are copied, with a neutral message, so no history, ref or diff (`git show`, `git log --all`,
`git diff main`) reaches the harness, the seed or this repository. <dir> must sit outside this checkout and the main
checkout (whose .rq-scratch/ holds the worktrees and run records), so no relative path reaches them either; an agent
that searches the disk by absolute path can still find them. It then sets the repository up as mkwt.sh does a
worktree (catalog database, npm ci, PDF fonts) and prints the commit. A seed that no longer applies refuses the run as
a stale seed and makes nothing: main writes a new seed for the same bug (the task's expected-fix file describes it)
and notes the re-expression in the results; the old seed is never scored. run refuses a seeded task whose --start does
not hold its seed for the same reason.

--start is the run's start commit: the full hash prepare printed, never a ref (main moves with the trial agent's own
commits, which would then count as the start). A run counts the committed, staged, unstaged and untracked changes
against --start and writes one JSON record:

- files changed, lines added and removed, test files changed (`git diff --numstat`, untracked files whole);
- areas: a production file's area is its policy/layers.json row's `area` (longest row wins) under desktop/web/src,
  `desktop/web/<dir>` (or `desktop/web` for a file directly in it) for the rest of desktop/web, which sits inside the
  canopi-desktop package directory but holds no Rust, else its crate's package name for a file inside a Cargo package,
  else the top directory; tests have none;
- owners: every touched path in layer-table coordinates goes through the scenario owner matcher
  (policy/adapters/scenario-owners.mjs counted() and ownerOf(), 2.1-M170): tests and generated files are no modules,
  and the locale family and documentation (.md) are no owner either; `touched` and `missed` are the task's owners hit
  and not, `outside` the counted modules no owner covers (the wrong-owner edits);
- gates for the changed area, each pass or fail with its log beside the record: for Rust, clippy over the workspace
  and each touched crate's tests (every member's when common-types or a workspace manifest changed; canopi-desktop's
  filtered to the touched modules unless its crate root, build script or manifest changed). Each trial repository
  builds Rust in its own CARGO_TARGET_DIR under .rq-scratch/targets/<its name> (2.1-M201);
- with --transcript, the trial agent's metrics read by transcript.py (the one transcript reader): files read,
  tokens, gate failures before green. Without a transcript, or with a missing one, those keys are absent, never 0.
A transcript ending in a usage-limit stop leaves the run unscored: status `unscored`, unscored_reason `usage-limit`,
no metrics and no gates, so compare leaves it out of every median. Nothing schedules a resume: main reruns the task
from its start once the user types Resume.
compare reads two sets of run records, each a JSON file with `runs` (baseline.json), one record, or a directory of
records, and prints the median of each metric per task over its scored runs, baseline against current (a metric
absent from every run of a side is not compared); whether the run stayed green is one, from the scorer's own gates. It names each task whose median got worse on any metric and exits 1
when one did: at Phases 1-3 each such task is rerun three times (2.1-Q226).
Violations caught only by review stay the reviewer's field (ADR 0028), filled in by hand; compare reads them as a
metric once filled.

The layer table, rules and matcher are this checkout's (the harness); the trial repository only supplies the diff.
"""
import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
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


def git(wt, *args, env=None):
    return subprocess.run(["git", "-C", str(wt), *args], check=True, capture_output=True, text=True,
                          env=dict(os.environ, **env) if env else None).stdout


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
    parts = path.split("/")
    if path.startswith("desktop/web/"):
        return "/".join(parts[:3]) if len(parts) > 3 else "desktop/web"
    return crate_of(wt, path) or (parts[0] if len(parts) > 1 else "(repo root)")


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


def scratch(checkout):
    """The main checkout's .rq-scratch/, wherever its worktree checkout sits."""
    return Path(git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()).parent / ".rq-scratch"


def target_dir(wt):
    return scratch(REPO) / "targets" / Path(wt).name


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


# A change to the canopi-desktop crate root, build script or manifest reaches every module's tests.
DESKTOP_WHOLE_CRATE = {"desktop/src/lib.rs", "desktop/src/main.rs", "desktop/build.rs", "desktop/Cargo.toml"}


def desktop_test_filter(changed):
    """The canopi-desktop test filter: each touched module's name (a mod.rs names its directory), or none, so the
    whole crate's tests run, when the crate root, build script or manifest changed."""
    if DESKTOP_WHOLE_CRATE & set(changed):
        return []
    return sorted({Path(p).parent.name if Path(p).name == "mod.rs" else Path(p).stem
                   for p in changed if p.startswith("desktop/src/") and p.endswith(".rs")})


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
        results.append(run_gate("clippy", ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], wt, logdir, env))
        crates = sorted({crate_of(wt, p) or "" for p in rust})
        if "" in crates or "common-types" in crates:  # the workspace manifest and the shared contracts reach every member
            results.append(run_gate("cargo-test-workspace", ["cargo", "test", "--workspace"], wt, logdir, env))
            crates = []
        for crate in crates:
            mods = desktop_test_filter(changed) if crate == "canopi-desktop" else []
            results.append(run_gate(f"cargo-test-{crate}", ["cargo", "test", "-p", crate, *(["--", *mods] if mods else [])], wt, logdir, env))
    if python:
        results.append(run_gate("python-unittest", ["python3", "-m", "unittest", "discover", "-s", "scripts"], wt, logdir))
    return results


# ---------------------------------------------------------------- prepare

HARNESS = HERE.relative_to(REPO).as_posix()


def stale(task, start, why):
    return Refused(f"stale seed: {task['seed']} {why} at {start}; main writes a new seed for the same bug "
                   f"({task.get('expected', 'the expected-fix file')} describes it) against this start and notes the "
                   "re-expression in the results; the old seed is never scored")


def seed_applies(wt, commit, seed, reverse=False):
    """Whether the seed applies (or, reversed, is applied) to commit's tree, read in a temporary index."""
    with tempfile.TemporaryDirectory() as tmp:
        env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
        git(wt, "read-tree", commit, env=env)
        args = ["apply", "--cached", "--check", *(["-R"] if reverse else []), str(seed)]
        return subprocess.run(["git", "-C", str(wt), *args], capture_output=True, env=dict(os.environ, **env)).returncode == 0


def prepare(task, start, dest, source=REPO):
    """The trial repository at dest (see the header): a new repository whose one root commit, on main, is start's tree
    with the harness removed and the seed applied. Only that commit's objects are copied, so no history, ref or message
    reaches the harness, the seed or main; made with plumbing, which runs no hook. Returns the commit."""
    dest = Path(dest).resolve()
    for checkout in {Path(source).resolve(), scratch(source).parent}:
        if dest == checkout or checkout in dest.parents:
            raise Refused(f"{dest} is inside the checkout {checkout}, whose harness, seeds and earlier run records (and "
                          ".rq-scratch/ worktrees) the trial agent could read from the filesystem; prepare makes the trial "
                          "repository outside it")
    if dest.exists() and any(dest.iterdir()):
        raise Refused(f"{dest} is not empty; prepare makes the trial repository in a new or empty directory")
    base = git(source, "rev-parse", "--verify", f"{start}^{{commit}}").strip()
    seed = HERE / task["seed"] if task.get("seed") else None
    if seed and not seed_applies(source, base, seed):
        raise stale(task, base, "no longer applies")
    with tempfile.TemporaryDirectory() as tmp:
        env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
        git(source, "read-tree", base, env=env)
        git(source, "rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", HARNESS, env=env)
        if seed:
            git(source, "apply", "--cached", str(seed), env=env)
        tree = git(source, "write-tree", env=env).strip()
    commit = git(source, "commit-tree", tree, "-m", "Start").strip()
    dest.mkdir(parents=True, exist_ok=True)
    git(dest, "init", "-q", "-b", "main")
    objects = git(source, "rev-list", "--objects", commit)
    pack = subprocess.run(["git", "-C", str(source), "pack-objects", "--stdout", "-q"], input=objects.encode(),
                          capture_output=True, check=True).stdout
    subprocess.run(["git", "-C", str(dest), "index-pack", "--stdin"], input=pack, capture_output=True, check=True)
    git(dest, "update-ref", "refs/heads/main", commit)
    git(dest, "read-tree", "-u", "--reset", "HEAD")
    return commit


def setup(dest):
    """What a trial agent needs beside the source: the pinned catalog database (copied, never changed), the npm
    dependencies and the PDF fonts, as mkwt.sh sets up a worktree."""
    db = scratch(REPO) / "shared-build" / "canopi-core.db"
    if db.is_file():
        (Path(dest) / "desktop/resources").mkdir(parents=True, exist_ok=True)
        shutil.copy2(db, Path(dest) / "desktop/resources" / db.name)
    web = Path(dest) / "desktop/web"
    for cmd in (["npm", "ci"], ["npm", "run", "prepare:pdf-fonts"]):
        proc = subprocess.run(cmd, cwd=web, capture_output=True, text=True, env=dict(os.environ, HUSKY="0"))
        if proc.returncode != 0:
            raise Refused(f"setup failed in {web}: {' '.join(cmd)}: {proc.stderr.strip()[-2000:]}")


def cmd_prepare(a):
    tasks = load_tasks()
    if a.task not in tasks:
        raise Refused(f"no task {a.task}; the tasks are {', '.join(tasks)}")
    start = prepare(tasks[a.task], a.start, a.dest)
    setup(a.dest)
    print(f"start: {start}")
    print(f"export CARGO_TARGET_DIR={target_dir(a.dest)}")
    return 0


# ---------------------------------------------------------------- run


def score_run(task, wt, start, *, gates=True, logdir=None, root=REPO, transcript=None):
    """One run's record (see the header). The harness root supplies the layer table and the owner matcher."""
    wt = Path(wt).resolve()
    if not re.fullmatch(r"[0-9a-f]{40}([0-9a-f]{24})?", start):
        raise Refused(f"--start {start} is not a commit hash: score from the commit prepare printed, which no commit the "
                      "trial agent makes can move (main moves with the agent's own commits)")
    start = git(wt, "rev-parse", "--verify", f"{start}^{{commit}}").strip()
    if task.get("seed") and not seed_applies(wt, start, HERE / task["seed"], reverse=True):
        raise Refused(f"stale seed: {task['seed']} is not applied at {start}; score from the start commit prepare printed "
                      "(a seed prepare refused is re-expressed by main, never scored)")
    if transcript is not None and Path(transcript).is_file() and transcripts.ends_in_usage_limit(transcript):
        return {"task": task["id"], "start": start, "head": git(wt, "rev-parse", "HEAD").strip(), "status": "unscored",
                "unscored_reason": "usage-limit", "transcript": {"path": str(transcript), "missing": False},
                "reviewer": {"violations": None, "notes": ""}}
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


# ---------------------------------------------------------------- compare

# Each metric is lower-is-better; owners_missed counts the task's owners the run left untouched, gates_red is 1 for a
# run whose scorer gates ended with one failing (absent for a run with no gates), review_violations the reviewer's count
# (absent until reviewed).
METRICS = {
    "files_changed": lambda r: r.get("files_changed"),
    "lines": lambda r: r["lines_added"] + r["lines_removed"] if "lines_added" in r else None,
    "area_count": lambda r: r.get("area_count"),
    "wrong_owner": lambda r: r.get("wrong_owner"),
    "owners_missed": lambda r: len(r["owners"]["missed"]) if "owners" in r else None,
    "files_read": lambda r: r.get("files_read"),
    "tokens": lambda r: r["tokens"]["total"] if "tokens" in r else None,
    "gate_failures": lambda r: r.get("gate_failures"),
    "gates_red": lambda r: int(not r["all_gates_pass"]) if r.get("gates") else None,
    "review_violations": lambda r: (r.get("reviewer") or {}).get("violations"),
}


def compare(baseline, current):
    """{tasks: {task: {runs, metric: {baseline, current}}}, worse: {task: [metric]}} over the scored runs."""
    tasks, worse = {}, {}
    for tid in sorted({r["task"] for r in baseline + current}):
        base = [r for r in baseline if r["task"] == tid and r.get("status") == "scored"]
        now = [r for r in current if r["task"] == tid and r.get("status") == "scored"]
        unscored = sum(1 for r in current if r["task"] == tid and r.get("status") != "scored")
        row = {"runs": {"baseline": len(base), "current": len(now), "unscored": unscored}}
        for name, read in METRICS.items():
            b = [v for v in map(read, base) if v is not None]
            c = [v for v in map(read, now) if v is not None]
            if b and c:
                row[name] = {"baseline": statistics.median(b), "current": statistics.median(c)}
                if row[name]["current"] > row[name]["baseline"]:
                    worse.setdefault(tid, []).append(name)
        tasks[tid] = row
    return {"tasks": tasks, "worse": worse}


def load_runs(path):
    path = Path(path)
    docs = [json.loads(p.read_text()) for p in sorted(path.rglob("*.json"))] if path.is_dir() else [json.loads(path.read_text())]
    return [r for d in docs for r in (d["runs"] if "runs" in d else [d])]


def cmd_compare(a):
    got = compare(load_runs(a.baseline), load_runs(a.current))
    for tid, row in got["tasks"].items():
        runs = row["runs"]
        cells = [f"{name} {v['baseline']:g} -> {v['current']:g}" for name, v in row.items() if name != "runs"]
        print(f"{tid} ({runs['baseline']} baseline runs, {runs['current']} current, {runs['unscored']} unscored): {'; '.join(cells)}")
    if got["worse"]:
        print("worse: " + "; ".join(f"{tid} ({', '.join(names)})" for tid, names in got["worse"].items())
              + " - rerun each three times (2.1-Q226)")
        return 1
    print("worse: none")
    return 0


def default_out(task_id, phase, run):
    return scratch(REPO) / "trials" / phase / f"{task_id}-r{run}.json"


def cmd_run(a):
    tasks = load_tasks()
    if a.task not in tasks:
        raise Refused(f"no task {a.task}; the tasks are {', '.join(tasks)}")
    out = Path(a.json) if a.json else default_out(a.task, a.phase, a.run)
    report = score_run(tasks[a.task], a.worktree, a.start, gates=not a.no_gates, logdir=out.with_suffix(".logs"), transcript=a.transcript)
    report.update({"run": a.run, "phase": a.phase})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if report["status"] == "unscored":
        print(f"{a.task} run {a.run} at {a.phase}: unscored, the transcript ends in a usage-limit stop; nothing is scheduled: "
              "rerun the task from its start once the user types Resume")
        print(f"record: {out}")
        return 0
    print(f"{a.task} run {a.run} at {a.phase}: {report['files_changed']} files, +{report['lines_added']} -{report['lines_removed']}, "
          f"{report['area_count']} areas, owners {report['owners_touched']}/{len(tasks[a.task]['owners'])}, wrong owner {report['wrong_owner']}")
    print(f"record: {out}")
    return 0 if report["all_gates_pass"] else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("task")
    prep.add_argument("start")
    prep.add_argument("dest")
    run = sub.add_parser("run")
    run.add_argument("task")
    run.add_argument("worktree")
    run.add_argument("--start", required=True)
    run.add_argument("--run", type=int, default=1)
    run.add_argument("--phase", default="baseline")
    run.add_argument("--transcript")
    run.add_argument("--json")
    run.add_argument("--no-gates", action="store_true")
    comp = sub.add_parser("compare")
    comp.add_argument("baseline")
    comp.add_argument("current")
    a = ap.parse_args(argv)
    try:
        return {"prepare": cmd_prepare, "run": cmd_run, "compare": cmd_compare}[a.mode](a)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
