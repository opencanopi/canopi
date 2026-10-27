#!/usr/bin/env python3
"""The one gate table (2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q205; contracts §12; ADR 0028 Agent enforcement).

    python3 scripts/gate.py affected --base <rev> [--print]   the checks for what changed since merge-base(rev, HEAD)
    python3 scripts/gate.py affected --staged [--print]       the commit lane: the checks for the staged change
    python3 scripts/gate.py full [--area <a>]... [--print]    AGENTS.md's Quality gates rows, every area or the named ones
    python3 scripts/gate.py areas --base <rev>                the areas a change selects and every area's patterns, as
                                                              JSON, running no tool (CI's changes job)

AREAS maps each area to its anchored path regexes (never globs: picomatch through policy/check.mjs is the one glob
engine), its AGENTS.md row and its checks per lane; `check_docs.py` compares the rows with AGENTS.md. `--print` writes
JSON for quiet-gates and CI: the checks, every area with its patterns and the e2e run. Everything else
around a run (Docker sharding, logs, markers, ownership) is orchestration and stays outside the repository.

The affected lane runs each selected area's checks plus the always-run families on any change but docs or beads: the
source-text scanners and policy tests (found by content), the tests AGENTS.md cites, the locale tests, the tests beside
changed modules, `vitest related` over the changed files and the modules that reach them in the dependency graph, and
`npm run test:policies`. The commit lane (`--staged`) runs only each matched area's commit checks, with npm offline
(2.1-M201, 2.1-M230): `npm run typecheck` for Frontend, `cargo fmt` and the policy families for Rust, the policy
families for policy and toolchain changes, the Docs row for documentation; a path no area matches (a script, a workflow,
a root file) runs nothing at commit and is named in a note, its checks running at the affected gate. The gate itself
writes nothing.
"""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
WEB = "desktop/web"
SKIP_DB = "CANOPI_SKIP_BUNDLED_DB=1"
LOCK_WAIT = 60  # seconds a check may wait on one busy file lock (cargo's build or package cache) before it fails (plan:169)


@dataclass(frozen=True)
class Check:
    command: str           # as AGENTS.md writes it, run from `cwd` (leading NAME=value words are its environment)
    cwd: str = ""
    row: str | None = "="  # how the AGENTS.md row names it: "=" the display form, None prose only ("its Python tests")
    cargo: bool = False    # builds through cargo, so it takes the build lock and needs a per-worktree target
    ci_only: bool = False  # a CI lane no local run can make (named, never run)

    @property
    def display(self):
        return f"cd {self.cwd} && {self.command}" if self.cwd else self.command

    @property
    def row_text(self):
        return self.display if self.row == "=" else self.row


def web(command, **kw):
    return Check(command, cwd=WEB, **kw)


TYPECHECK = web("npm run typecheck")
CHECK_UI = web("npm run check:ui")
POLICIES = web("npm run test:policies")
FMT = Check("cargo fmt --all -- --check")
CARGO_TEST = Check(f"{SKIP_DB} cargo test --workspace", cargo=True)
DOCS = Check("python3 scripts/check_docs.py")


@dataclass(frozen=True)
class Area:
    name: str
    label: str              # AGENTS.md's Change cell
    run: str                # AGENTS.md's Run cell, verbatim
    patterns: tuple
    full: tuple
    affected: tuple = ()
    commit: tuple = ()
    covered_by: tuple = field(default=())  # an affected check another selected area's check already runs

    def matches(self, path):
        return any(re.search(p, path) for p in self.patterns)


# The Rust row as AGENTS.md has it; F2's merge drops check_unused_crates.py here and there together (2.1-Q13).
UNUSED_CRATES = Check("python3 scripts/check_unused_crates.py")
AREAS = (
    Area("rust", "Rust",
         "`cargo fmt --all -- --check`; `CANOPI_SKIP_BUNDLED_DB=1 cargo clippy --workspace --all-targets -- -D warnings`; "
         "`CANOPI_SKIP_BUNDLED_DB=1 cargo test --workspace`; `cargo cov` above its floor; "
         "`cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push`; `python3 scripts/check_unused_crates.py` "
         "(validator changes: `python3 -m unittest scripts.test_check_unused_crates`)",
         (r"\.rs$", r"(^|/)Cargo\.(toml|lock)$", r"^(rust-toolchain|clippy|deny)\.toml$", r"^\.cargo/",
          r"^\.github/workflows/(build|release-candidate)\.yml$"),
         full=(FMT, Check(f"{SKIP_DB} cargo clippy --workspace --all-targets -- -D warnings", cargo=True), CARGO_TEST,
               Check("cargo cov", row="`cargo cov` above its floor", cargo=True),
               web(f"{SKIP_DB} npm run test:policies:push", cargo=True), UNUSED_CRATES,
               Check("python3 -m unittest scripts.test_check_unused_crates")),
         affected=(FMT, Check(f"{SKIP_DB} cargo clippy --workspace --all-targets -- -D warnings", cargo=True), CARGO_TEST,
                   web(f"{SKIP_DB} npm run test:policies:push", cargo=True), UNUSED_CRATES),
         commit=(FMT, POLICIES)),
    # native_command_policy also reads the web files that call invoke() (build.yml's web_rust_paths).
    Area("tauri-command", "A `#[tauri::command]`",
         "`CANOPI_SKIP_BUNDLED_DB=1 cargo test -p canopi-desktop native_command_policy::tests`",
         (r"^desktop/src/.*\.rs$", r"^desktop/web/src/ipc/"),
         full=(Check(f"{SKIP_DB} cargo test -p canopi-desktop native_command_policy::tests", cargo=True),),
         covered_by=(CARGO_TEST.display,)),
    Area("shared-contracts", "Shared contracts (`common-types/`)",
         "`cd desktop/web && npm run gen:types && npm run check:types`",
         (r"^common-types/", r"^bindings-gen/"),
         full=(web("npm run gen:types", cargo=True), web("npm run check:types", cargo=True))),
    # `^policy/` and the ast-grep config run the policy lane (K's bead note); the gallery also runs the root typecheck.
    Area("frontend", "Frontend",
         "`cd desktop/web && npm run typecheck && npm run test:coverage -- --maxWorkers=4 && npm run test:policies && "
         "npm run check:ui && npm run build && npm run build:web`",
         (r"^desktop/web/(?!.*\.md$)", r"^policy/", r"^sgconfig\.yml$", r"(^|/)THIRD_PARTY_NOTICES\.md$"),
         full=(TYPECHECK, web("npm run test:coverage -- --maxWorkers=4"), POLICIES, CHECK_UI, web("npm run build"),
               web("npm run build:web")),
         affected=(TYPECHECK, CHECK_UI),
         commit=(TYPECHECK,)),
    Area("species-catalog", "Species catalog queries",
         "`python3 scripts/species_catalog_contract.py check` and its Python tests",
         (r"^desktop/src/services/species_catalog", r"^desktop/src/db/", r"^scripts/(test_)?species_catalog_contract\.py$",
          r"^scripts/schema-contract\.json$", r"^common-types/plant-filter-fields\.json$"),
         full=(Check("python3 scripts/species_catalog_contract.py check"),
               Check("python3 -m unittest scripts.test_species_catalog_contract", row=None))),
    Area("lidar", "LiDAR services",
         "the engine lane (CI job `lidar-native`) and the comparison lane ([data library](docs/guides/data-library.md))",
         (r"^desktop/src/services/lidar/",),
         full=(Check("CI job lidar-native: the engine lane", row="lidar-native", ci_only=True),
               Check("the comparison lane (docs/guides/data-library.md)", row=None, ci_only=True))),
    Area("docs", "Docs",
         "`python3 scripts/check_docs.py` and its `--drift origin/main` (validator changes: "
         "`python3 -m unittest scripts.test_check_docs`)",
         (r"\.md$", r"^docs/", r"^\.interface-design/", r"^scripts/(test_)?check_docs[a-z_]*\.py$"),
         full=(DOCS, Check("python3 scripts/check_docs.py --drift origin/main", row="--drift origin/main"),
               Check("python3 -m unittest scripts.test_check_docs"))),
)
BY_NAME = {area.name: area for area in AREAS}
TOOLCHAIN = re.compile(r"^desktop/web/(package(-lock)?\.json|vite\.config\.ts|tsconfig[^/]*\.json)$")
POLICY_PATH = re.compile(r"^(policy/|sgconfig\.yml$)")
DOCS_ONLY = re.compile(r"^(\.beads/|docs/|\.interface-design/)|\.md$")
NOT_DOCS = re.compile(r"(^|/)THIRD_PARTY_NOTICES\.md$")
DOCS_VALIDATOR = re.compile(r"^scripts/(test_)?check_docs[a-z_]*\.py$")
WEB_MODULE = re.compile(r"^desktop/web/((?:src|ui-gallery)/.*\.(?:tsx?|css))$")
SPEC = re.compile(r"^desktop/web/(e2e/.*\.spec\.ts)$")
# The always-run families, by content: a scanner reads source text, a locale test imports a locale file.
SCANNER = re.compile(r"policy-harness|readdirSync|readFileSync\(\s*(?:new URL\(|[`'\"](?:\./)?src/)")
LOCALE = re.compile(r"from ['\"]\.\./i18n/[a-z-]+\.json['\"]")
CITED = re.compile(r"`([A-Za-z0-9_.-]+\.test\.tsx?)`")
E2E_CANVAS = re.compile(r"^desktop/web/src/(styles/|app/shell/visible-map-area\.ts$)")
E2E_GALLERY = re.compile(r"^desktop/web/(src/components/|ui-gallery/)")


class GateError(Exception):
    """The gate cannot judge the change: it refuses, never reads it as passing."""


def git(*args, check=True):
    """git on this checkout. Every GIT_* variable but the index goes: `git commit -a` and `git commit <path>` hand the
    hook the index they commit through GIT_INDEX_FILE, which may be relative to the hook's directory."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    if os.environ.get("GIT_INDEX_FILE"):
        env["GIT_INDEX_FILE"] = os.path.abspath(os.environ["GIT_INDEX_FILE"])
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, env=env)
    if check and result.returncode != 0:
        raise GateError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def changed(base, staged):
    if staged:
        return [p for p in git("diff", "--cached", "--name-only", "-z").split("\0") if p]
    merge_base = git("merge-base", base, "HEAD").strip()
    return sorted({p for p in git("diff", "--name-only", "-z", merge_base).split("\0") if p}
                  | {p for p in git("ls-files", "--others", "--exclude-standard", "-z").split("\0") if p})


def families(paths):
    """The vitest files every affected run adds, as desktop/web-relative paths."""
    tests = ROOT / WEB / "src/__tests__"
    found = set()
    agents = ROOT / "AGENTS.md"
    cited = set(CITED.findall(agents.read_text(encoding="utf-8"))) if agents.is_file() else set()
    for test in sorted(tests.glob("*.test.ts*")) if tests.is_dir() else ():
        text = test.read_text(encoding="utf-8", errors="replace")
        if SCANNER.search(text) or LOCALE.search(text) or test.name in cited:
            found.add(f"src/__tests__/{test.name}")
    for path in paths:  # the tests beside changed modules, and changed tests themselves
        match = WEB_MODULE.match(path)
        if not match:
            continue
        stem = re.sub(r"(\.test)?\.(tsx?|css)$", "", match[1])
        found.update(f"{stem}{suffix}" for suffix in (".test.ts", ".test.tsx") if (ROOT / WEB / f"{stem}{suffix}").is_file())
    return sorted(found)


def python_tests(paths):
    modules = set()
    for path in paths:
        match = re.match(r"^scripts/(?:test_)?([a-z0-9_]+)\.py$", path)
        if match and (ROOT / f"scripts/test_{match[1]}.py").is_file():
            modules.add(f"scripts.test_{match[1]}")
    return sorted(modules)


def reaching(modules):
    """The modules that reach `modules` (desktop/web-relative) in the dependency graph. `depcruise --affected` cannot
    serve here: its changed-file regex holds repository-root paths, which never match the cruise's desktop/web-relative
    sources (the c3 probe), and it cannot read the index; the same reach goes through `--reaches`."""
    if not modules:
        return []
    cruiser = ROOT / WEB / "node_modules/.bin/depcruise"
    if not cruiser.is_file():
        raise GateError(f"{cruiser.relative_to(ROOT)} is missing: run npm ci in {WEB}")
    reach = "^(?:" + "|".join(re.escape(m) for m in modules) + ")$"
    result = subprocess.run([str(cruiser), "--config", ".dependency-cruiser.web.cjs", "--output-type", "json",
                             "--reaches", reach, "src", "ui-gallery"], cwd=ROOT / WEB, capture_output=True, text=True)
    try:
        return sorted({m["source"] for m in json.loads(result.stdout)["modules"]} - set(modules))
    except (ValueError, KeyError) as error:
        raise GateError(f"depcruise --reaches gave no module list (exit {result.returncode}): "
                        f"{result.stderr.strip()[:300] or error}") from None


def e2e_plan(paths):
    specs = {SPEC.match(p)[1] for p in paths if SPEC.match(p) and (ROOT / p).is_file()}
    if any(E2E_CANVAS.match(p) for p in paths):
        specs = {s for s in specs if not s.startswith("e2e/canvas/")} | {"e2e/canvas"}
    if any(E2E_GALLERY.match(p) for p in paths):
        specs = {s for s in specs if not s.startswith("e2e/gallery/")} | {"e2e/gallery"}
    if not specs:
        return None
    projects = ["chromium", "webkit"]
    if any(s.startswith("e2e/gallery") for s in specs):
        projects += ["gallery-chromium", "gallery-webkit"]
    return e2e_run(sorted(specs), projects)


def playwright_image():
    lock = ROOT / WEB / "package-lock.json"
    try:
        version = json.loads(lock.read_text(encoding="utf-8"))["packages"]["node_modules/@playwright/test"]["version"]
    except (OSError, ValueError, KeyError):
        raise GateError(f"{lock.relative_to(ROOT)} names no @playwright/test version: the e2e image is unknown") from None
    return f"mcr.microsoft.com/playwright:v{version}-noble"


def e2e_run(specs, projects):
    """The pinned image's run (plan:165): browsers come only from the image, never the host. The container keeps its own
    network, so no port is published and two worktrees' runs never share a server on the default ports."""
    image = playwright_image()
    args = " ".join(specs + [f"--project={p}" for p in projects])
    command = (f"docker run --rm --ipc=host -v {shlex.quote(str(ROOT))}:/work -w /work/{WEB} --user {os.getuid()}:{os.getgid()} "
               f"-e HOME=/tmp {image} npx playwright test {args} --pass-with-no-tests --reporter=line")
    return {"image": image, "specs": specs, "projects": projects, "needs": "npm run build:web", "command": command}


def plan_affected(paths, staged, base=None):
    areas = [a for a in AREAS if any(a.matches(p) for p in paths)]
    if all(p.startswith(".beads/") for p in paths):
        return areas, [], None, []
    docs_only = all(DOCS_ONLY.search(p) and not NOT_DOCS.search(p) for p in paths)
    notes, checks = [], []
    toolchain = any(TOOLCHAIN.match(p) for p in paths)
    if staged:
        for area in areas:
            if area.name == "docs":
                base = git("merge-base", "HEAD", "origin/main").strip()
                checks += [DOCS, Check(f"python3 scripts/check_docs.py --drift {base}")]
            checks += list(area.commit)
        if toolchain:
            checks.append(POLICIES)
            notes.append("a toolchain file changed: the whole Vitest suite runs at the affected gate")
        if any(POLICY_PATH.match(p) for p in paths):
            checks.append(POLICIES)
        # A path is covered only by an area that runs something here: docs runs DOCS, the rest their commit checks.
        uncovered = sorted(p for p in paths if not p.startswith(".beads/")
                           and not any(a.matches(p) and (a.commit or a.name == "docs") for a in AREAS))
        if uncovered:
            notes.append(f"no commit check covers {', '.join(uncovered)}; the affected gate runs their checks")
        return areas, dedupe(checks), None, notes
    selected = {c.display for a in areas for c in (a.affected or a.full)}
    for area in areas:
        if area.name == "docs":
            checks += [DOCS, Check(f"python3 scripts/check_docs.py --drift {base}")]
            if any(DOCS_VALIDATOR.match(p) for p in paths):
                checks.append(area.full[2])
            continue
        for check in area.affected or area.full:
            if area.covered_by and set(area.covered_by) <= selected - {check.display}:
                continue
            checks.append(check)
        if area.name == "frontend" and any(p.startswith(f"{WEB}/ui-gallery/") for p in paths) and TYPECHECK not in checks:
            checks.append(TYPECHECK)
    e2e = None
    if not docs_only:
        checks += [Check(f"python3 -m unittest {m}") for m in python_tests(paths)]
        checks.append(web("npm run prepare:pdf-fonts"))
        if toolchain:
            checks.append(web("npx vitest run --maxWorkers=4"))
            notes.append("a toolchain file changed: the whole Vitest suite runs")
        else:
            modules = [WEB_MODULE.match(p)[1] for p in paths if WEB_MODULE.match(p) and (ROOT / p).is_file()]
            sources = [m for m in modules if not re.search(r"\.test\.tsx?$", m)]
            reached = reaching([m for m in sources if not m.endswith(".css")])
            related = sorted(set(sources) | {m for m in reached if not re.search(r"\.test\.tsx?$", m)})
            if related:
                checks.append(web("npx vitest related --run --maxWorkers=4 " + " ".join(related)))
            tests = sorted(set(families(paths)) | {m for m in reached if re.search(r"\.test\.tsx?$", m)})
            if tests:
                checks.append(web("npx vitest run --maxWorkers=4 " + " ".join(tests)))
        checks.append(POLICIES)
        e2e = e2e_plan(paths)
        if e2e:
            checks.append(web("npm run build:web"))
    return areas, dedupe(checks), e2e, notes


def plan_full(names):
    unknown = [n for n in names if n not in BY_NAME]
    if unknown:
        raise GateError(f"unknown area {', '.join(unknown)}; areas: {', '.join(BY_NAME)}")
    areas = [BY_NAME[n] for n in names] if names else list(AREAS)
    return areas, dedupe([c for a in areas for c in a.full]), None, []


def dedupe(checks):
    seen, out = set(), []
    for check in checks:
        if check.display not in seen:
            seen.add(check.display)
            out.append(check)
    return out


def linked_worktree():
    return Path(git("rev-parse", "--absolute-git-dir").strip()) != Path(git("rev-parse", "--path-format=absolute",
                                                                             "--git-common-dir").strip())


def refuse_shared_target(checks):
    if any(c.cargo for c in checks) and not os.environ.get("CARGO_TARGET_DIR") and linked_worktree():
        raise GateError("a linked worktree builds Rust with its own CARGO_TARGET_DIR (2.1-M201): set CARGO_TARGET_DIR "
                        "to the worktree's target under .rq-scratch/targets/ before a Rust gate")


def to_json(areas, checks, e2e, notes):
    return {
        "checks": [c.display for c in checks if not c.ci_only],
        "ci_only": [c.display for a in areas for c in a.full if c.ci_only],
        "selected": [a.name for a in areas],
        "areas": [{"name": a.name, "label": a.label, "patterns": list(a.patterns)} for a in AREAS],
        "e2e": e2e,
        "notes": notes,
    }


# --- running ----------------------------------------------------------------------------------------------------------

def split_env(command):
    words = shlex.split(command)
    env = {}
    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        name, value = words.pop(0).split("=", 1)
        env[name] = value
    return env, words


def run_check(display, argv, cwd, env):
    """One check, its output passed through. A process of the check waiting LOCK_WAIT seconds on one file lock stops it.

    The kernel's lock table (/proc/locks) shows the wait, so a cargo run nested in a tool that captures its output or
    passes --quiet (policy/adapters/clippy.mjs) is bounded like a direct one; where the system has no such table
    (Windows, macOS) the wait is not bounded.
    """
    print(f"gate: {display}", file=sys.stderr, flush=True)
    process = subprocess.Popen(argv, cwd=cwd, env=env, start_new_session=True)
    wait = float(os.environ.get("CANOPI_GATE_LOCK_WAIT", LOCK_WAIT))
    waiting = {}  # (pid, lock) -> when the check was first seen waiting on it
    try:
        while process.poll() is None:
            now = time.monotonic()
            waiting = {key: waiting.get(key, now) for key in lock_waits(process.pid)}
            stuck = next((key for key, since in waiting.items() if now - since > wait), None)
            if stuck:
                what = locked_path(*stuck)
                stop(process)
                print(f"gate: FAIL {display}: the file lock on {what} stayed busy for {wait:g} s; another process holds "
                      "it (a per-worktree CARGO_TARGET_DIR avoids sharing cargo's build lock, 2.1-M201)", file=sys.stderr)
                return 1
            time.sleep(0.1)
    except KeyboardInterrupt:
        stop(process, signal.SIGINT)
        raise
    return process.returncode


def lock_waits(group):
    """(pid, "maj:min:inode") for each lock a process of process group `group` is blocked on; /proc/locks marks a
    blocked request `->`."""
    try:
        table = Path("/proc/locks").read_text(encoding="utf-8")
    except OSError:
        return set()
    waits = set()
    for line in table.splitlines():
        words = line.split()
        if len(words) > 6 and words[1] == "->":
            try:
                if os.getpgid(int(words[5])) == group:
                    waits.add((int(words[5]), words[6]))
            except (OSError, ValueError):
                pass  # the waiter has gone
    return waits


def locked_path(pid, lock):
    """The path `pid` holds open whose device and inode are `lock`, or `lock` itself."""
    try:
        for fd in Path(f"/proc/{pid}/fd").iterdir():
            try:
                st = fd.stat()
            except OSError:
                continue
            if f"{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino}" == lock:
                return os.readlink(fd)
    except OSError:
        pass
    return lock


def stop(process, first=signal.SIGTERM):
    try:
        os.killpg(process.pid, first)
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        pass


def ensure_image(image):
    """The pinned image or nothing: a missing image that cannot be pulled fails; host browsers are never used."""
    try:
        if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0:
            return
        pulled = subprocess.run(["docker", "pull", image], capture_output=True, text=True)
    except FileNotFoundError:
        raise GateError(f"docker is not installed: e2e runs only in {image}, never in host browsers") from None
    if pulled.returncode != 0:
        raise GateError(f"the e2e image {image} is missing and could not be pulled ({pulled.stderr.strip()[:200]}); "
                        "e2e runs only in that image, never in host browsers")


def execute(checks, e2e, notes, staged):
    env = dict(os.environ)
    if staged:
        env["npm_config_offline"] = "true"
    for note in notes:
        print(f"gate: {note}", file=sys.stderr)
    failed = []
    for check in checks:
        if check.ci_only:
            print(f"gate: CI only: {check.display}", file=sys.stderr)
            continue
        extra, argv = split_env(check.command)
        if run_check(check.display, argv, ROOT / check.cwd, {**env, **extra}) != 0:
            failed.append(check.display)
            if staged:
                break
    if e2e and not failed:
        ensure_image(e2e["image"])
        name = f"e2e in {e2e['image']}"
        if run_check(name, shlex.split(e2e["command"]), ROOT, env) != 0:
            failed.append(name)
    for name in failed:
        print(f"gate: FAIL {name}", file=sys.stderr)
    print(f"gate: {'GREEN' if not failed else 'RED'} ({len(checks) - len(failed)} passed, {len(failed)} failed)",
          file=sys.stderr)
    return 1 if failed else 0


def main(argv):
    args = argv[1:]
    printing = "--print" in args
    args = [a for a in args if a != "--print"]
    try:
        if args[:1] == ["areas"] and "--base" in args[:-1]:
            paths = changed(args[args.index("--base") + 1], False)
            selected = [a.name for a in AREAS if any(a.matches(p) for p in paths)]
            print(json.dumps({"selected": selected, "areas": to_json([], [], None, [])["areas"]}, indent=2))
            return 0
        if args[:1] == ["affected"] and ("--staged" in args or "--base" in args[:-1]):
            staged = "--staged" in args
            base = None if staged else args[args.index("--base") + 1]
            plan = plan_affected(changed(base, staged), staged, base)
        elif args[:1] == ["full"]:
            names = [args[i + 1] for i, a in enumerate(args[:-1]) if a == "--area"]
            plan, staged = plan_full(names), False
        else:
            print(__doc__, file=sys.stderr)
            return 2
        refuse_shared_target(plan[1])
        if printing:
            print(json.dumps(to_json(*plan), indent=2))
            return 0
        return execute(plan[1], plan[2], plan[3], staged)
    except GateError as error:
        print(f"gate: {error}; refusing", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("gate: interrupted; nothing was written", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv))
