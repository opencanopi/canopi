"""The commit gate's workflow and its two data families, guarded-files and flake-quarantine (2.1-Q222, 2.1-Q225,
2.1-M203; canopi-f47t.52.228.10), split from test_commit_gate.py under the 600-line file-size rule (2.1-Q243).
"""
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[1]


def observe(family_file, paths, root=ROOT):
    """check.mjs's observeFamily over `paths` with the family's real adapter: [(code, message)]."""
    script = (
        "import { observeFamily, loadAdapter } from './policy/check.mjs';"
        "const [file, paths] = [process.argv[1], JSON.parse(process.argv[2])];"
        "const doc = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));"
        "const found = await observeFamily(process.cwd(), file, doc, paths, await loadAdapter(process.cwd(), doc.tool));"
        "console.log(JSON.stringify(found.map((r) => [r.code, r.message])));"
    )
    result = subprocess.run(["node", "--input-type=module", "-e", script, family_file, json.dumps(paths)], cwd=root,
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class CommitGateWorkflow(unittest.TestCase):
    def test_canopi_f47t_52_228_10_the_workflow_runs_pr_and_tree_mode_as_the_commit_gate_check(self):
        text = (ROOT / ".github/workflows/commit-gate.yml").read_text(encoding="utf-8")
        self.assertIn("name: Commit gate", text, "the ruleset's required check (2.1-Q222)")
        self.assertIn("types: [opened, synchronize, reopened, edited]", text)
        self.assertIn("fetch-depth: 0", text)
        self.assertIn("node-version: 24", text)
        self.assertRegex(text, r'scripts/commit_gate\.py pr "\$BASE" "\$HEAD" --body-file')
        self.assertRegex(text, r'scripts/commit_gate\.py tree "\$BEFORE" "\$AFTER"')
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        self.assertNotRegex(code, r"\bgh\b|unittest", "no gh call; F3c's unittest discover runs the gate's tests")


class PolicyFamilies(unittest.TestCase):
    def test_canopi_f47t_52_228_10_a_flake_quarantine_marker_naming_no_bead_is_refused_by_the_family(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "policy", root / "policy", ignore=shutil.ignore_patterns("fixtures"))
            marker = "flake-" + "quarantine:"
            (root / "a.test.ts").write_text(f"// {marker}\nit.skip('x', () => {{}})\n// {marker} canopi-x.1\nit.skip('y', () => {{}})\n",
                                            encoding="utf-8")
            found = observe("policy/ratchets/flake-quarantine.json", ["a.test.ts"], root)
            self.assertEqual(sorted(code for code, _ in found), ["refused-site", "unlisted"], found)
            self.assertIn("names no bead", next(m for c, m in found if c == "refused-site"))

    def test_canopi_f47t_52_228_10_a_guarded_file_deleted_or_renamed_is_stale(self):
        family = json.loads((ROOT / "policy/ratchets/guarded-files.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(family["entries"]), ["desktop/capabilities/main-window.json", "policy/ratchets/coverage.json"])
        found = observe("policy/ratchets/guarded-files.json", ["policy/ratchets/coverage.json"])
        self.assertEqual([code for code, _ in found], ["stale"], found)
        self.assertIn("main-window.json", found[0][1])


class PlantedRunner(unittest.TestCase):
    def test_canopi_f47t_52_228_10_the_planted_runner_copies_every_module_the_gate_imports(self):
        """A module the gate imports but the planted repository lacks fails the import, and every case read silent."""
        case = ROOT / "policy/fixtures/rules/gate-no-attribution/case.json"
        result = subprocess.run(["python3", "scripts/commit_gate.py", "planted", str(case)], cwd=ROOT, capture_output=True,
                                text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["rules"], ["gate-no-attribution"], result.stderr)
