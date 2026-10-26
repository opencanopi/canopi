"""The one gate table (scripts/gate.py; 2.1-M198, 2.1-M201, 2.1-Q205; canopi-f47t.52.228.10).

Chunk 3's user paths, expected failures until c3 builds gate.py: each changed path selects its area's checks, and
`full` emits AGENTS.md's Quality gates rows. `--print` gives JSON with the selected `checks` (command strings).
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[1]


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class AffectedSelection(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "test@example.invalid")
        git(self.repo, "config", "user.name", "test")
        (self.repo / "scripts").mkdir()
        if (ROOT / "scripts/gate.py").exists():
            shutil.copy(ROOT / "scripts/gate.py", self.repo / "scripts/gate.py")
        (self.repo / "README.md").write_text("x\n", encoding="utf-8")
        git(self.repo, "add", "-A")
        git(self.repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self._tmp.cleanup()

    def checks(self, path, *extra):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("x\n", encoding="utf-8")
        git(self.repo, "add", path)
        result = subprocess.run([sys.executable, "scripts/gate.py", "affected", "--base", self.base, *extra, "--print"],
                                cwd=self.repo, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["checks"]

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_policy_change_runs_the_policy_lane(self):
        self.assertIn("npm run test:policies", " ; ".join(self.checks("policy/rules.json")))

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_docs_change_runs_the_docs_row(self):
        self.assertIn("python3 scripts/check_docs.py", " ; ".join(self.checks("docs/guides/a.md")))

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_rust_change_in_the_commit_lane_runs_only_fmt(self):
        checks = " ; ".join(self.checks("desktop/src/lib.rs", "--staged"))
        self.assertIn("cargo fmt --all -- --check", checks)
        self.assertNotIn("cargo clippy", checks)


class FullRun(unittest.TestCase):
    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_full_emits_the_agents_quality_gate_rows(self):
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        table = agents.split("## Quality gates", 1)[1].split("\n\n", 2)[1]
        rust = next(line for line in table.splitlines() if line.startswith("| Rust |"))
        result = subprocess.run([sys.executable, "scripts/gate.py", "full", "--area", "rust", "--print"], cwd=ROOT,
                                capture_output=True, text=True, timeout=60, env={**os.environ})
        self.assertEqual(result.returncode, 0, result.stderr)
        printed = " ; ".join(json.loads(result.stdout)["checks"])
        for command in re.findall(r"`([^`]+)`", rust):
            self.assertIn(command.split(" (")[0], printed)


if __name__ == "__main__":
    unittest.main()
