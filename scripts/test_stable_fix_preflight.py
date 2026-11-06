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
RELEASE_CANDIDATE = ".github/workflows/release-candidate.yml"
# main's copy refuses to run from any other branch, so release/2.0, cut at the reader release's tag, carries it.
RELEASE_CANDIDATE_MAIN = "      - if: github.ref != 'refs/heads/main'\n        run: exit 1\n"
WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "release-candidate.yml"


class PreflightCase(unittest.TestCase):
    def setUp(self):
        """release/2.0 cut at the reader release's tag, carrying main's tree (2.1-Q268)."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)
        self.git("init", "-q", "-b", "main")
        self.write({"src.txt": "2.1.0-reader\n", RELEASE_CANDIDATE: RELEASE_CANDIDATE_MAIN})
        self.beads("canopi-far8", "canopi-ab12")
        self.commit("chore(release): the reader release")
        self.git("tag", "v2.1.0-reader")
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

    def on_main(self, message, files=None):
        self.git("checkout", "-q", "main")
        self.commit(message, files)
        self.git("checkout", "-q", "release/2.0")

    def preflight(self, *args):
        args = args or ("--ref", "release/2.0")
        return subprocess.run([sys.executable, "-I", str(SCRIPT), "--repo", str(self.repo), *args, "--main", "main"],
                              capture_output=True, text=True, check=False)

    def assert_passes(self):
        result = self.preflight()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_fails(self, message):
        result = self.preflight()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(message, result.stderr)


class StableFixPreflightTests(PreflightCase):
    def test_a_clean_history_passes(self):
        self.commit("fix(frontend): keep the export name\n\nStable-fix: canopi-far8", {"src.txt": "fix far8\n"})
        self.commit("fix(desktop): open the file\n\nStable-fix: canopi-ab12", {"src.txt": "fix ab12\n"})
        # canopi-far8 reached main by its own trailer; canopi-ab12 landed on main first, named in its subject.
        self.on_main("fix(frontend): keep the export name\n\nStable-fix: canopi-far8", {"main.txt": "far8\n"})
        self.on_main("fix(desktop): open the file (canopi-ab12)", {"main.txt": "ab12\n"})
        self.assert_passes()

    def test_a_release_commit_after_the_cut_without_a_stable_fix_trailer_fails(self):
        self.commit("fix(frontend): a quiet fix", {"src.txt": "quiet\n"})
        self.assert_fails("carries no Stable-fix: <bead> trailer")

    def test_the_first_commit_after_the_cut_needs_a_trailer_even_when_ci_only(self):
        """The cut at the reader release's tag has no CI-only first commit: nothing after it is exempt (2.1-Q268)."""
        self.commit("ci(release): release/2.0 triggers", {".github/workflows/build.yml": "on: push\n"})
        self.assert_fails("carries no Stable-fix: <bead> trailer")

    def test_a_trailer_naming_a_bead_absent_from_the_issue_list_fails(self):
        self.commit("fix(frontend): a fix\n\nStable-fix: canopi-zz99", {"src.txt": "zz99\n"})
        self.on_main("fix(frontend): a fix\n\nStable-fix: canopi-zz99")
        self.assert_fails("canopi-zz99 is not in main's .beads/issues.jsonl")

    def test_a_bead_no_main_commit_names_fails_the_canopi_far8_shape(self):
        self.commit("fix(frontend): keep the export name\n\nStable-fix: canopi-far8", {"src.txt": "far8\n"})
        # A main commit naming a longer id, or naming the bead only in its body, does not count.
        self.on_main("fix(frontend): another (canopi-far8.1)\n\nSee canopi-far8.", {"main.txt": "x\n"})
        self.assert_fails("no main commit names canopi-far8")


class ReleaseCandidateCopyTests(PreflightCase):
    def test_a_ref_checked_out_as_head_is_named_by_its_dispatched_name_in_the_advice(self):
        """CI checks the dispatched ref out and passes `--ref HEAD`: the advice names the dispatched ref, never HEAD,
        so the printed dispatch builds release/2.0 (a `-f ref=HEAD` dispatch builds the default branch)."""
        self.commit("fix(ci): a fix\n\nStable-fix: canopi-far8", {RELEASE_CANDIDATE: "on: x\n"})
        self.on_main("fix(ci): a fix\n\nStable-fix: canopi-far8")
        result = self.preflight("--ref", "HEAD", "--name", "release/2.0")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("gh workflow run release-candidate.yml --ref main -f ref=release/2.0", result.stderr)
        self.assertNotIn("HEAD", result.stderr)

    def test_a_later_commit_bringing_back_a_release_candidate_that_runs_off_main_fails(self):
        """`gh workflow run release-candidate.yml --ref release/2.0` would build with that copy: no Stable-fix check.
        main's copy, the one that runs this, refuses the ref until that copy is gone, naming the dispatch of main's."""
        self.commit("fix(ci): a fix\n\nStable-fix: canopi-far8", {RELEASE_CANDIDATE: "on: x\n"})
        self.on_main("fix(ci): a fix\n\nStable-fix: canopi-far8")
        self.assert_fails("release-candidate.yml runs off main")
        self.assert_fails("Delete it in a stable fix")
        self.assert_fails("--ref main -f ref=release/2.0")

    def test_a_ref_carrying_mains_main_only_release_candidate_passes(self):
        self.commit("fix(frontend): a fix\n\nStable-fix: canopi-far8", {"src.txt": "far8\n"})
        self.on_main("fix(frontend): a fix\n\nStable-fix: canopi-far8")
        self.assert_passes()

    def test_a_ref_with_no_commit_after_the_cut_passes(self):
        self.assert_passes()


class UnreadableRefTests(PreflightCase):
    def test_a_tagless_cut_passes_and_a_missing_release_ref_is_refused_naming_the_git_failure(self):
        self.git("tag", "-d", "v2.1.0-reader")  # the cut is the merge base; no tag is read
        self.assert_passes()
        self.git("checkout", "-q", "main")
        self.git("branch", "-q", "-D", "release/2.0")
        result = self.preflight()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertRegex(result.stderr, r"^ERROR: git merge-base release/2\.0 main: .+")


def tools_checkouts(text):
    """Each `actions/checkout` step's `with:` block that checks out release-tools, in workflow order."""
    checkouts = re.findall(r"- uses: actions/checkout@\S+\n((?:[ ]{8,}\S.*\n)+)", text)
    return [block for block in checkouts if re.search(r"^\s+path: release-tools$", block, re.M)]


class ReleaseCandidateToolsTests(unittest.TestCase):
    """main's release tools build any ref: the tools checkout names main, never the dispatched commit (2.1-M216)."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_every_tools_checkout_names_main(self):
        tools = tools_checkouts(self.text)
        self.assertGreaterEqual(len(tools), 2, "the preflight and every later job running release tools check them out")
        # The preflight checks out main for a dispatch (a dry run: the change's tools, canopi-f47t.52.228.61) and
        # records it; every later job reuses that commit, so one run never mixes two copies of the tools.
        self.assertRegex(tools[0], r"(?m)^\s+ref: \$\{\{ github\.event_name == 'workflow_dispatch' && 'main' \|\| github\.sha \}\}$")
        for block in tools[1:]:
            self.assertRegex(block, r"(?m)^\s+ref: \$\{\{ needs\.preflight\.outputs\.tools_sha \}\}$")
        self.assertIn("tools_sha=$tools_sha", self.text)
        self.assertEqual(len(re.findall(r"(?m)^\s+ref: .*github\.sha", self.text)), 1, "github.sha checks out only a dry run's tools")

    def test_only_mains_copy_builds_a_candidate(self):
        """A dispatch runs the copy on --ref: the preflight job's first step refuses any branch but main, before any
        checkout, and names the dispatch of main's copy; the preflight script reads the same marker."""
        job = self.text.split("\n  preflight:\n", 1)[1]
        steps = job.split("\n    steps:\n", 1)[1]
        first = re.findall(r"(?m)^      - .*\n(?:(?!      - ).*\n)*", steps)[0]
        self.assertIn("if: github.ref != 'refs/heads/main'", first)
        self.assertIn("exit 1", first)
        self.assertIn("gh workflow run release-candidate.yml --ref main -f ref=", first)
        sys.path.insert(0, str(SCRIPT.parent))
        try:
            import stable_fix_preflight
        finally:
            sys.path.remove(str(SCRIPT.parent))
        self.assertIn(stable_fix_preflight.MAIN_ONLY, first)

    def test_the_preflight_names_the_dispatched_ref_not_head(self):
        call = re.search(r"python3 -I release-tools/scripts/stable_fix_preflight\.py .*", self.text).group(0)
        self.assertIn("--ref HEAD", call)
        self.assertIn('--name "$BUILD_REF"', call)
        step = self.text[:self.text.index(call)].rsplit("\n      - ", 1)[1]
        self.assertIn("BUILD_REF: ${{ inputs.ref }}", step)

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
