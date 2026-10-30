"""The one gate table (scripts/gate.py; 2.1-M198, 2.1-M201, 2.1-M230, 2.1-Q205; canopi-f47t.52.228.10).

Each selection case builds a temporary repository holding a copy of the real gate.py, stages a change and reads
`affected ... --print` (the checks as command strings). Run cases put PATH shims for npm, npx, cargo and docker in front
and record their calls. One case drives the real dependency-cruiser over this checkout's graph.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
# The planted repository's lock; the image is built from it, so check_playwright_pins finds no stale literal here.
PLANTED_PLAYWRIGHT = "9.8.7"
PLANTED_IMAGE = "mcr.microsoft.com/playwright:" + f"v{PLANTED_PLAYWRIGHT}-noble"

# The lock shims wait on a real flock the test holds, the way cargo waits on its build or package-cache lock.
SHIM = """#!/bin/sh
FLOCK='import fcntl, sys; fcntl.flock(open(sys.argv[1]), fcntl.LOCK_EX)'
echo "$(basename "$0") $* offline=${npm_config_offline:-unset}" >> "$SHIM_LOG"
case "$(basename "$0") $1 $2" in
  "docker image inspect"|"docker pull "*) [ -n "$SHIM_NO_IMAGE" ] && { echo "dial tcp: lookup mcr.microsoft.com: no such host" >&2; exit 1; } ;;
  "cargo clippy "*) [ -n "$SHIM_CARGO_LOCK" ] && { python3 -c "$FLOCK" "$SHIM_CARGO_LOCK"; sleep 2; } ;;
  "npm run test:policies:push") [ -n "$SHIM_NESTED_LOCK" ] && out=$(python3 -c "$FLOCK" "$SHIM_NESTED_LOCK" 2>&1) ;;
  "npm run "*) [ -n "$SHIM_SLOW_NPM" ] && sleep 30 ;;
  "docker run "*) [ -n "$SHIM_E2E_FAIL" ] && { echo "1 failed" >&2; exit 1; } ;;
esac
exit 0
"""


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def load_gate():
    spec = importlib.util.spec_from_file_location("gate_under_test", ROOT / "scripts/gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GateRepo(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "test@example.invalid")
        git(self.repo, "config", "user.name", "test")
        (self.repo / "scripts").mkdir()
        if (ROOT / "scripts/gate.py").exists():
            shutil.copy(ROOT / "scripts/gate.py", self.repo / "scripts/gate.py")
        self.write({"README.md": "x\n",
                    "AGENTS.md": "Enforced by `cited.test.ts`.\n",
                    "desktop/web/package-lock.json": json.dumps({"packages": {"node_modules/@playwright/test": {"version": PLANTED_PLAYWRIGHT}}}),
                    "desktop/web/src/__tests__/scan.test.ts": "import { readdirSync } from 'node:fs'\n",
                    "desktop/web/src/__tests__/harness.test.ts": "import { rule } from './support/policy-harness'\n",
                    "desktop/web/src/__tests__/i18n-copy.test.ts": "import en from '../i18n/en.json'\n",
                    "desktop/web/src/__tests__/cited.test.ts": "it('x', () => {})\n",
                    "desktop/web/src/__tests__/plain.test.ts": "it('x', () => {})\n",
                    "desktop/web/src/__tests__/ios.test.ts": "new URL('web-edition-browsers.yml')\n", "desktop/web/src/__tests__/wiring.test.ts": "workflow('build.yml')\n",
                    "desktop/web/src/app/x.ts": "export const x = 1\n",
                    "desktop/web/src/app/x.test.ts": "it('x', () => {})\n",
                    "scripts/foo.py": "x = 1\n",
                    "scripts/test_foo.py": "x = 1\n",
                    "scripts/test_foo_table.py": "x = 1\n",
                    "desktop/web/e2e/canvas/a.spec.ts": "x\n"})
        # The cruiser stands in for dependency-cruiser: it names one module reaching whatever changed.
        cruiser = self.repo / "desktop/web/node_modules/.bin/depcruise"
        self.write({"desktop/web/node_modules/.bin/depcruise":
                    "#!/bin/sh\necho \"$*\" >> \"$SHIM_LOG\"\necho '{\"modules\": [{\"source\": \"src/app/user.ts\"}, "
                    "{\"source\": \"src/app/user.test.ts\"}]}'\n"})
        cruiser.chmod(0o755)
        (self.repo / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
        git(self.repo, "add", "-A")
        git(self.repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.base)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("npm", "npx", "cargo", "docker"):
            (self.bin / name).write_text(SHIM, encoding="utf-8")
            (self.bin / name).chmod(0o755)
        self.log = self.root / "calls.log"
        self.log.write_text("", encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, files):
        for name, text in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")

    def stage(self, *paths):
        for path in paths:
            if not (self.repo / path).exists():
                self.write({path: "x\n"})
            else:
                with open(self.repo / path, "a", encoding="utf-8") as file:
                    file.write("\n")
        git(self.repo, "add", *paths)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k not in ("npm_config_offline", "CARGO_TARGET_DIR")}
        env.update(PATH=f"{self.bin}{os.pathsep}{env['PATH']}", SHIM_LOG=str(self.log), **extra)
        return env

    def gate(self, *args, cwd=None, **extra):
        return subprocess.run([sys.executable, "scripts/gate.py", *args], cwd=cwd or self.repo, capture_output=True,
                              text=True, timeout=120, env=self.env(**extra))

    def printed(self, *args, cwd=None):
        result = self.gate(*args, "--print", cwd=cwd)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def checks(self, *paths, staged=False):
        self.stage(*paths)
        return self.printed("affected", *(["--staged"] if staged else ["--base", self.base]))["checks"]

    def calls(self):
        return self.log.read_text(encoding="utf-8").splitlines()


class AffectedSelection(GateRepo):
    def test_canopi_f47t_52_228_10_a_policy_change_runs_the_policy_lane(self):
        self.assertIn("cd desktop/web && npm run test:policies", self.checks("policy/rules.json"))
        self.assertIn("cd desktop/web && npm run test:policies:commit", self.checks("policy/check.mjs", staged=True))

    def test_canopi_f47t_52_228_10_a_docs_change_runs_the_docs_row(self):
        checks = self.checks("docs/a.md")
        self.assertEqual(checks, ["python3 scripts/check_docs.py", f"python3 scripts/check_docs.py --drift {self.base}"])
        self.assertIn("python3 -m unittest scripts.test_check_docs", self.checks("scripts/check_docs_gates.py"))

    def test_canopi_f47t_52_228_13_an_english_locale_change_regenerates_and_checks_the_locale_keys(self):
        self.assertNotIn("cd desktop/web && npm run gen:types", self.checks("desktop/web/src/i18n/fr.json"))
        checks = self.checks("desktop/web/src/i18n/en.json")
        self.assertIn("cd desktop/web && npm run gen:types", checks)
        self.assertIn("cd desktop/web && npm run check:types", checks)

    def test_canopi_f47t_52_228_10_a_rust_change_in_the_commit_lane_runs_only_fmt(self):
        checks = self.checks("desktop/src/lib.rs", staged=True)
        self.assertEqual(checks, ["cargo fmt --all -- --check", "cd desktop/web && npm run test:policies:commit"])

    def test_canopi_f47t_52_228_10_the_commit_lane_names_a_change_no_commit_check_covers(self):
        # An area with no commit checks (species catalog, shared contracts, LiDAR) covers nothing here; docs paths run DOCS.
        self.stage("scripts/foo.py", ".github/workflows/x.yml", "desktop/web/src/app/x.ts",
                   "scripts/species_catalog_contract.py", "common-types/plant-filter-fields.json", "docs/guides/a.md")
        printed = self.printed("affected", "--staged")
        self.assertIn("cd desktop/web && npm run typecheck", printed["checks"])
        covers = ("no commit check covers .github/workflows/x.yml, common-types/plant-filter-fields.json, scripts/foo.py, "
                  "scripts/species_catalog_contract.py")
        self.assertIn(f"{covers}; the affected gate runs their checks", printed["notes"])
        result = self.gate("affected", "--staged")
        self.assertIn(covers, result.stderr)

    def test_canopi_f47t_52_228_14_a_desktop_change_names_the_real_app_lane_and_a_docs_change_does_not(self):
        """F5's Desktop real-app suite (2.1-M213) is a CI lane no local run makes: named for what triggers it, never run."""
        lane = "CI lane desktop-real-app.yml"
        self.stage("desktop/src/host/mod.rs")
        self.assertIn(lane, self.printed("affected", "--base", self.base)["ci_only"])
        self.assertNotIn(lane, self.printed("affected", "--base", self.base)["checks"])
        git(self.repo, "reset", "-q", "--hard", self.base)
        self.stage("docs/guides/a.md")
        self.assertNotIn(lane, self.printed("affected", "--base", self.base)["ci_only"])

    def test_canopi_f47t_52_228_10_areas_are_anchored_regexes(self):
        for area in self.printed("full")["areas"]:
            for pattern in area["patterns"]:
                re.compile(pattern)
                self.assertTrue(pattern.startswith(("^", "(^|/)")) or pattern.endswith("$"), (area["name"], pattern))
                self.assertNotIn("**", pattern)

    def test_canopi_f47t_52_228_10_rust_triggers_on_sources_manifests_and_the_rust_workflows_only(self):
        self.assertNotIn("cargo fmt --all -- --check", " ; ".join(self.checks(".github/workflows/commit-gate.yml")))
        for path in ("common-types/src/x.rs", "Cargo.lock", "desktop/Cargo.toml", ".github/workflows/build.yml",
                     ".github/workflows/release-candidate.yml"):  # each change adds to the last: a trigger is a first
            git(self.repo, "reset", "-q", "--hard", self.base)
            git(self.repo, "clean", "-qfd", "-e", "node_modules")
            self.assertIn("cargo fmt --all -- --check", self.checks(path), path)

    def test_canopi_f47t_52_228_10_the_base_lane_runs_the_rust_row_without_coverage(self):
        self.assertIn("CANOPI_SKIP_BUNDLED_DB=1 cargo test -p canopi-desktop native_command_policy::tests",
                      self.checks("desktop/web/src/ipc/x.ts"))
        checks = self.checks("desktop/src/lib.rs")
        self.assertIn("CANOPI_SKIP_BUNDLED_DB=1 cargo clippy --workspace --all-targets -- -D warnings", checks)
        self.assertIn("CANOPI_SKIP_BUNDLED_DB=1 cargo test --workspace", checks)
        self.assertIn("cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push", checks)
        self.assertNotIn("cargo cov", checks)
        self.assertFalse([c for c in checks if "native_command_policy" in c], "cargo test --workspace runs it")

    def test_canopi_f47t_52_228_10_a_toolchain_change_runs_the_whole_suite_or_in_the_commit_lane_typecheck_and_policies(self):
        whole = "cd desktop/web && npx vitest run --maxWorkers=4"
        self.assertIn(whole, self.checks("desktop/web/package.json"))
        self.stage("desktop/web/tsconfig.json")
        staged = self.printed("affected", "--staged")
        self.assertEqual(staged["checks"], ["cd desktop/web && npm run typecheck", "cd desktop/web && npm run test:policies:commit"])
        self.assertIn("the whole Vitest suite runs at the affected gate", " ".join(staged["notes"]))

    def test_canopi_f47t_52_228_10_a_web_change_runs_typecheck_check_ui_related_families_and_policies(self):
        checks = self.checks("desktop/web/src/app/x.ts")
        self.assertEqual(checks[:2], ["cd desktop/web && npm run typecheck", "cd desktop/web && npm run check:ui"])
        related = next(c for c in checks if "vitest related" in c)
        self.assertIn("src/app/x.ts", related)
        self.assertIn("src/app/user.ts", related, "the modules reaching the change, from the cruiser")
        families = next(c for c in checks if "npx vitest run" in c).split()
        for test in ("scan", "harness", "i18n-copy", "cited", "user"):
            self.assertIn(f"src/__tests__/{test}.test.ts" if test != "user" else "src/app/user.test.ts", families)
        self.assertIn("src/app/x.test.ts", families, "the test beside the changed module")
        self.assertNotIn("src/__tests__/plain.test.ts", families)
        self.assertEqual(checks[-1], "cd desktop/web && npm run test:policies")
        self.assertIn("--reaches ^(?:src/app/x\\.ts)$", " ".join(self.calls()))

    def test_canopi_f47t_52_228_10_a_changed_script_runs_the_test_files_split_from_its_test(self):
        # test_gate_table.py and test_commit_gate_policy.py hold cases split from test_gate.py and test_commit_gate.py.
        self.assertIn("python3 -m unittest scripts.test_foo_table", self.checks("scripts/foo.py"))

    def test_canopi_f47t_52_228_10_every_code_change_runs_the_families_and_a_changed_script_its_test(self):
        checks = self.checks("scripts/foo.py")
        self.assertIn("python3 -m unittest scripts.test_foo", checks)
        self.assertIn("cd desktop/web && npm run test:policies", checks)
        families = next(c for c in checks if "npx vitest run" in c)
        self.assertIn("src/__tests__/i18n-copy.test.ts", families)
        self.assertNotIn("vitest related", " ".join(checks))

    def test_canopi_f47t_52_228_10_the_gallery_runs_the_root_typecheck_and_the_gallery_e2e(self):
        self.stage("desktop/web/ui-gallery/main.tsx")
        printed = self.printed("affected", "--base", self.base)
        self.assertIn("cd desktop/web && npm run typecheck", printed["checks"])
        self.assertIn("cd desktop/web && npm run check:ui", printed["checks"])
        self.assertEqual(printed["checks"][-1], "cd desktop/web && npm run build:web")
        self.assertEqual(printed["e2e"]["specs"], ["e2e/gallery"])
        self.assertEqual(printed["e2e"]["projects"], ["chromium", "webkit", "gallery-chromium", "gallery-webkit"])

    def test_canopi_f47t_52_228_10_a_global_style_change_runs_the_canvas_e2e_in_the_pinned_image(self):
        self.stage("desktop/web/src/styles/global.css")
        e2e = self.printed("affected", "--base", self.base)["e2e"]
        self.assertEqual((e2e["specs"], e2e["projects"]), (["e2e/canvas"], ["chromium", "webkit"]))
        self.assertEqual(e2e["image"], PLANTED_IMAGE)
        self.assertTrue(e2e["command"].startswith("docker run "), e2e["command"])
        self.assertIn(f"{PLANTED_IMAGE} npx playwright test e2e/canvas", e2e["command"])
        self.assertNotIn(" -p ", e2e["command"], "the container keeps its own network; no port is published")
        self.assertNotIn("CANOPI_E2E_", e2e["command"], "the container's network isolates it; the default ports serve")

    def test_canopi_f47t_52_228_10_the_gate_hands_no_port_pair_to_quiet_gates_or_ci(self):
        self.assertNotIn("ports", self.printed("full", "--area", "docs"))

    def test_canopi_f47t_52_228_10_a_changed_spec_runs_itself_and_beads_run_nothing(self):
        self.stage("desktop/web/e2e/canvas/a.spec.ts")
        self.assertEqual(self.printed("affected", "--base", self.base)["e2e"]["specs"], ["e2e/canvas/a.spec.ts"])
        git(self.repo, "reset", "-q")
        self.assertEqual(self.checks(".beads/issues.jsonl", staged=True), [])

    def test_canopi_f47t_52_228_10_areas_selects_without_running_a_tool(self):
        self.stage("desktop/web/src/app/x.ts", "Cargo.lock")
        result = self.gate("areas", "--base", self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        printed = json.loads(result.stdout)
        self.assertEqual(printed["selected"], ["rust", "frontend", "real-app"])
        self.assertEqual([a["name"] for a in printed["areas"]][:2], ["rust", "tauri-command"])
        self.assertEqual(self.calls(), [], "no cruiser: CI's changes job has no node_modules")

    def test_canopi_f47t_52_228_10_a_file_the_toolchain_scanner_reads_runs_its_tests_never_the_frontend_row(self):
        # Seam 10: a change to a hook, workflow, script or guide alone runs toolchain-typecheck.test.ts and each test
        # naming it (ios, wiring); CI runs these (`areas`' tests), not the Frontend row; typecheck and check:ui stay.
        scan = "desktop/web/src/__tests__/toolchain-typecheck.test.ts"
        self.write({scan: "import { readdirSync } from 'node:fs'\n"})
        git(self.repo, "add", scan)
        git(self.repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "scanner")
        base, alone = git(self.repo, "rev-parse", "HEAD"), [scan.removeprefix("desktop/web/")]
        families = [f"src/__tests__/{n}.test.ts" for n in ("cited", "harness", "i18n-copy", "scan", "toolchain-typecheck")]
        ios, wiring = (sorted([*families, f"src/__tests__/{name}.test.ts"]) for name in ("ios", "wiring"))
        for path, tests in ((".githooks/pre-commit", families), (".github/workflows/desktop-real-app.yml", families),
                            (".github/workflows/web-edition-browsers.yml", ios), (".github/workflows/build.yml", wiring),
                            ("scripts/foo.sh", families), ("docs/guides/x.md", alone), ("README.md", alone), ("AGENTS.md", alone)):
            git(self.repo, "reset", "-q", "--hard", base)
            git(self.repo, "clean", "-qfd", "-e", "node_modules")
            self.stage(path)
            areas = json.loads(self.gate("areas", "--base", base).stdout)
            self.assertNotIn("frontend", areas["selected"], path)
            self.assertEqual(areas["tests"], tests, path)
            checks = self.printed("affected", "--base", base)["checks"]
            self.assertIn("cd desktop/web && npx vitest run --maxWorkers=4 " + " ".join(tests), checks, path)
            self.assertNotIn("cd desktop/web && npm run check:ui", checks, path)
            self.assertNotIn("cd desktop/web && npm run typecheck", self.printed("affected", "--staged")["checks"], path)
        for path in (".beads/issues.jsonl", "docs/plans/x.md"):  # beads and unscanned docs name no tests
            git(self.repo, "reset", "-q", "--hard", base)
            self.stage(path)
            self.assertEqual(json.loads(self.gate("areas", "--base", base).stdout)["tests"], [], path)

    def test_canopi_f47t_52_228_10_a_changed_workflow_runs_the_pinned_actionlint_and_the_commit_lane_does_not(self):
        # GitHub refused a workflow only a scratch run saw (canopi-f47t.52.228.15.1): a workflow or actionlint config
        # change runs actionlint at the affected gate; the commit lane stays offline, so it names the path instead.
        for path in (".github/workflows/x.yml", ".github/actionlint.yaml"):
            git(self.repo, "reset", "-q", "--hard", self.base)
            self.assertIn("python3 scripts/gate.py actionlint", self.checks(path), path)
            self.assertNotIn("python3 scripts/gate.py actionlint", self.printed("affected", "--staged")["checks"], path)
        git(self.repo, "reset", "-q", "--hard", self.base)
        self.assertNotIn("python3 scripts/gate.py actionlint", self.checks("desktop/web/src/app/x.ts"))


class CommitModes(GateRepo):
    """Real `git commit` runs: git hands the hook the index it judges through GIT_INDEX_FILE."""

    def committed_checks(self, *commit_args):
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text(f"#!/bin/sh\n{shlex.quote(sys.executable)} scripts/gate.py affected --staged --print > ../printed.json\n",
                        encoding="utf-8")
        hook.chmod(0o755)
        subprocess.run(["git", "commit", "-q", "-m", "x", *commit_args], cwd=self.repo, check=True, capture_output=True,
                       env=self.env())
        return json.loads((self.root / "printed.json").read_text(encoding="utf-8"))["checks"]

    def test_canopi_f47t_52_228_10_commit_all_judges_the_index_git_commits(self):
        with open(self.repo / "desktop/web/src/app/x.ts", "a", encoding="utf-8") as file:
            file.write("\n")
        self.assertIn("cd desktop/web && npm run typecheck", self.committed_checks("-a"))

    def test_canopi_f47t_52_228_10_a_pathspec_commit_judges_the_index_git_commits(self):
        with open(self.repo / "desktop/web/src/app/x.ts", "a", encoding="utf-8") as file:
            file.write("\n")
        self.assertIn("cd desktop/web && npm run typecheck", self.committed_checks("desktop/web/src/app/x.ts"))


class Running(GateRepo):
    def test_canopi_f47t_52_228_10_the_commit_lane_runs_npm_offline(self):
        self.stage("desktop/web/src/app/x.ts")
        result = self.gate("affected", "--staged")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1, self.calls())
        self.assertEqual(self.calls()[0], "npm run typecheck offline=true", self.calls())

    def test_canopi_f47t_52_228_10_ctrl_c_writes_nothing(self):
        self.stage("desktop/web/src/app/x.ts")
        before = git(self.repo, "status", "--porcelain", "--ignored")
        process = subprocess.Popen([sys.executable, "scripts/gate.py", "affected", "--staged"], cwd=self.repo,
                                   env=self.env(SHIM_SLOW_NPM="1"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 20
        while not self.calls() and time.monotonic() < deadline:
            time.sleep(0.1)
        process.send_signal(signal.SIGINT)
        _, stderr = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 130, stderr)
        self.assertIn("nothing was written", stderr)
        self.assertEqual(git(self.repo, "status", "--porcelain", "--ignored"), before)

    def held_lock(self):
        path = self.root / "build.lock"
        path.write_text("", encoding="utf-8")
        holder = open(path)
        self.addCleanup(holder.close)
        fcntl.flock(holder, fcntl.LOCK_EX)
        return path, holder

    def test_canopi_f47t_52_228_10_a_busy_cargo_lock_waits_bounded_then_fails_naming_it(self):
        self.assertEqual(load_gate().LOCK_WAIT, 60)
        path, _ = self.held_lock()
        started = time.monotonic()
        result = self.gate("full", "--area", "rust", SHIM_CARGO_LOCK=str(path), CANOPI_GATE_LOCK_WAIT="1",
                           CARGO_TARGET_DIR=str(self.root / "target"))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"the file lock on {path} stayed busy for 1 s", result.stderr)
        self.assertLess(time.monotonic() - started, 20, "the shim waits on the lock forever; the gate stopped it")

    def test_canopi_f47t_52_228_10_a_cargo_lock_a_nested_call_waits_on_silently_is_bounded_too(self):
        # policy/adapters/clippy.mjs runs `cargo clippy --quiet` and captures its output: no Blocking line reaches the gate.
        path, _ = self.held_lock()
        started = time.monotonic()
        result = self.gate("full", "--area", "rust", SHIM_NESTED_LOCK=str(path), CANOPI_GATE_LOCK_WAIT="1",
                           CARGO_TARGET_DIR=str(self.root / "target"))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"FAIL cd desktop/web && CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push: the file lock on {path} "
                      "stayed busy for 1 s", result.stderr)
        self.assertLess(time.monotonic() - started, 20)

    def test_canopi_f47t_52_228_10_a_cargo_lock_released_in_time_lets_the_check_run_on(self):
        path, holder = self.held_lock()
        release = threading.Timer(0.5, lambda: fcntl.flock(holder, fcntl.LOCK_UN))
        release.start()
        self.addCleanup(release.cancel)
        result = self.gate("full", "--area", "rust", SHIM_CARGO_LOCK=str(path), CANOPI_GATE_LOCK_WAIT="1",
                           CARGO_TARGET_DIR=str(self.root / "target"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("stayed busy", result.stderr)

    def test_canopi_f47t_52_228_10_full_rust_in_a_linked_worktree_needs_its_own_cargo_target(self):
        git(self.repo, "worktree", "add", "-q", "-b", "linked", str(self.root / "linked"))
        result = self.gate("full", "--area", "rust", "--print", cwd=self.root / "linked")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("2.1-M201", result.stderr)
        self.assertEqual(self.calls(), [])
        result = self.gate("full", "--area", "rust", "--print", cwd=self.root / "linked", CARGO_TARGET_DIR=str(self.root / "t"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gate("full", "--area", "docs", "--print", cwd=self.root / "linked").returncode, 0)

    def test_canopi_f47t_52_228_10_a_shared_cargo_target_is_refused_with_the_per_stream_hint(self):
        # Seam 7 of the Phase 0 hand-off: two worktrees on one shared target wait on cargo's build lock until LOCK_WAIT
        # fails correct code, so the old shared-build value is refused wherever it is set, and the hint names the fix.
        git(self.repo, "worktree", "add", "-q", "-b", "linked", str(self.root / "linked"))
        shared = str(self.root / ".rq-scratch/shared-build/target")
        for cwd in (self.root / "linked", self.repo):
            result = self.gate("full", "--area", "rust", "--print", cwd=cwd, CARGO_TARGET_DIR=shared)
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn("shared-build", result.stderr)
            self.assertIn(".rq-scratch/targets/<stream>/target", result.stderr)
        self.assertEqual(self.calls(), [])
        own = str(self.root / ".rq-scratch/targets/linked/target")
        self.assertEqual(self.gate("full", "--area", "rust", "--print", cwd=self.root / "linked", CARGO_TARGET_DIR=own).returncode, 0)
        self.assertEqual(self.gate("full", "--area", "docs", "--print", cwd=self.root / "linked", CARGO_TARGET_DIR=shared).returncode,
                         0, "a gate that builds nothing through cargo ignores the target")

    def test_canopi_f47t_52_228_10_e2e_with_the_image_missing_and_no_network_fails_naming_it(self):
        self.stage("desktop/web/src/styles/global.css")
        result = self.gate("affected", "--base", self.base, SHIM_NO_IMAGE="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"{PLANTED_IMAGE} is missing and could not be pulled", result.stderr)
        self.assertIn(f"docker pull {PLANTED_IMAGE}", " ".join(self.calls()))
        self.assertFalse([c for c in self.calls() if "playwright test" in c], "never host browsers")
        self.assertFalse([c for c in self.calls() if c.startswith("docker run")])

    def test_canopi_f47t_52_228_10_a_failing_e2e_run_names_its_image(self):
        self.stage("desktop/web/src/styles/global.css")
        result = self.gate("affected", "--base", self.base, SHIM_E2E_FAIL="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"gate: FAIL e2e in {PLANTED_IMAGE}", result.stderr)


if __name__ == "__main__":
    unittest.main()
