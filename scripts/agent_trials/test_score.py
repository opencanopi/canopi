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
