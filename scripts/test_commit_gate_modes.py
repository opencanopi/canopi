"""`commit_gate.py pr` and `tree` over planted repositories: merges on --cc, rebases, the before-the-gate rule, the gate's
own files, the demotion rules and the failure states (plan:169, design-check:628-630; canopi-f47t.52.228.10), split from
test_commit_gate.py under the 600-line file-size rule (2.1-Q243).
"""
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
import unittest.mock

from scripts.test_commit_gate import GateRepo, OPEN_BEAD, Q_ROW, ROOT, git


class CommitGateModes(unittest.TestCase):
    """Tree mode, merges on --cc, rebases, the demotion rules and the failure states (plan:169, design-check:628-630)."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = GateRepo(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def run_gate(self, *args):
        result = self.repo.gate(*args)
        return result.returncode, result.stdout + result.stderr

    def test_canopi_f47t_52_228_10_tree_mode_fails_on_a_first_parent_commit_naming_no_pr(self):
        self.repo.write({"notes.txt": "x\n"})
        squash = self.repo.commit("docs: notes (#74)")
        self.assertEqual(self.run_gate("tree", self.repo.base, squash)[0], 0)
        self.repo.write({"notes.txt": "y\n"})
        direct = self.repo.commit("docs: a direct push")
        code, out = self.run_gate("tree", squash, direct)
        self.assertEqual(code, 1, out)
        self.assertIn("gate-squash-subject", out)

    def test_canopi_f47t_52_228_10_tree_mode_passes_a_merge_pull_request_commit_and_skips_its_branch(self):
        git(self.repo.path, "checkout", "-q", "-b", "topic")
        self.repo.raise_suppression("feat: an unauthorised raise on the PR branch")
        git(self.repo.path, "checkout", "-q", "main")
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-ff", "-m",
            "Merge pull request #75 from opencanopi/topic", "topic", env=env)
        head = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        code, out = self.run_gate("tree", self.repo.base, head)
        self.assertEqual(code, 0, out)

    def merge(self, extra_entry=None):
        """main and topic each add an authorised entry; the merge resolves suppressions.json, optionally adding one."""
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        git(self.repo.path, "checkout", "-q", "-b", "topic")
        self.repo.raise_suppression(f"feat: topic's entry ({OPEN_BEAD}, {Q_ROW})")
        topic = json.loads((self.repo.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
        git(self.repo.path, "checkout", "-q", "main")
        family = json.loads((self.repo.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
        family["entries"]["desktop/web/src/other.ts: oxlint:no-console"] = {"count": 1}
        self.repo.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
        self.repo.commit(f"feat: main's entry ({OPEN_BEAD}, {Q_ROW})")
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-commit", "topic", env=env, check=False)
        family["entries"].update(topic["entries"])
        if extra_entry:
            family["entries"][extra_entry] = {"count": 1}
        self.repo.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
        return self.repo.commit("Merge branch 'topic'")

    def test_canopi_f47t_52_228_10_a_merge_of_an_authorised_branch_passes(self):
        code, out = self.run_gate("pr", self.repo.base, self.merge())
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_an_unauthorised_change_in_a_conflict_resolution_is_refused(self):
        code, out = self.run_gate("pr", self.repo.base, self.merge("desktop/web/src/sneaked.ts: oxlint:no-console"))
        self.assertEqual(code, 1, out)
        self.assertIn("gate-loosening-authority", out)
        self.assertIn("sneaked.ts", out)

    def test_canopi_f47t_52_228_10_rebased_commits_are_rechecked(self):
        head = self.repo.raise_suppression("feat: add an exception")
        self.assertEqual(self.run_gate("pr", self.repo.base, head)[0], 1)
        git(self.repo.path, "checkout", "-q", "-b", "newbase", self.repo.base)
        self.repo.write({"notes.txt": "x\n"})
        newbase = self.repo.commit("docs: notes")
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "rebase", "-q", "--onto", newbase, self.repo.base, "main", env=env)
        rebased = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        self.assertNotEqual(rebased, head)
        code, out = self.run_gate("pr", newbase, rebased)
        self.assertEqual(code, 1, out)
        self.assertIn("gate-loosening-authority", out)

    def test_canopi_f47t_52_228_10_a_commit_changing_the_gate_table_its_scripts_or_hooks_is_listed(self):
        heads = []
        for path in ("scripts/gate.py", "scripts/check_docs_gates.py", ".githooks/pre-commit", "notes.txt"):
            target = self.repo.path / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "a", encoding="utf-8") as file:
                file.write("# changed\n")
            heads.append(self.repo.commit(f"chore: change {path}"))
        code, out = self.run_gate("pr", self.repo.base, heads[-1])
        self.assertEqual(code, 0, out)
        listed = [line for line in out.splitlines() if line.startswith("changes the gate's own files: ")]
        self.assertEqual([line.split("chore: change ")[1] for line in listed],
                         ["scripts/gate.py", "scripts/check_docs_gates.py", ".githooks/pre-commit"])

    def gate_gap(self):
        """A test file at a new base, then: the gate deleted, an unauthorised raise with that test deleted, the gate back."""
        self.repo.write({"scripts/test_x.py": "class X:\n    def test_kept_behaviour(self):\n        assert 1\n"})
        base = self.repo.commit("chore: a test")
        git(self.repo.path, "rm", "-q", "scripts/commit_gate.py")
        self.repo.commit("chore: drop the gate")
        (self.repo.path / "scripts/test_x.py").unlink()
        self.repo.raise_suppression("chore: raise an entry")
        shutil.copy(ROOT / "scripts/commit_gate.py", self.repo.path / "scripts/commit_gate.py")
        return base, self.repo.commit("chore: restore the gate")

    def test_canopi_f47t_52_228_a_pr_deleting_the_gate_its_base_holds_still_judges_every_commit(self):
        base, head = self.gate_gap()
        code, out = self.run_gate("pr", base, head)
        self.assertEqual(code, 1, out)
        self.assertIn("gate-loosening-authority", out)
        self.assertIn("gate-test-deleted", out)
        self.assertFalse([line for line in out.splitlines() if line.startswith("before the gate")], out)
        self.assertIn("commit gate: 3 commit(s), 0 before the gate: RED", out)

    def test_canopi_f47t_52_228_commits_before_the_gate_count_only_when_the_merge_base_has_none(self):
        # A merge base without the gate (Phase 0's pre-gate merges, 2.1-M328): commits until it lands are listed, not judged.
        _, gap = self.gate_gap()
        git(self.repo.path, "checkout", "-q", "--detach", f"{gap}~2")
        self.repo.write({"notes.txt": "x\n"})
        self.repo.commit("chore: pre-gate base")
        base = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        self.repo.raise_suppression("chore: raise an entry")
        shutil.copy(ROOT / "scripts/commit_gate.py", self.repo.path / "scripts/commit_gate.py")
        head = self.repo.commit("chore: the gate lands")
        code, out = self.run_gate("pr", base, head)
        self.assertEqual(code, 0, out)
        self.assertEqual(len([line for line in out.splitlines() if line.startswith("before the gate")]), 2, out)

    def test_canopi_f47t_52_228_10_an_inventory_demotion_or_a_dropped_rule_row_needs_a_q_row(self):
        rules = json.loads((self.repo.path / "policy/rules.json").read_text(encoding="utf-8"))
        inventory = {"rules": [{"id": "x-rule", "doc": "AGENTS.md", "quote": "x", "state": {"exists": {"check": "x"}}}]}
        self.repo.write({"policy/inventory.json": json.dumps(inventory) + "\n"})
        base = self.repo.commit("chore: inventory")
        inventory["rules"][0]["state"] = "advice"
        dropped = {**rules, "rules": [r for r in rules["rules"] if r["id"] != "suppressions"]}
        for files, rule in (({"policy/inventory.json": json.dumps(inventory) + "\n"}, "x-rule"),
                            ({"policy/rules.json": json.dumps(dropped, indent=2) + "\n"}, "suppressions")):
            with self.subTest(rule=rule):
                git(self.repo.path, "checkout", "-q", "--detach", base)
                self.repo.write(files)
                code, out = self.run_gate("pr", base, self.repo.commit(f"chore: demote ({OPEN_BEAD})"))
                self.assertEqual(code, 1, out)
                self.assertIn("gate-inventory-demotion", out)
                self.assertIn(rule, out)
                git(self.repo.path, "checkout", "-q", "--detach", base)
                self.repo.write(files)
                code, out = self.run_gate("pr", base, self.repo.commit(f"chore: demote ({OPEN_BEAD}, {Q_ROW})"))
                self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_sigint_exits_non_zero_and_leaves_status_and_index_unchanged(self):
        for n in range(4):
            self.repo.raise_suppression(f"feat: raise {n}")
            family = json.loads((self.repo.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
            family["entries"] = {f"{k}{n}" if "new.ts" in k else k: v for k, v in family["entries"].items()}
            self.repo.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
            self.repo.commit(f"feat: rename {n}")
        head = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        index = self.repo.path / ".git/index"
        before = (git(self.repo.path, "status", "--porcelain").stdout, hashlib.sha256(index.read_bytes()).hexdigest())
        process = subprocess.Popen([sys.executable, "scripts/commit_gate.py", "pr", self.repo.base, head], cwd=self.repo.path,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        process.send_signal(signal.SIGINT)
        _, err = process.communicate(timeout=60)
        self.assertNotEqual(process.returncode, 0, err)
        self.assertIn("interrupted", err)
        after = (git(self.repo.path, "status", "--porcelain").stdout, hashlib.sha256(index.read_bytes()).hexdigest())
        self.assertEqual(before, after)

    def test_canopi_f47t_52_228_10_enospc_fails_naming_the_path(self):
        spec = importlib.util.spec_from_file_location("commit_gate_under_test", ROOT / "scripts/commit_gate.py")
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)

        def full(*_args, **_kwargs):
            raise OSError(errno.ENOSPC, "No space left on device", "/tmp/canopi-gate-full")

        case = Path(self._tmp.name) / "case"
        case.mkdir()
        (case / "case.json").write_text(json.dumps({"base": {}, "head": {"a.txt": "x"}, "message": "docs: x"}), encoding="utf-8")
        err = io.StringIO()
        with unittest.mock.patch.object(gate.tempfile, "mkdtemp", full), unittest.mock.patch("sys.stderr", err):
            code = gate.main(["commit_gate.py", "planted", str(case)])
        self.assertEqual(code, 1)
        self.assertIn("/tmp/canopi-gate-full", err.getvalue())
        self.assertIn("No space left", err.getvalue())
