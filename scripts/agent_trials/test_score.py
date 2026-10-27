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

    def test_the_same_inputs_give_the_same_score(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const a = 2\n")
        write(self.repo.root, "desktop/web/src/new-file.ts", "export {}\n")
        first = self.score(["components/shared/DesignNameField.tsx"])
        second = self.score(["components/shared/DesignNameField.tsx"])
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))


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
        git(self.repo.root, "add", "-A")
        git(self.repo.root, "commit", "-q", "-m", "harness")
        self.base = git(self.repo.root, "rev-parse", "HEAD")
        self.seed = Path(self.repo.tmp.name) / "seed.patch"
        self.seed.write_text(SEED)
        self.task = dict(task(["components/shared/"]), seed=str(self.seed))

    def test_prepare_makes_one_start_commit_without_the_harness_and_with_the_seed(self):
        start = score.prepare(self.task, self.repo.root)
        root = self.repo.root
        self.assertEqual(start, git(root, "rev-parse", "HEAD"))
        self.assertEqual(git(root, "rev-parse", "HEAD^"), self.base)
        self.assertFalse((root / "scripts/agent_trials").exists())
        self.assertEqual((root / "desktop/web/src/components/shared/DesignNameField.tsx").read_text(), "export const a = 0\n")
        self.assertEqual(git(root, "status", "--porcelain"), "")
        report = score.score_run(self.task, root, start, gates=False)
        self.assertEqual(report["files_changed"], 0)

    def test_a_seed_that_no_longer_applies_refuses_the_run_as_stale_and_names_the_re_expression(self):
        write(self.repo.root, "desktop/web/src/components/shared/DesignNameField.tsx", "export const moved = 1\n")
        git(self.repo.root, "commit", "-qam", "the code moved on")
        head = git(self.repo.root, "rev-parse", "HEAD")
        with self.assertRaises(score.Refused) as refused:
            score.prepare(self.task, self.repo.root)
        self.assertIn("stale seed", str(refused.exception))
        self.assertIn("writes a new seed for the same bug", str(refused.exception))
        self.assertEqual(git(self.repo.root, "rev-parse", "HEAD"), head)
        self.assertTrue((self.repo.root / "scripts/agent_trials").exists())

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
