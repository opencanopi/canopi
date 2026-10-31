"""Tests of scripts/check_docs_policy.py's policy-table checks: the contract-suite registry (2.1-M193), the owner
headers (2.1-Q212), the policy inventory and the rule ids the docs cite (2.1-M193, 2.1-M189). The docs checks' other
cases stay in scripts/test_check_docs.py."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

from scripts.check_docs import ROOT
from scripts.check_docs_policy import check_inventory, check_owner_headers, check_rule_ids, check_suites, list_rules
from scripts.test_check_docs import git_repo


class GatedRun(unittest.TestCase):
    def test_the_docs_gate_module_runs_these_tests(self):
        """The Docs gate and the CI docs job run `unittest scripts.test_check_docs`; it loads this module too."""
        names = {test.id() for suite in unittest.defaultTestLoader.loadTestsFromName("scripts.test_check_docs") for test in iterate(suite)}
        self.assertIn("scripts.test_check_docs_policy.SuiteRegistryChecks.test_a_built_or_planned_suite_passes", names)


def iterate(suite):
    for test in suite:
        yield from iterate(test) if isinstance(test, unittest.TestSuite) else [test]


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

    def test_a_flag_without_its_value_or_an_unknown_flag_fails_instead_of_running_the_plain_check(self):
        for args in (["--phase-close"], ["--phase-clos", "F2"], ["--root"]):
            with self.subTest(args=args):
                run = subprocess.run([sys.executable, str(ROOT / "scripts/check_docs.py"), *args], capture_output=True, text=True)
                self.assertEqual(run.returncode, 2)
                self.assertNotIn("Documentation checks", run.stdout)


PHASE_NAMED = re.compile(r"\((?:created at )?(?:Phases?|Step) ([^)]*)\)")


def phase_rows():
    """(row, phase) for each policy/inventory.json row whose quote places its check in a policy/rules.json phase,
    "(Phase 2b)", "(Phases 2c and 2d)", "(created at Phase 2c's start, ...)", "(Step 2.0.4)": the latest one named.
    A primitive row (no state) is held by policy/primitives.json's status instead."""
    phases = json.loads((ROOT / "policy/rules.json").read_text(encoding="utf-8"))["phases"]
    for row in json.loads((ROOT / "policy/inventory.json").read_text(encoding="utf-8"))["rows"]:
        named = PHASE_NAMED.search(row.get("quote", ""))
        words = [word for word in re.findall(r"[\w.]+", named.group(1)) if word in phases] if named else []
        if words:
            yield row, words[-1]


class InventoryPhaseHolds(unittest.TestCase):
    """canopi-f47t.52.228.8 (F1b-c4 review): a row whose quote places a still-unbuilt check in a phase is held by
    `--phase-close` of that phase; a `process` state let the ToolHost owner test (2c), the Session scenarios and
    Draft-store suite (2b) and the D3 rollback test (4) pass their closes unbuilt."""

    HANDED_OFF = {"adr-0026-the-rollback-lane-step-2"}

    def held(self, ids):
        registry = list_rules(ROOT)
        for row, phase in phase_rows():
            if row["id"] not in ids or row.get("state") is None or "exists" in row["state"]:
                continue
            with self.subTest(row=row["id"], phase=phase):
                errors = check_inventory(ROOT, phase_close=phase, registry=registry)
                self.assertTrue(any(f": {row['id']} " in error for error in errors), f"--phase-close {phase} lets {row['id']} pass unbuilt")

    def test_a_row_quoting_an_unbuilt_check_for_a_phase_is_held_at_that_phase_close_canopi_f47t_52_228_8(self):
        self.held({row["id"] for row, _ in phase_rows()} - self.HANDED_OFF)

    def test_phase_0_closes_with_no_inventory_row_still_planned_for_it_canopi_f47t_52_228(self):
        """Seam 5 of the Phase 0 hand-off: F2 shipped its checks, but four rows still planned them for F2."""
        self.assertEqual(check_inventory(ROOT, phase_close="0", registry=list_rules(ROOT)), [])

    @unittest.expectedFailure
    def test_the_rollback_lane_is_held_at_step_2_0_4_close_main_files_its_bead_canopi_f47t_52_228_8(self):
        """Expected to fail until main files the Step 2.0.4 rollback-lane bead and plans the row (owner main)."""
        self.held(self.HANDED_OFF)


if __name__ == "__main__":
    unittest.main()
