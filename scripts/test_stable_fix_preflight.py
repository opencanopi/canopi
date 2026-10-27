"""`stable_fix_preflight.py` over planted git repositories (2.1-M215, 2.1-Q202)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "stable_fix_preflight.py"
PACKAGE = "desktop/web/package.json"
PREPARE = '    "prepare": "cd ../.. && husky desktop/web/.husky",\n'
PACKAGE_TEXT = '{\n  "scripts": {\n    "build": "vite build",\n' + PREPARE + '    "test": "vitest"\n  }\n}\n'
RELEASE_CANDIDATE_PREFLIGHT = "      - run: python3 -I main-tools/scripts/stable_fix_preflight.py --repo . --ref HEAD\n"


class PreflightCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)
        self.git("init", "-q", "-b", "main")
        self.write({PACKAGE: PACKAGE_TEXT, "src.txt": "2.0.3\n"})
        self.beads("canopi-far8", "canopi-ab12")
        self.commit("chore(release): 2.0.3")
        self.git("tag", "v2.0.3")
        self.git("checkout", "-q", "-b", "release/2.0")

    def git(self, *args):
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.test",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.test", "GIT_CONFIG_GLOBAL": os.devnull}
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True,
                              env=env).stdout

    def write(self, files):
        for path, text in files.items():
            (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / path).write_text(text)

    def beads(self, *ids):
        self.write({".beads/issues.jsonl": "".join(json.dumps({"id": bead, "title": bead}) + "\n" for bead in ids)})

    def commit(self, message, files=None):
        if files:
            self.write(files)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def cut(self, extra=None):
        """The cut's CI-only first commit: workflow triggers, the preflight steps copied into the branch's Release
        Candidate (its only way to run there) and the husky `prepare` script dropped."""
        self.commit("ci(release): release/2.0 triggers and Stable-fix preflight; drop husky prepare", {
            PACKAGE: PACKAGE_TEXT.replace(PREPARE, ""), ".github/workflows/build.yml": "on: push\n",
            ".github/workflows/release-candidate.yml": RELEASE_CANDIDATE_PREFLIGHT, **(extra or {})})

    def on_main(self, message, files=None):
        self.git("checkout", "-q", "main")
        self.commit(message, files)
        self.git("checkout", "-q", "release/2.0")

    def preflight(self):
        return subprocess.run([sys.executable, "-I", str(SCRIPT), "--repo", str(self.repo), "--ref", "release/2.0",
                               "--main", "main"], capture_output=True, text=True, check=False)

    def assert_passes(self):
        result = self.preflight()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_fails(self, message):
        result = self.preflight()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(message, result.stderr)


class StableFixPreflightTests(PreflightCase):
    def test_a_clean_history_passes(self):
        self.cut()
        self.commit("fix(frontend): keep the export name\n\nStable-fix: canopi-far8", {"src.txt": "fix far8\n"})
        self.commit("fix(desktop): open the file\n\nStable-fix: canopi-ab12", {"src.txt": "fix ab12\n"})
        # canopi-far8 reached main by its own trailer; canopi-ab12 landed on main first, named in its subject.
        self.on_main("fix(frontend): keep the export name\n\nStable-fix: canopi-far8", {"main.txt": "far8\n"})
        self.on_main("fix(desktop): open the file (canopi-ab12)", {"main.txt": "ab12\n"})
        self.assert_passes()

    def test_a_release_commit_after_the_cut_without_a_stable_fix_trailer_fails(self):
        self.cut()
        self.commit("fix(frontend): a quiet fix", {"src.txt": "quiet\n"})
        self.assert_fails("carries no Stable-fix: <bead> trailer")

    def test_a_trailer_naming_a_bead_absent_from_the_issue_list_fails(self):
        self.cut()
        self.commit("fix(frontend): a fix\n\nStable-fix: canopi-zz99", {"src.txt": "zz99\n"})
        self.on_main("fix(frontend): a fix\n\nStable-fix: canopi-zz99")
        self.assert_fails("canopi-zz99 is not in main's .beads/issues.jsonl")

    def test_a_bead_no_main_commit_names_fails_the_canopi_far8_shape(self):
        self.cut()
        self.commit("fix(frontend): keep the export name\n\nStable-fix: canopi-far8", {"src.txt": "far8\n"})
        # A main commit naming a longer id, or naming the bead only in its body, does not count.
        self.on_main("fix(frontend): another (canopi-far8.1)\n\nSee canopi-far8.", {"main.txt": "x\n"})
        self.assert_fails("no main commit names canopi-far8")

    def test_the_cut_commit_is_exempt_only_when_dropping_prepare_and_ci_is_its_whole_change(self):
        self.cut(extra={"src.txt": "a source change in the cut\n"})
        self.assert_fails("carries no Stable-fix: <bead> trailer")


class CutShapeTests(PreflightCase):
    def test_a_cut_that_also_changes_another_package_script_is_not_exempt(self):
        self.commit("ci(release): drop husky prepare", {
            PACKAGE: PACKAGE_TEXT.replace(PREPARE, "").replace('"vite build"', '"vite build --debug"')})
        self.assert_fails("carries no Stable-fix: <bead> trailer")

    def test_only_the_first_commit_after_the_cut_is_exempt(self):
        self.cut()
        self.commit("ci(release): more triggers", {".github/workflows/build.yml": "on: [push]\n"})
        self.assert_fails("carries no Stable-fix: <bead> trailer")

    def test_a_ref_with_no_commit_after_the_cut_passes(self):
        self.assert_passes()


if __name__ == "__main__":
    unittest.main()
