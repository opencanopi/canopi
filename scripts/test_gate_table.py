"""The gate table's checks and rows (scripts/gate.py; 2.1-M198, 2.1-M201, 2.1-Q205; canopi-f47t.52.228.10), split from
test_gate.py, which holds the planted-repository selection and run cases: the pinned actionlint, the hooks' git
environment, and each area's full run against its AGENTS.md row and its CI job.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def load_gate():
    spec = importlib.util.spec_from_file_location("gate_under_test", ROOT / "scripts/gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Actionlint(unittest.TestCase):
    """`gate.py actionlint`: the pinned release, on PATH or named by CANOPI_ACTIONLINT, run over the workflows with the
    repository's config; a missing binary or another version fails closed (canopi-f47t.52.228.15.1)."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.gate = load_gate()

    def tearDown(self):
        self._tmp.cleanup()

    def fake(self, version):
        binary, log = self.root / "actionlint", self.root / "argv"
        binary.write_text(f"#!/bin/sh\n[ \"$1\" = -version ] && {{ echo {version}; exit 0; }}\necho \"$*\" > {shlex.quote(str(log))}\n",
                          encoding="utf-8")
        binary.chmod(0o755)
        return binary, log

    def run_gate(self, binary):
        env = {**os.environ, "CANOPI_ACTIONLINT": str(binary)}
        return subprocess.run([sys.executable, "scripts/gate.py", "actionlint"], cwd=ROOT, capture_output=True, text=True,
                              timeout=60, env=env)

    def test_canopi_f47t_52_228_10_ci_installs_the_actionlint_the_gate_pins_by_version_and_checksum(self):
        self.assertRegex(self.gate.ACTIONLINT_VERSION, r"^\d+\.\d+\.\d+$")
        self.assertRegex(self.gate.ACTIONLINT_SHA256, r"^[0-9a-f]{64}$")
        workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
        job = workflow.split("\n  actionlint:\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn(f'ACTIONLINT_VERSION: "{self.gate.ACTIONLINT_VERSION}"', job)
        self.assertIn(f"ACTIONLINT_SHA256: {self.gate.ACTIONLINT_SHA256}", job)
        self.assertIn("sha256sum --check --strict", job)
        self.assertIn("python3 scripts/gate.py actionlint", job)
        config = (ROOT / ".github/actionlint.yaml").read_text(encoding="utf-8")
        self.assertIn("- macos-15-intel", config, "the runner-label config lists the Intel macOS runner build.yml uses")

    def test_canopi_f47t_52_228_10_a_missing_or_other_actionlint_fails_closed_naming_the_pinned_release(self):
        binary, log = self.fake("1.6.0")
        for candidate in (binary, self.root / "absent"):
            result = self.run_gate(candidate)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(f"actionlint {self.gate.ACTIONLINT_VERSION} is needed", result.stderr)
            self.assertIn(self.gate.ACTIONLINT_SHA256, result.stderr)
        self.assertFalse(log.exists(), "another version never runs")

    def test_canopi_f47t_52_228_10_the_pinned_actionlint_runs_over_the_workflows_with_the_config(self):
        binary, log = self.fake(self.gate.ACTIONLINT_VERSION)
        result = self.run_gate(binary)
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = log.read_text(encoding="utf-8").split()
        self.assertEqual(argv[:2], ["-config-file", ".github/actionlint.yaml"])
        self.assertIn("-shellcheck=", argv, "the pinned tool alone decides: no runner-installed shellcheck")


class HookEnvironment(unittest.TestCase):
    def test_canopi_f47t_52_228_10_a_check_never_sees_the_hooks_git_dir(self):
        # A linked worktree's hook exports GIT_DIR and GIT_INDEX_FILE naming the real repository; generate.mjs's planted
        # cases `git init` temp roots, which under GIT_DIR re-initialise that repository instead (core.bare = true).
        gate = load_gate()
        with TemporaryDirectory() as scratch:
            decoy = Path(scratch) / "decoy"
            git(scratch, "init", "-q", str(decoy))
            config = (decoy / ".git/config").read_text(encoding="utf-8")
            hook = {"GIT_DIR": str(decoy / ".git"), "GIT_INDEX_FILE": str(decoy / ".git/index"),
                    "PATH": f"{Path(shutil.which('node') or 'node').parent}{os.pathsep}{os.environ['PATH']}"}
            with mock.patch.dict(os.environ, hook):
                status = gate.execute([gate.Check("node policy/generate.mjs --self-test")], None, [], True)
            self.assertEqual(status, 0, "generate.mjs --self-test failed under the hook's GIT_DIR")
            self.assertEqual((decoy / ".git/config").read_text(encoding="utf-8"), config, "a check wrote into the hook's GIT_DIR")
            self.assertEqual(git(decoy, "status", "--porcelain"), "")


class FullRun(unittest.TestCase):
    def test_canopi_f47t_52_228_11_full_emits_the_agents_rows_running_the_workspace_tests_once_through_cargo_cov(self):
        # cargo-llvm-cov runs every workspace test under instrumentation: `cargo test --workspace` beside it ran them twice.
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        table = agents.split("## Quality gates", 1)[1].split("\n\n", 2)[1]
        rust = next(line for line in table.splitlines() if line.startswith("| Rust |"))
        result = subprocess.run([sys.executable, "scripts/gate.py", "full", "--area", "rust", "--print"], cwd=ROOT,
                                capture_output=True, text=True, timeout=60,
                                env={**os.environ, "CARGO_TARGET_DIR": os.environ.get("CARGO_TARGET_DIR", "target")})
        self.assertEqual(result.returncode, 0, result.stderr)
        checks = json.loads(result.stdout)["checks"]
        self.assertIn("cargo cov", checks)
        self.assertNotIn("CANOPI_SKIP_BUNDLED_DB=1 cargo test --workspace", checks)
        # A command runs itself or inside the check whose row names it.
        named = " ; ".join(checks + [c.row_text for c in load_gate().BY_NAME["rust"].full if c.display in checks and c.row])
        for command in re.findall(r"`([^`]+)`", rust):
            self.assertIn(command.split(" (")[0], named)

    def test_canopi_f47t_52_228_10_each_row_names_exactly_its_checks(self):
        def spans(text):
            found = set()
            for span in re.findall(r"`([^`]+)`", text if "`" in text else f"`{text}`"):
                head, _, rest = span.partition(" && ")
                found.update(f"{head} && {part}" for part in rest.split(" && ")) if head.startswith("cd ") else found.add(span)
            return found

        for area in load_gate().AREAS:
            named = set().union(*(spans(check.row_text) for check in area.full if check.row is not None))
            self.assertEqual(spans(area.run), named, area.name)

    def test_canopi_f47t_52_228_11_each_ci_area_job_runs_the_gate_tables_full_area_command(self):
        # OPEN item 16 of the Phase 0 hand-off (2.1-M198): CI's per-area jobs call the one gate table, so a local
        # `gate.py full --area <a>` is the command CI runs. An area all of whose checks another area's run already makes
        # (covered_by) needs no job; a CI-only area names its lane, which must exist.
        workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
        jobs = {m[1]: m[2] for m in re.finditer(r"(?ms)^  ([a-z][a-z0-9-]*):\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)",
                                                  workflow.split("\njobs:\n", 1)[1])}
        runs = {job: re.findall(r"python3 scripts/gate\.py full --area ([a-z-]+)", body) for job, body in jobs.items()}
        gate = load_gate()
        ran = {area for areas in runs.values() for area in areas}
        # A check runs what it names in `runs` too: `cargo cov` runs `cargo test --workspace`.
        ran_checks = {name for a in gate.AREAS if a.name in ran for c in a.full for name in (c.display, *c.runs)}
        for area in gate.AREAS:
            if all(c.ci_only for c in area.full):
                lanes = [c.row for c in area.full if c.row and c.row != "="]
                self.assertTrue(any(lane in jobs or (ROOT / ".github/workflows" / lane).is_file() for lane in lanes),
                                f"{area.name}: no CI lane named {lanes}")
                continue
            if area.covered_by and set(area.covered_by) <= ran_checks - {c.display for c in area.full}:
                self.assertNotIn(area.name, ran, f"{area.name}: covered by another area job, so no job of its own")
                continue
            holders = [job for job, areas in runs.items() if area.name in areas]
            self.assertEqual(len(holders), 1, f"{area.name}: one CI job runs `gate.py full --area {area.name}`, found {holders}")
            self.assertEqual(runs[holders[0]], [area.name], f"{holders[0]}: one area per job")
            self.assertEqual(holders[0], area.name, "the job is named after its area")

    @staticmethod
    def setup_faults(jobs, rows):
        """What an area job lacks before its `gate.py full --area` step for the row's checks to run on a bare runner:
        the policy core (`node policy/check.mjs`, run by the docs checker for the rule registry and by every
        test:policies script) loads its glob engine from desktop/web's packages; a policy run holds the clippy
        families, which build the workspace's GTK/WebKit crates (canopi-f47t.52.228.11)."""
        clippy = any(json.loads(path.read_text(encoding="utf-8")).get("tool") == "clippy"
                     for path in (ROOT / "policy/ratchets").glob("*.json"))
        faults = []
        for job, body in jobs.items():
            for area in re.findall(r"python3 scripts/gate\.py full --area ([a-z-]+)", body):
                before = body.split(f"python3 scripts/gate.py full --area {area}", 1)[0]
                checks = rows.get(area, [])
                if any("check_docs.py" in c or "test:policies" in c for c in checks) and "npm ci --prefix desktop/web" not in before:
                    faults.append(f"{job}: runs no npm ci in desktop/web before the {area} row")
                if clippy and any("test:policies" in c for c in checks) and "uses: ./.github/actions/install-linux-deps" not in before:
                    faults.append(f"{job}: installs no Linux dependencies before the {area} row's clippy families")
        return faults

    def test_canopi_f47t_52_228_11_each_ci_area_job_installs_what_its_row_needs_before_the_row(self):
        workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
        jobs = {m[1]: m[2] for m in re.finditer(r"(?ms)^  ([a-z][a-z0-9-]*):\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)",
                                                  workflow.split("\njobs:\n", 1)[1])}
        gate = load_gate()
        rows = {a.name: [c.display for c in a.full] for a in gate.AREAS}
        self.assertEqual(self.setup_faults(jobs, rows), [])

        row = "      - run: python3 scripts/gate.py full --area {}\n"
        deps = "      - uses: ./.github/actions/install-linux-deps\n"
        npm = "      - run: npm ci --prefix desktop/web --no-audit --no-fund\n"
        planted = {"docs": row.format("docs") + npm, "frontend": npm + row.format("frontend") + deps,
                   "rust": deps + npm + row.format("rust")}
        planted_rows = {"docs": ["python3 scripts/check_docs.py"], "frontend": ["cd desktop/web && npm run test:policies"],
                        "rust": ["CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push"]}
        self.assertEqual(self.setup_faults(planted, planted_rows), [
            "docs: runs no npm ci in desktop/web before the docs row",
            "frontend: installs no Linux dependencies before the frontend row's clippy families",
        ])

    def test_canopi_f47t_52_228_10_gates_name_package_scripts_and_the_one_typecheck(self):
        gate = load_gate()
        commands = [c.command for a in gate.AREAS for c in (*a.full, *a.affected, *a.commit)]
        self.assertFalse([c for c in commands if "check.mjs" in c], "2.1-M223: package scripts, never check.mjs flags")
        self.assertFalse([c for c in commands if re.search(r"\btsc\b", c)], "2.1-Q205: npm run typecheck is the one typecheck")
        rust = gate.BY_NAME["rust"]
        self.assertIn("CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:push", [c.command for c in rust.full])
        self.assertTrue(all(c.cargo for c in rust.full if c.command.startswith(("CANOPI_SKIP_BUNDLED_DB=1 cargo", "cargo cov"))))

    def test_canopi_f47t_52_228_11_the_policy_run_builds_its_clippy_families_without_the_catalog_db(self):
        # The affected, Frontend and commit runs of test:policies build canopi-desktop for the clippy families; without the
        # bundled catalog DB (CI, a fresh worktree) desktop/build.rs refuses the missing resource unless
        # CANOPI_SKIP_BUNDLED_DB=1, so the gate sets it itself: one command locally and in CI, sharing the Rust row's build
        # fingerprint. The commit lane runs the same families (check.mjs without --self-test), so it gets the same setup.
        gate = load_gate()
        for check in (gate.POLICIES, *[c for c in gate.BY_NAME["frontend"].full if "test:policies" in c.command
                                       and ":bundle" not in c.command]):
            self.assertEqual(check.command, "CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies")
            self.assertTrue(check.cargo, "a clippy family builds through cargo: the build lock and a per-worktree target")
        commit = {c for a in gate.AREAS for c in a.commit if "test:policies" in c.command}
        self.assertEqual({c.command for c in commit}, {"CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:commit"})
        self.assertTrue(all(c.cargo for c in commit), "the commit lane's clippy families take the build lock too")

    def test_canopi_f47t_52_228_10_the_commit_lane_policy_script_skips_only_the_check_self_test(self):
        scripts = json.loads((ROOT / "desktop/web/package.json").read_text(encoding="utf-8"))["scripts"]
        commit = scripts["test:policies:commit"]
        self.assertNotIn("check.mjs --self-test", commit, "2.1-M201: the commit lane never runs check.mjs --self-test")
        self.assertIn("node ../../policy/check.mjs", commit)
        self.assertIn("node ../../policy/generate.mjs --check", commit)
        self.assertIn("check.mjs --self-test", scripts["test:policies"], "the affected and full lanes keep the self-test")
        self.assertEqual(commit, scripts["test:policies"].replace("node ../../policy/check.mjs --self-test && ", ""),
                         "the commit lane drops only the check.mjs self-test; generate.mjs --self-test and sg rule tests stay")
        gate = load_gate()
        self.assertIn("CANOPI_SKIP_BUNDLED_DB=1 npm run test:policies:commit", [c.command for c in gate.BY_NAME["rust"].commit])
        self.assertNotIn("npm run test:policies", [c.command for a in gate.AREAS for c in a.commit])

    def test_canopi_f47t_52_228_10_the_affected_set_comes_from_the_real_dependency_graph(self):
        if not (ROOT / "desktop/web/node_modules/.bin/depcruise").is_file():
            self.skipTest("desktop/web/node_modules is not installed")
        reached = load_gate().reaching(["src/app/design-edit/budget.ts"])
        self.assertIn("src/app/design-edit/index.ts", reached)
        self.assertIn("src/__tests__/budget-actions.test.ts", reached)
        self.assertNotIn("src/app/design-edit/budget.ts", reached)


if __name__ == "__main__":
    unittest.main()
