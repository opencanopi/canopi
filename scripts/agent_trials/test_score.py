"""Behaviour of the trial scorer: diff, areas from the layer table, owners through the scenario owner matcher."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from . import score

REPO = Path(__file__).resolve().parents[2]


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def write(root, rel, text):
    path = Path(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class TrialRepo:
    """A throwaway git repository standing in for a trial worktree: one start commit, then the agent's edits."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "wt-trial"
        self.root.mkdir()
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "trial@example.invalid")
        git(self.root, "config", "user.name", "trial")
        write(self.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 1\n")
        write(self.root, "desktop/web/src/i18n/en.json", "{}\n")
        write(self.root, "common-types/Cargo.toml", '[package]\nname = "common-types"\n')
        write(self.root, "common-types/src/settings.rs", "pub struct S;\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "start")
        self.start = git(self.root, "rev-parse", "HEAD")

    def close(self):
        self.tmp.cleanup()


def task(owners):
    return {"id": "t8", "title": "x", "task": "x", "path": "user path: x", "owners": owners, "start": {}}


class ScoreRunTest(unittest.TestCase):
    def setUp(self):
        self.repo = TrialRepo()
        self.addCleanup(self.repo.close)

    def score(self, owners):
        return score.score_run(task(owners), self.repo.root, self.repo.start, gates=False)

    def test_counts_committed_and_untracked_changes_against_the_start(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\nexport const b = 3\n")
        git(self.repo.root, "commit", "-qam", "fix")
        write(self.repo.root, "desktop/web/src/__tests__/title-bar.test.tsx", "it('x', () => {})\n")
        report = self.score(["components/shared/DesignNameField.tsx"])
        self.assertEqual(report["files_changed"], 2)
        self.assertEqual((report["lines_added"], report["lines_removed"]), (3, 1))
        self.assertEqual(report["test_files_changed"], 1)

    def test_areas_come_from_the_layer_table_and_crates_and_leave_tests_out(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\n")
        write(self.repo.root, "desktop/web/src/__tests__/title-bar.test.tsx", "it('x', () => {})\n")
        write(self.repo.root, "desktop/web/src/i18n/en.json", '{"a": "b"}\n')
        write(self.repo.root, "common-types/src/settings.rs", "pub struct T;\n")
        report = self.score(["components/shared/DesignNameField.tsx"])
        self.assertEqual(sorted(report["areas"]), ["common-types", "components", "i18n"])
        self.assertEqual(report["area_count"], 3)

    def test_a_desktop_web_file_outside_src_is_a_desktop_web_area_never_the_desktop_crate(self):
        write(self.repo.root, "desktop/Cargo.toml", '[package]\nname = "canopi-desktop"\n')
        git(self.repo.root, "add", "-A")
        git(self.repo.root, "commit", "-q", "-m", "desktop crate")
        start = git(self.repo.root, "rev-parse", "HEAD")
        write(self.repo.root, "desktop/web/package.json", "{}\n")
        write(self.repo.root, "desktop/web/scripts/x.mjs", "export {}\n")
        write(self.repo.root, "desktop/src/lib.rs", "pub fn f() {}\n")
        report = score.score_run(task(["components/shared/"]), self.repo.root, start, gates=False)
        self.assertEqual(report["areas"], {"canopi-desktop": ["desktop/src/lib.rs"], "desktop/web": ["desktop/web/package.json"],
                                           "desktop/web/scripts": ["desktop/web/scripts/x.mjs"]})

    def test_owners_go_through_the_scenario_matcher_and_locales_tests_docs_are_no_owner(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\n")
        write(self.repo.root, "desktop/web/src/i18n/en.json", '{"a": "b"}\n')
        write(self.repo.root, "desktop/web/src/__tests__/title-bar.test.tsx", "it('x', () => {})\n")
        write(self.repo.root, "docs/guides/x.md", "# x\n")
        write(self.repo.root, "common-types/src/settings.rs", "pub struct T;\n")
        report = self.score(["components/shared/", "app/design-edit/"])
        self.assertEqual(report["owners"]["touched"], ["components/shared/"])
        self.assertEqual(report["owners"]["missed"], ["app/design-edit/"])
        self.assertEqual(report["owners"]["outside"], ["common-types/src/settings.rs"])
        self.assertEqual((report["owners_touched"], report["wrong_owner"]), (1, 1))

    def test_a_python_test_is_no_module_so_never_a_wrong_owner_edit(self):
        touched = ["scripts/test_generate_web_catalog.py", "scripts/agent_trials/test_score.py", "scripts/generate-web-catalog.py"]
        owners = score.match_owners(REPO, touched, ["scripts/generate-web-catalog.py"])
        self.assertEqual(owners, {"touched": ["scripts/generate-web-catalog.py"], "missed": [], "outside": []})

    def test_the_same_inputs_give_the_same_score(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\n")
        write(self.repo.root, "desktop/web/src/new-file.ts", "export {}\n")
        first = self.score(["components/shared/DesignNameField.tsx"])
        second = self.score(["components/shared/DesignNameField.tsx"])
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))


class GatesTest(unittest.TestCase):
    def setUp(self):
        self.repo = TrialRepo()
        self.addCleanup(self.repo.close)
        for crate in ("desktop", "bindings-gen"):
            name = "canopi-desktop" if crate == "desktop" else crate
            write(self.repo.root, f"{crate}/Cargo.toml", f'[package]\nname = "{name}"\n')
        self.ran = []
        real = score.run_gate
        score.run_gate = lambda name, cmd, cwd, logdir, env=None: self.ran.append((name, cmd)) or {"gate": name, "result": "pass", "log": None}
        self.addCleanup(setattr, score, "run_gate", real)

    def gates(self, *changed):
        self.ran.clear()
        score.run_gates(self.repo.root, list(changed), Path(self.repo.tmp.name))
        return dict(self.ran)

    def test_clippy_lints_every_workspace_member_and_each_touched_crate_runs_its_tests(self):
        ran = self.gates("bindings-gen/src/analysis_registry.rs", "desktop/src/ipc/settings.rs")
        self.assertIn("--workspace", ran["clippy"])
        self.assertEqual(ran["cargo-test-bindings-gen"], ["cargo", "test", "-p", "bindings-gen"])
        self.assertEqual(ran["cargo-test-canopi-desktop"], ["cargo", "test", "-p", "canopi-desktop", "--", "settings"])

    def test_a_bindings_gen_change_alone_runs_its_own_tests_and_no_desktop_tests(self):
        ran = self.gates("bindings-gen/src/design_format.rs")
        self.assertEqual(sorted(ran), ["cargo-test-bindings-gen", "clippy"])

    def test_a_shared_contract_or_workspace_manifest_change_runs_every_member_s_tests(self):
        for changed in ("common-types/src/settings.rs", "Cargo.toml"):
            with self.subTest(changed):
                ran = self.gates(changed)
                self.assertEqual(ran["cargo-test-workspace"], ["cargo", "test", "--workspace"])
                self.assertFalse([name for name in ran if name.startswith("cargo-test-") and name != "cargo-test-workspace"])


class TranscriptMetricsTest(unittest.TestCase):
    def setUp(self):
        self.repo = TrialRepo()
        self.addCleanup(self.repo.close)
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\n")

    def test_a_missing_transcript_leaves_the_transcript_metrics_absent_never_zero(self):
        for path in (None, self.repo.root / "no-such.jsonl"):
            with self.subTest(path=path):
                report = score.score_run(task(["components/shared/"]), self.repo.root, self.repo.start, gates=False, transcript=path)
                for key in score.TRANSCRIPT_METRICS:
                    self.assertNotIn(key, report)
                self.assertEqual(report["transcript"], None if path is None else {"path": str(path), "missing": True})

    def test_a_transcript_adds_files_read_tokens_and_gate_failures(self):
        line = {"type": "assistant", "message": {"id": "a", "model": "m", "content": [
            {"type": "tool_use", "id": "u", "name": "Read", "input": {"file_path": f"{self.repo.root}/x.ts"}}],
            "usage": {"input_tokens": 1, "output_tokens": 2}}}
        path = self.repo.root.parent / "t.jsonl"
        path.write_text(json.dumps(line) + "\n")
        report = score.score_run(task(["components/shared/"]), self.repo.root, self.repo.start, gates=False, transcript=path)
        self.assertEqual((report["files_read"], report["tokens"]["total"], report["gate_failures"]), (1, 3, 0))
        self.assertEqual(report["transcript"], {"path": str(path), "missing": False})


class UsageLimitRunTest(unittest.TestCase):
    def test_a_run_stopped_by_a_usage_limit_is_unscored_and_nothing_schedules_a_resume(self):
        repo = TrialRepo()
        self.addCleanup(repo.close)
        write(repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\n")
        stop = {"type": "assistant", "isApiErrorMessage": True, "error": "rate_limit", "message": {
            "id": "s", "model": "<synthetic>", "content": [{"type": "text", "text": "You've hit your session limit"}]}}
        path = repo.root.parent / "t.jsonl"
        path.write_text(json.dumps(stop) + "\n")
        out = repo.root.parent / "records" / "t5-r1.json"
        before = sorted(p.name for p in repo.root.parent.iterdir())
        code = score.main(["run", "t5", str(repo.root), "--start", repo.start, "--transcript", str(path), "--json", str(out)])
        record = json.loads(out.read_text())
        self.assertEqual(code, 0)
        self.assertEqual((record["status"], record["unscored_reason"]), ("unscored", "usage-limit"))
        for key in ("files_changed", "area_count", "wrong_owner", "gates", *score.TRANSCRIPT_METRICS):
            self.assertNotIn(key, record)
        self.assertEqual(sorted(p.name for p in repo.root.parent.iterdir()), sorted(before + ["records"]))
        self.assertEqual(sorted(p.name for p in out.parent.iterdir()), ["t5-r1.json"])


SEED = """diff --git a/desktop/web/src/components/shared/DesignNameField.tsx b/desktop/web/src/components/shared/DesignNameField.tsx
--- a/desktop/web/src/components/shared/DesignNameField.tsx
+++ b/desktop/web/src/components/shared/DesignNameField.tsx
@@ -1 +1 @@
-export const a = 1
+export const a = 0
"""


class PrepareTest(unittest.TestCase):
    def setUp(self):
        self.repo = TrialRepo()
        self.addCleanup(self.repo.close)
        write(self.repo.root, "scripts/agent_trials/tasks/t8.json", "{}\n")
        write(self.repo.root, "scripts/agent_trials/seeds/t8-expected.md", "the expected fix\n")
        git(self.repo.root, "add", "-A")
        git(self.repo.root, "commit", "-q", "-m", "harness")
        self.base = git(self.repo.root, "rev-parse", "HEAD")
        self.seed = Path(self.repo.tmp.name) / "seed.patch"
        self.seed.write_text(SEED)
        self.task = dict(task(["components/shared/"]), seed=str(self.seed))
        self.dest = Path(self.repo.tmp.name) / "trial-t8-baseline-r1"

    def prepare(self, start=None):
        return score.prepare(self.task, start or self.base, self.dest, source=self.repo.root)

    def test_prepare_makes_a_repository_of_one_start_commit_without_the_harness_and_with_the_seed(self):
        start = self.prepare()
        dest = self.dest
        self.assertEqual(start, git(dest, "rev-parse", "HEAD"))
        self.assertFalse((dest / "scripts/agent_trials").exists())
        self.assertEqual((dest / "desktop/web/src/components/shared/DesignNameField.tsx").read_text(), "export const a = 0\n")
        self.assertEqual(git(dest, "status", "--porcelain"), "")
        report = score.score_run(self.task, dest, start, gates=False)
        self.assertEqual(report["files_changed"], 0)

    def test_the_trial_repository_s_history_holds_neither_the_harness_nor_the_seed(self):
        self.prepare()
        dest = self.dest
        self.assertEqual(git(dest, "rev-list", "--count", "--all"), "1")
        self.assertEqual(git(dest, "for-each-ref", "--format=%(refname)"), "refs/heads/main")
        history = git(dest, "log", "--all", "-p", "--format=%B")
        for leak in ("agent_trials", "expected fix", "export const a = 1", "seed", "trial", "harness"):
            self.assertNotIn(leak, history)
        with self.assertRaises(subprocess.CalledProcessError):
            git(dest, "cat-file", "-e", self.base)

    def test_prepare_from_a_start_whose_harness_differs_from_the_source_head_drops_the_harness(self):
        write(self.repo.root, "scripts/agent_trials/tasks/t8.json", '{"changed": true}\n')
        git(self.repo.root, "commit", "-qam", "the harness moved on")
        start = self.prepare(self.base)
        self.assertFalse((self.dest / "scripts/agent_trials").exists())
        self.assertEqual(git(self.dest, "rev-list", "--count", "--all"), "1")
        self.assertEqual(start, git(self.dest, "rev-parse", "HEAD"))

    def test_a_seed_that_no_longer_applies_refuses_the_run_as_stale_and_names_the_re_expression(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const moved = 1\n")
        git(self.repo.root, "commit", "-qam", "the code moved on")
        head = git(self.repo.root, "rev-parse", "HEAD")
        with self.assertRaises(score.Refused) as refused:
            self.prepare(head)
        self.assertIn("stale seed", str(refused.exception))
        self.assertIn("writes a new seed for the same bug", str(refused.exception))
        self.assertFalse(self.dest.exists())

    def test_prepare_refuses_a_destination_that_is_not_empty(self):
        write(self.dest, "x", "user work\n")
        with self.assertRaises(score.Refused):
            self.prepare()
        self.assertEqual(sorted(p.name for p in self.dest.iterdir()), ["x"])

    def test_a_commit_on_main_in_the_trial_repository_still_counts_against_the_printed_start(self):
        start = self.prepare()
        git(self.dest, "config", "user.email", "agent@example.invalid")
        git(self.dest, "config", "user.name", "agent")
        write(self.dest, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 1\n")
        git(self.dest, "commit", "-qam", "fix")
        report = score.score_run(self.task, self.dest, start, gates=False)
        self.assertEqual(report["files"], {"desktop/web/src/components/shared/DesignNameField.tsx": {"added": 1, "removed": 1}})
        for scored in (self.task, task(["components/shared/"])):  # a moving ref is refused, seeded task or not
            with self.subTest(seed=scored.get("seed")), self.assertRaises(score.Refused) as refused:
                score.score_run(scored, self.dest, "main", gates=False)
            self.assertIn("the commit prepare printed", str(refused.exception))

    def test_a_seeded_task_scored_from_a_start_without_its_seed_is_refused_as_stale(self):
        with self.assertRaises(score.Refused) as refused:
            score.score_run(self.task, self.repo.root, self.base, gates=False)
        self.assertIn("stale seed", str(refused.exception))


class TaskFilesTest(unittest.TestCase):
    def test_every_task_file_names_its_text_path_owners_and_start(self):
        tasks = score.load_tasks()
        self.assertEqual(sorted(tasks), [f"t{i}" for i in range(1, 9)])
        for tid, t in tasks.items():
            with self.subTest(tid):
                self.assertTrue(t["task"] and t["path"] and t["owners"])
                self.assertEqual(sorted(t["start"]), ["baseline", "close"])
                for owner in t["owners"]:
                    module = owner if isinstance(owner, str) else owner["module"]
                    self.assertTrue(score.owner_exists(REPO, module) or not isinstance(owner, str), module)

    def test_only_t8_carries_a_seed_and_its_expected_fix(self):
        tasks = score.load_tasks()
        self.assertEqual([tid for tid, t in tasks.items() if "seed" in t], ["t8"])
        self.assertTrue((score.HERE / tasks["t8"]["seed"]).is_file())
        self.assertTrue((score.HERE / tasks["t8"]["expected"]).is_file())


if __name__ == "__main__":
    unittest.main()
