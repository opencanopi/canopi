"""`stable_fix_preflight.py` over planted git repositories (2.1-M215, 2.1-Q202)."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "stable_fix_preflight.py"
PACKAGE = "desktop/web/package.json"
PREPARE = '    "prepare": "cd ../.. && husky desktop/web/.husky",\n'
# A release/2.0 tree that carries main's release interface (the port stable fix); 2.0.3's tree has no tauri script.
TAURI = '    "tauri": "cd ../.. && tauri",\n'
PACKAGE_TEXT = '{\n  "scripts": {\n    "build": "vite build",\n' + PREPARE + TAURI + '    "test": "vitest"\n  }\n}\n'
RELEASE_CANDIDATE_PREFLIGHT = "      - run: python3 -I release-tools/scripts/stable_fix_preflight.py --repo . --ref HEAD\n"
WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "release-candidate.yml"


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
        """The cut's CI-only first commit: workflow triggers, main's preflight steps carried into the branch's Release
        Candidate (a `--ref release/2.0` dispatch runs that copy) and the husky `prepare` script dropped."""
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

    def test_a_cut_whose_release_candidate_does_not_run_mains_preflight_fails(self):
        """`gh workflow run release-candidate.yml --ref release/2.0` runs the branch's copy: without the step, no
        Stable-fix check and no fail-closed message."""
        self.cut(extra={".github/workflows/release-candidate.yml": "      - run: echo build\n"})
        self.commit("fix(frontend): a fix\n\nStable-fix: canopi-far8", {"src.txt": "far8\n"})
        self.on_main("fix(frontend): a fix\n\nStable-fix: canopi-far8")
        self.assert_fails("release-candidate.yml does not run main's Stable-fix preflight")

    def test_a_later_commit_dropping_the_preflight_from_the_release_candidate_fails(self):
        self.cut()
        self.commit("fix(ci): a fix\n\nStable-fix: canopi-far8", {".github/workflows/release-candidate.yml": "on: x\n"})
        self.on_main("fix(ci): a fix\n\nStable-fix: canopi-far8")
        self.assert_fails("release-candidate.yml does not run main's Stable-fix preflight")

    def test_a_ref_with_no_commit_after_the_cut_passes(self):
        self.assert_passes()


class ReleaseInterfaceTests(PreflightCase):
    def test_a_release_2_0_ref_without_mains_release_interface_fails_closed_naming_the_port(self):
        self.cut()
        self.commit("fix(frontend): a fix\n\nStable-fix: canopi-far8", {PACKAGE: PACKAGE_TEXT.replace(PREPARE, "").replace(
            TAURI, "")})
        self.on_main("fix(frontend): a fix\n\nStable-fix: canopi-far8")
        self.assert_fails("port main's Release Candidate and its release interface to release/2.0")


class ReleaseCandidateToolsTests(unittest.TestCase):
    """main's release tools build any ref: the tools checkout names main, never the dispatched commit (2.1-M216)."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_every_tools_checkout_names_main(self):
        checkouts = re.findall(r"- uses: actions/checkout@\S+\n((?:[ ]{8,}\S.*\n)+)", self.text)
        tools = [block for block in checkouts if re.search(r"^\s+path: release-tools$", block, re.M)]
        self.assertEqual(len(tools), 2, "the preflight and web jobs each check out release-tools")
        # The preflight checks out main and records it; the web job reuses that commit.
        self.assertRegex(tools[0], r"(?m)^\s+ref: main$")
        self.assertRegex(tools[1], r"(?m)^\s+ref: \$\{\{ needs\.preflight\.outputs\.tools_sha \}\}$")
        self.assertIn("tools_sha=$tools_sha", self.text)
        self.assertNotIn("github.sha", self.text)

    def test_release_tools_run_from_mains_checkout_against_the_ref(self):
        calls = re.findall(r"python3 -I (\S*)(web_release|stable_fix_preflight)\.py", self.text)
        self.assertTrue(calls)
        for prefix, tool in calls:
            self.assertEqual(prefix, "release-tools/scripts/", f"{tool}.py runs from main's checkout")
        # Contract reads apply the ref's files, not main's.
        for command in ("catalog-asset-name", "unpack-catalog"):
            self.assertRegex(self.text, rf"release-tools/scripts/web_release\.py {command} --root \.")


if __name__ == "__main__":
    unittest.main()
