"""Tests of scripts/check_docs_policy.py's policy-table checks: the contract-suite registry (2.1-M193), the owner
headers (2.1-Q212), the policy inventory and the rule ids the docs cite (2.1-M193, 2.1-M189). The docs checks' other
cases stay in scripts/test_check_docs.py."""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from scripts.check_docs import ROOT
from scripts.check_docs_policy import check_inventory, check_owner_headers, check_rule_ids, check_suites
from scripts.test_check_docs import git_repo


class SuiteRegistryChecks(unittest.TestCase):
    """2.1-M193, contracts §13: each policy/suites.json row names an existing test or a planned phase and bead."""

    def errors(self, suites):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "policy").mkdir()
            (root / "policy/rules.json").write_text(json.dumps({"version": 1, "phases": ["F1b", "2b"], "rules": []}), encoding="utf-8")
            (root / "src").mkdir()
            (root / "src/conformance.test.ts").write_text("", encoding="utf-8")
            if suites is not None:
                (root / "policy/suites.json").write_text(json.dumps(suites), encoding="utf-8")
            return check_suites(root)

    def table(self, *rows):
        return {"version": 1, "suites": [{"id": "runtime-surfaces", "sides": ["fake", "runtime"], "test": "src/conformance.test.ts"}, *rows]}

    def test_a_built_or_planned_suite_passes(self):
        self.assertEqual(self.errors(self.table({"id": "format-core", "sides": ["ts", "core"], "planned": {"phase": "2b", "bead": "canopi-f47t.52.49"}})), [])

    def test_a_missing_test_path_fails(self):
        self.assertEqual(self.errors(self.table({"id": "gone", "sides": ["a", "b"], "test": "src/gone.test.ts"})), [
            "policy/suites.json: suite gone names test src/gone.test.ts, which does not exist",
        ])

    def test_a_row_with_neither_test_nor_plan_fails(self):
        self.assertEqual(self.errors(self.table({"id": "loose", "sides": ["a", "b"]})), [
            "policy/suites.json: suite loose needs a test path or planned{phase, bead}",
        ])

    def test_a_planned_phase_must_be_a_rules_json_phase(self):
        self.assertEqual(self.errors(self.table({"id": "later", "sides": ["a", "b"], "planned": {"phase": "9z", "bead": "canopi-x"}})), [
            "policy/suites.json: suite later plans phase 9z, which is not in policy/rules.json phases",
        ])

    def test_a_rules_key_or_a_missing_table_fails(self):
        self.assertEqual(self.errors({**self.table(), "rules": []}), [
            "policy/suites.json: a top-level `rules` key would be read as a rule table (check.mjs loadTableRules)",
        ])
        self.assertEqual(self.errors(None), ["policy/suites.json: missing; the contract-suite registry (2.1-M193)"])


class OwnerHeaders(unittest.TestCase):
    """2.1-Q212: the owner modules primitives.json and layers.json name carry a header (owner role, invariants, ADR)."""

    HEADER = "// utils/ids.ts: Owner of id minting. Invariant: ids are opaque. Rule ids-only-in-minters (ADR 0028).\n"

    def errors(self, files):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "policy").mkdir()
            (root / "policy/primitives.json").write_text(json.dumps({"version": 1, "rules": [
                {"id": "ids-only-in-minters", "tool": "ast-grep", "owner_today": "desktop/web/src/utils/ids.ts"},
                {"id": "no-module-effect", "tool": "ast-grep", "owner_today": "none"},
                {"id": "fetch-only-in-owners", "tool": "ast-grep", "owner_today": "desktop/web/src/web", "also_owners": ["desktop/web/src/utils/ids.ts"]},
            ], "held": [{"primitive": "F34", "owner_today": "desktop/web/src/app/key-router.ts", "check": "key-listener-only-in-key-router", "phase": "none"}]}), encoding="utf-8")
            (root / "policy/layers.json").write_text(json.dumps({"version": 1, "layers": [{"path": "web/", "layer": "L3", "edition": "web", "owner": "the Web host"}],
                "packages": [{"pattern": "@tauri-apps/", "owner": ["platform/*.desktop.ts"], "rule": "tauri-only-in-native-host", "editions": ["desktop"]}]}), encoding="utf-8")
            for name, text in files.items():
                (root / "desktop/web/src" / name).parent.mkdir(parents=True, exist_ok=True)
                (root / "desktop/web/src" / name).write_text(text, encoding="utf-8")
            return check_owner_headers(root)

    def owners(self, **overrides):
        files = {
            "utils/ids.ts": self.HEADER.replace("ids-only-in-minters", "ids-only-in-minters, fetch-only-in-owners") + "export const id = 1\n",
            "app/key-router.ts": "/**\n * app/key-router.ts: Owner of window key listeners (key-listener-only-in-key-router, ADR 0020).\n */\nexport {}\n",
            "platform/files.desktop.ts": "// Owner of native file dialogs: tauri-only-in-native-host (ADR 0022).\nexport {}\n",
            "web/a.ts": "export {}\n",
        }
        files.update(overrides)
        return files

    def test_every_named_file_owner_with_its_header_passes_and_directories_carry_none(self):
        self.assertEqual(self.errors(self.owners()), [])

    def test_a_file_owner_a_table_names_without_a_header_fails(self):
        self.assertEqual(self.errors(self.owners(**{"platform/files.desktop.ts": "export {}\n"})), [
            "desktop/web/src/platform/files.desktop.ts: an owner module (tauri-only-in-native-host in policy/layers.json) has no `Owner of` header naming its role, invariants and ADR (2.1-Q212)",
        ])

    def test_a_file_claiming_owner_of_with_no_table_row_fails(self):
        self.assertEqual(self.errors(self.owners(**{"web/b.ts": "// web/b.ts: Owner of the Web release watch (ADR 0030).\nexport {}\n"})), [
            "desktop/web/src/web/b.ts: claims `Owner of` but no row of policy/primitives.json or policy/layers.json names it an owner (2.1-Q212)",
        ])

    def test_a_header_names_each_rule_the_file_owns_and_an_adr(self):
        self.assertEqual(self.errors(self.owners(**{"utils/ids.ts": "// Owner of id minting: ids-only-in-minters.\nexport {}\n"})), [
            "desktop/web/src/utils/ids.ts: its owner header names no rule fetch-only-in-owners",
            "desktop/web/src/utils/ids.ts: its owner header names no ADR (ADR NNNN)",
        ])

    def test_the_header_is_the_leading_comment_only(self):
        late = "export const id = 1\n" + self.HEADER.replace("ids-only-in-minters", "ids-only-in-minters, fetch-only-in-owners")
        self.assertEqual(self.errors(self.owners(**{"utils/ids.ts": late})), [
            "desktop/web/src/utils/ids.ts: an owner module (fetch-only-in-owners, ids-only-in-minters in policy/primitives.json) has no `Owner of` header naming its role, invariants and ADR (2.1-Q212)",
        ])


# Inventory and rule-id cases (2.1-M193, M189): {check, files, expected, phase_close?, no_node?} over base.json's tree.
CASES = ROOT / "policy/fixtures/check-docs"


def policy_root(directory, files):
    root = Path(directory)
    for name, text in {**json.loads((CASES / "base.json").read_text(encoding="utf-8"))["files"], **files}.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text if isinstance(text, str) else json.dumps(text), encoding="utf-8")
    return root


class InventoryAndRuleIdChecks(unittest.TestCase):
    def test_each_case(self):
        for path in sorted(path for path in CASES.glob("*.json") if path.name != "base.json"):
            case = json.loads(path.read_text(encoding="utf-8"))
            with self.subTest(case=path.stem), TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"PATH": ""} if case.get("no_node") else {}):
                root = policy_root(directory, case["files"])
                errors = check_inventory(root, phase_close=case.get("phase_close")) if case["check"] == "inventory" else check_rule_ids(root)
                self.assertEqual(errors, case["expected"])

    def test_the_phase_close_flag_reaches_the_inventory_check(self):
        row = {"id": "at-f2", "doc": "AGENTS.md", "quote": "Preserve", "state": {"planned": {"phase": "F2", "bead": "canopi-a"}}}
        with TemporaryDirectory() as directory:
            root = policy_root(directory, {"policy/inventory.json": {"version": 1, "rows": [row]}})
            git_repo(root, {})
            run = subprocess.run([sys.executable, str(ROOT / "scripts/check_docs.py"), "--phase-close", "F2", "--root", str(root)], capture_output=True, text=True)
            self.assertIn("policy/inventory.json: at-f2 is still planned at the close of phase F2 (phase F2, canopi-a)", run.stderr)
            self.assertEqual(run.returncode, 1)


if __name__ == "__main__":
    unittest.main()
