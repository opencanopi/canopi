"""The test-deletion guard (scripts/deletion_guard.py through commit_gate.py; 2.1-Q224, 2.1-M199; canopi-f47t.52.228.10).

Chunk 2's user paths (plan:157), each a commit range judged by `commit_gate.py pr`: the routes for a deleted test (a
named new test, a merge-base Q row, `Retires-test` with the code deleted or a test of documentation only), rewording, loosening, skips and moves.
"""
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import json
import os
import unittest

from scripts import deletion_guard
from scripts.test_commit_gate import CLOSED_BEAD, GateRepo, OPEN_BEAD, Q_ROW, ROOT, git

# Spelled in two parts so the flake-quarantine adapter never reads this file's source as a marker.
MARKER = "flake-" + "quarantine:"

KEPT = """import { expect, it } from 'vitest'

it('keeps the first behaviour', () => {
  expect(1).toBe(1)
  expect(2).toBe(2)
})

it('keeps the second behaviour', () => {
  expect(3).toBe(3)
})
"""


class DeletionGuard(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = GateRepo(Path(self._tmp.name))
        self.repo.write({"desktop/web/src/a.test.ts": KEPT})
        self.repo.base = self.repo.commit("test(frontend): two behaviours")

    def tearDown(self):
        self._tmp.cleanup()

    def judge(self, text, message, extra=None):
        self.repo.write({"desktop/web/src/a.test.ts": text, **(extra or {})})
        result = self.repo.gate("pr", self.repo.base, self.repo.commit(message))
        return result.returncode, result.stdout + result.stderr

    def test_canopi_f47t_52_228_10_a_deleted_test_with_no_route_is_refused(self):
        code, out = self.judge(KEPT.split("it('keeps the second")[0], "test(frontend): drop one")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-deleted", out)

    def test_canopi_f47t_52_228_10_a_reworded_title_without_rewords_test_is_refused(self):
        code, out = self.judge(KEPT.replace("keeps the second behaviour", "keeps behaviour two"), "test(frontend): reword")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)

    def test_canopi_f47t_52_228_10_a_reworded_title_with_rewords_test_passes(self):
        code, out = self.judge(KEPT.replace("keeps the second behaviour", "keeps behaviour two"),
                               "test(frontend): reword\n\nRewords-test: keeps the second behaviour -> keeps behaviour two")
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_a_removed_expect_in_a_kept_test_is_refused(self):
        code, out = self.judge(KEPT.replace("  expect(2).toBe(2)\n", ""), "test(frontend): fewer asserts")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-loosened", out)

    def test_canopi_f47t_52_228_10_a_moved_test_passes(self):
        second = "import { expect, it } from 'vitest'\n\n" + "it('keeps the second" + KEPT.split("it('keeps the second")[1]
        code, out = self.judge(KEPT.split("it('keeps the second")[0], "test(frontend): move",
                               {"desktop/web/src/b.test.ts": second})
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_a_deleted_test_whose_replacement_the_message_names_passes(self):
        code, out = self.judge(KEPT.replace("keeps the second behaviour", "keeps the third behaviour"),
                               "test(frontend): replace\n\nThe new test 'keeps the third behaviour' holds it.")
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_a_deleted_test_citing_a_merge_base_q_row_passes(self):
        code, out = self.judge(KEPT.split("it('keeps the second")[0], f"test(frontend): drop one ({Q_ROW})")
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_retires_test_with_the_code_under_test_deleted_passes(self):
        self.repo.write({"desktop/web/src/b.ts": "export const b = 1\nexport const c = 2\n",
                         "desktop/web/src/b.test.ts": "import { expect, it } from 'vitest'\nimport { b, c } from './b'\n\n"
                                                     "it('reads b', () => {\n  expect(b).toBe(1)\n})\n\n"
                                                     "it('reads c', () => {\n  expect(c).toBe(2)\n})\n"})
        base = self.repo.commit("test(frontend): b and c")
        self.repo.write({"desktop/web/src/b.ts": "export const b = 1\n",
                         "desktop/web/src/b.test.ts": "import { expect, it } from 'vitest'\nimport { b } from './b'\n\n"
                                                     "it('reads b', () => {\n  expect(b).toBe(1)\n})\n"})
        result = self.repo.gate("pr", base, self.repo.commit("refactor(frontend): drop c\n\nRetires-test: reads c \u2014 nothing reads c"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_retires_test_without_deleting_the_code_under_test_is_refused(self):
        code, out = self.judge(KEPT.split("it('keeps the second")[0],
                               "test(frontend): drop one\n\nRetires-test: keeps the second behaviour \u2014 no user sees it")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-deleted", out)

    def test_canopi_f47t_52_228_10_a_reworded_title_moved_to_another_file_is_refused(self):
        second = "import { expect, it } from 'vitest'\n\nit('keeps behaviour two', () => {\n  expect(3).toBe(3)\n})\n"
        code, out = self.judge(KEPT.split("it('keeps the second")[0],
                               "test(frontend): reword\n\nRewords-test: keeps the second behaviour -> keeps behaviour two",
                               {"desktop/web/src/b.test.ts": second})
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)

    def test_canopi_f47t_52_228_10_rewords_test_folds_a_test_into_a_kept_one_in_its_file_that_grows_enough(self):
        """A fold: the new title already exists in the deleted test's file and gains at least its assertions (2.1-M330)."""
        message = "test(frontend): fold\n\nRewords-test: keeps the second behaviour -> keeps the first behaviour"
        alone = KEPT.split("it('keeps the second")[0]
        code, out = self.judge(alone.replace("  expect(2).toBe(2)\n", "  expect(2).toBe(2)\n  expect(3).toBe(3)\n"), message)
        self.assertEqual(code, 0, out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        code, out = self.judge(alone, message)
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        other = "import { expect, it } from 'vitest'\n\nit('elsewhere', () => {\n  expect(0).toBe(0)\n})\n"
        self.repo.write({"desktop/web/src/b.test.ts": other})
        self.repo.base = self.repo.commit("test(frontend): elsewhere")
        code, out = self.judge(alone, message.replace("keeps the first behaviour", "elsewhere"),
                               {"desktop/web/src/b.test.ts": other.replace("  expect(0)", "  expect(3).toBe(3)\n  expect(0)")})
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)

    def test_canopi_f47t_52_228_10_a_reworded_title_with_fewer_assertions_is_refused(self):
        text = KEPT.replace("keeps the first behaviour", "keeps behaviour one").replace("  expect(2).toBe(2)\n", "")
        code, out = self.judge(text, "test(frontend): reword\n\nRewords-test: keeps the first behaviour -> keeps behaviour one")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)

    def test_canopi_f47t_52_228_10_a_matcher_swap_from_the_closed_list_is_refused(self):
        code, out = self.judge(KEPT.replace("expect(3).toBe(3)", "expect(3).toBeTruthy()"), "test(frontend): looser")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-loosened", out)

    def test_canopi_f47t_52_228_10_a_new_skip_without_a_route_is_refused(self):
        code, out = self.judge(KEPT.replace("it('keeps the second", "it.skip('keeps the second"), "test(frontend): skip")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-loosened", out)

    def quarantine(self, entries):
        path = self.repo.path / "policy/ratchets/flake-quarantine.json"
        family = json.loads(path.read_text(encoding="utf-8"))
        family["entries"] = entries
        return {"policy/ratchets/flake-quarantine.json": json.dumps(family, indent=2) + "\n"}

    def test_canopi_f47t_52_228_10_a_flake_quarantine_skip_with_its_entry_and_open_bead_passes(self):
        skipped = KEPT.replace("it('keeps the second", f"// {MARKER} {OPEN_BEAD}\nit.skip('keeps the second")
        entry = {"desktop/web/src/a.test.ts": {"count": 1, "bead": OPEN_BEAD}}
        code, out = self.judge(skipped, f"test(frontend): quarantine a flake ({OPEN_BEAD})", self.quarantine(entry))
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_a_flake_quarantine_marker_naming_no_bead_or_a_closed_one_is_refused(self):
        for marker, bead in ((f"// {MARKER}", OPEN_BEAD), (f"// {MARKER} {CLOSED_BEAD}", CLOSED_BEAD)):
            with self.subTest(marker=marker):
                skipped = KEPT.replace("it('keeps the second", f"{marker}\nit.skip('keeps the second")
                entry = {"desktop/web/src/a.test.ts": {"count": 1, "bead": bead}}
                code, out = self.judge(skipped, f"test(frontend): quarantine ({bead})", self.quarantine(entry))
                self.assertEqual(code, 1, out)
                self.assertIn("gate-test-loosened", out)
                self.repo.write({"desktop/web/src/a.test.ts": KEPT, **self.quarantine({})})
                self.repo.base = self.repo.commit("test(frontend): restore")

    def test_canopi_f47t_52_228_10_a_deleted_rust_test_and_a_removed_python_assert_are_refused(self):
        rust = "#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(1 + 1, 2);\n    }\n}\n"
        python = "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(1 + 1, 2)\n        self.assertTrue(True)\n"
        self.repo.write({"desktop/src/a.rs": rust, "scripts/test_a.py": python})
        base = self.repo.commit("test: rust and python")
        self.repo.write({"desktop/src/a.rs": "#[cfg(test)]\nmod tests {}\n",
                         "scripts/test_a.py": python.replace("        self.assertTrue(True)\n", "")})
        result = self.repo.gate("pr", base, self.repo.commit("test: fewer"))
        out = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, out)
        self.assertIn("gate-test-deleted", out)
        self.assertIn("gate-test-loosened", out)



    def stricter(self, before, after):
        self.repo.write({"desktop/web/src/b.test.ts": before[0], "scripts/test_b.py": before[1]})
        base = self.repo.commit("test: membership asserts")
        self.repo.write({"desktop/web/src/b.test.ts": after[0], "scripts/test_b.py": after[1]})
        result = self.repo.gate("pr", base, self.repo.commit("test: one whole-value equality"))
        return result.returncode, result.stdout + result.stderr

    MEMBERS = ("it('lists', () => {\n  const got = list()\n  expect(got).toContain('a')\n  expect(got).not.toContain('b')\n"
               "  expect(size).toBe(1)\n})\n",
               "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_lists(self):\n        got = listed()\n"
               "        self.assertIn('a', got)\n        self.assertNotIn('b', got)\n        self.assertTrue(size)\n")

    def test_canopi_f47t_52_228_10_a_whole_value_equality_replacing_membership_asserts_on_it_passes(self):
        ts, py = self.MEMBERS
        after = (ts.replace("  expect(got).toContain('a')\n  expect(got).not.toContain('b')\n", "  expect(got).toStrictEqual(['a'])\n"),
                 py.replace("        self.assertIn('a', got)\n        self.assertNotIn('b', got)\n",
                            "        self.assertEqual(got, ['a'])\n"))
        code, out = self.stricter(self.MEMBERS, after)
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_membership_asserts_dropped_without_an_equality_on_that_value_are_refused(self):
        ts, py = self.MEMBERS
        for after in ((ts.replace("  expect(got).not.toContain('b')\n", ""), py),  # fewer asserts, no equality
                      (ts.replace("  expect(got).toContain('a')\n  expect(got).not.toContain('b')\n", "  expect(other).toEqual(['a'])\n"),
                       py.replace("        self.assertIn('a', got)\n        self.assertNotIn('b', got)\n",
                                  "        self.assertEqual(other, ['a'])\n")),  # equality on another value
                      (ts.replace("  expect(got).toContain('a')\n  expect(got).not.toContain('b')\n  expect(size).toBe(1)\n",
                                  "  expect(got).toEqual(['a'])\n"), py)):  # covers the membership asserts, not the third
            with self.subTest(after=after):
                code, out = self.stricter(self.MEMBERS, after)
                self.assertEqual(code, 1, out)
                self.assertIn("gate-test-loosened", out)

    def test_canopi_f47t_52_228_10_naming_a_new_title_excuses_only_the_test_it_replaces(self):
        """A title in the subject is no route; a quoted replacement routes one deletion and keeps its assertions."""
        text = (KEPT.replace("keeps the first behaviour", "keeps behaviour").replace("  expect(2).toBe(2)\n", "")
                .replace("expect(1).toBe(1)", "expect(1).toBeTruthy()").replace("expect(3).toBe(3)", "expect(3).toBeTruthy()"))
        code, out = self.judge(text, "test(frontend): keeps behaviour")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)
        self.assertIn("gate-test-loosened: desktop/web/src/a.test.ts: 'keeps the second behaviour'", out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        code, out = self.judge(text, "test(frontend): replace it\n\nThe new test 'keeps behaviour' holds it.")
        self.assertEqual(code, 1, out)
        self.assertIn("fewer assertions", out)
        self.assertIn("gate-test-loosened: desktop/web/src/a.test.ts: 'keeps the second behaviour'", out)


    def test_canopi_f47t_52_228_10_retires_test_passes_an_inline_rust_test_deleted_with_its_function(self):
        rust = ("pub fn kept() {}\n\npub fn gone() -> u8 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n"
                "    #[test]\n    fn gone_works() {\n        assert_eq!(gone(), 1);\n    }\n}\n")
        self.repo.write({"desktop/src/lib.rs": rust})
        base = self.repo.commit("test: gone")
        message = "refactor: drop gone\n\nRetires-test: gone_works \u2014 nothing calls gone"
        for head, code in ((rust.split("\n\n#[cfg(test)]")[0].replace("\n\npub fn gone() -> u8 {\n    1\n}", "")
                            + "\n#[cfg(test)]\nmod tests {}\n", 0),
                           (rust.split("\n\n#[cfg(test)]")[0] + "\n#[cfg(test)]\nmod tests {}\n", 1)):
            with self.subTest(code=code):
                git(self.repo.path, "checkout", "-q", "--detach", base)
                self.repo.write({"desktop/src/lib.rs": head})
                result = self.repo.gate("pr", base, self.repo.commit(message))
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_retires_test_passes_an_e2e_spec_deleted_with_its_feature_code(self):
        spec = "import { expect, test } from '@playwright/test'\n\ntest('opens the panel', async ({ page }) => {\n  expect(page).toBeTruthy()\n})\n"
        self.repo.write({"desktop/web/e2e/canvas/panel.spec.ts": spec, "desktop/web/src/app/panel.ts": "export const panel = 1\n"})
        base = self.repo.commit("test(frontend): panel")
        message = "refactor(frontend): drop the panel\n\nRetires-test: opens the panel \u2014 the panel is gone"
        for extra, code in (({"desktop/web/src/app/panel.ts": ""}, 0), ({}, 1)):
            with self.subTest(code=code):
                git(self.repo.path, "checkout", "-q", "--detach", base)
                self.repo.write({"desktop/web/e2e/canvas/panel.spec.ts": "", **extra})
                result = self.repo.gate("pr", base, self.repo.commit(message))
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)


class CodeUnderTest(unittest.TestCase):
    """Retires-test needs the code the test covered deleted: its own module's code lines, not a test helper, a rename or
    a sibling file (contracts §12; 2.1-Q224)."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = GateRepo(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def retire(self, base, head, title, renames=()):
        self.repo.write(base)
        start = self.repo.commit("test: base")
        self.repo.write(head)
        for old, new in renames:
            git(self.repo.path, "mv", old, new)
        result = self.repo.gate("pr", start, self.repo.commit(f"refactor: retire\n\nRetires-test: {title} \u2014 gone"))
        return result.returncode, result.stdout + result.stderr

    def test_canopi_f47t_52_228_10_retires_test_in_a_rust_test_module_needs_its_parent_modules_code_deleted(self):
        parent = "pub fn load() -> u8 {\n    7\n}\n\npub fn kept() {}\n\n#[cfg(test)]\nmod tests;\n"
        tests = ("use super::*;\n\nfn fixture() -> u8 {\n    load()\n}\n\n#[test]\nfn loads() {\n    assert_eq!(fixture(), 7);\n}\n\n"
                 "#[test]\nfn other() {\n    kept();\n}\n")
        kept = "use super::*;\n\n#[test]\nfn other() {\n    kept();\n}\n"
        base = {"desktop/src/design/mod.rs": parent, "desktop/src/design/tests.rs": tests}
        code, out = self.retire(base, {"desktop/src/design/tests.rs": kept}, "loads")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-deleted", out)
        git(self.repo.path, "checkout", "-q", "--detach", "HEAD~2")
        code, out = self.retire(base, {"desktop/src/design/tests.rs": kept,
                                       "desktop/src/design/mod.rs": parent.replace("pub fn load() -> u8 {\n    7\n}\n\n", "")}, "loads")
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_retires_test_is_refused_for_a_sibling_files_rename_or_a_moved_module(self):
        spec = ("import { expect, it } from 'vitest'\nimport { panel } from './panel'\n\n"
                "it('opens the panel', () => {\n  expect(panel).toBe(1)\n})\n\nit('stays', () => {\n  expect(1).toBe(1)\n})\n")
        kept = spec.split("it('opens the panel'")[0] + "it('stays', () => {\n  expect(1).toBe(1)\n})\n"
        base = {"desktop/web/src/app/panel.ts": "export const panel = 1\nexport const other = 2\n",
                "desktop/web/src/app/format.ts": "const a = 1\nexport { a }\n", "desktop/web/src/app/panel.test.ts": spec}
        cases = (({"desktop/web/src/app/format.ts": "const b = 1\nexport { b }\n"}, (), 1),
                 ({}, (("desktop/web/src/app/panel.ts", "desktop/web/src/app/panel-view.ts"),), 1),
                 ({"desktop/web/src/app/panel.ts": "export const other = 2\n"}, (), 0))
        for i, (extra, renames, want) in enumerate(cases):
            with self.subTest(case=i):
                if i:
                    git(self.repo.path, "checkout", "-q", "--detach", "HEAD~2")
                code, out = self.retire(base, {"desktop/web/src/app/panel.test.ts": kept, **extra}, "opens the panel", renames)
                self.assertEqual(code, want, out)

    def test_canopi_f47t_52_228_10_retires_test_on_an_e2e_spec_is_refused_when_only_an_unrelated_src_line_changes(self):
        spec = "import { expect, test } from '@playwright/test'\n\ntest('follows me', async ({ page }) => {\n  expect(page).toBeTruthy()\n})\n"
        base = {"desktop/web/e2e/canvas/my-location.spec.ts": spec,
                "desktop/web/src/app/x.ts": "export const a = 1\nexport const b = 2\n"}
        for i, (src, want) in enumerate((("export const a = 2\nexport const b = 2\n", 1), ("export const b = 2\n", 1), ("", 0))):
            with self.subTest(case=i):
                if i:
                    git(self.repo.path, "checkout", "-q", "--detach", "HEAD~2")
                code, out = self.retire(base, {"desktop/web/e2e/canvas/my-location.spec.ts": "", "desktop/web/src/app/x.ts": src},
                                        "follows me")
                self.assertEqual(code, want, out)

    def test_canopi_f47t_52_228_10_retires_test_in_a_rust_integration_test_is_refused_for_a_helper_deleted_beside_it(self):
        """An integration test covers its package's src/: deleting a helper fn from its own file deletes nothing it covered."""
        tests = ("fn helper() -> u8 {\n    7\n}\n\n#[test]\nfn loads() {\n    assert_eq!(helper(), 7);\n}\n\n"
                 "#[test]\nfn other() {\n    assert_eq!(1, 1);\n}\n")
        kept = "#[test]\nfn other() {\n    assert_eq!(1, 1);\n}\n"
        base = {"desktop/tests/io.rs": tests, "desktop/src/io.rs": "pub fn load() -> u8 {\n    7\n}\n"}
        for i, (src, want) in enumerate(((None, 1), ("", 0))):
            with self.subTest(case=i):
                if i:
                    git(self.repo.path, "checkout", "-q", "--detach", "HEAD~2")
                head = {"desktop/tests/io.rs": kept, **({} if src is None else {"desktop/src/io.rs": src})}
                code, out = self.retire(base, head, "loads")
                self.assertEqual(code, want, out)
                if want:
                    self.assertIn("gate-test-deleted", out)

    def test_canopi_f47t_52_228_10_retires_test_routes_a_test_whose_only_subject_is_a_documentation_file(self):
        """A test reading only guide prose covers no code (AGENTS.md: retired when no user sees what it checked); one
        that also names a code path or uses a name imported from repository code still needs that code deleted."""
        head = "import unittest\n\nclass T(unittest.TestCase):\n    def test_kept(self):\n        self.assertTrue(1)\n"
        doc = 'guide = (ROOT / "docs/guides/agentic-delivery.md").read_text()\n        self.assertIn("knob", guide)'
        cases = ((doc, "", 0), ('readme = Path("README.md").read_text()\n        self.assertIn("x", readme)', "", 0),
                 (doc + '\n        self.assertTrue((ROOT / "scripts/gate.py").exists())', "", 1),
                 (doc + "\n        self.assertEqual(gate.KNOB, 1)", "from scripts import gate\n", 1),
                 (doc + "\n        self.assertTrue(self.gate.run())", "", 1), ('self.assertEqual(1, 1)', "", 1))
        for i, (body, imports, want) in enumerate(cases):
            with self.subTest(case=i):
                if i:
                    git(self.repo.path, "checkout", "-q", "--detach", "HEAD~2")
                base = head.replace("import unittest\n", f"import unittest\n{imports}") + \
                    f"\n    def test_reads_the_guide(self):\n        {body}\n"
                code, out = self.retire({"scripts/test_guide.py": base}, {"scripts/test_guide.py": head}, "test_reads_the_guide")
                self.assertEqual(code, want, out)
        spec = ("import { readFileSync } from 'node:fs'\nimport { expect, it } from 'vitest'\nimport { panel } from './panel'\n\n"
                "it('names the guide', () => {\n  expect(readFileSync('docs/guides/x.md', 'utf8')).toContain(panel)\n})\n")
        git(self.repo.path, "checkout", "-q", "--detach", "HEAD~2")
        code, out = self.retire({"desktop/web/src/guide.test.ts": spec}, {"desktop/web/src/guide.test.ts": ""}, "names the guide")
        self.assertEqual(code, 1, out)


class NamedRoute(unittest.TestCase):
    OLD = ("it('returns three items', () => {\n  expect(a).toBe(1)\n  expect(b).toBe(2)\n})\n"
           "it('keeps order', () => {\n  expect(c).toBe(3)\n})\n"
           "it('stays strict', () => {\n  expect(d).toBe(4)\n})\n")
    NEW = ("it('returns items', () => {\n  expect(a).toBeTruthy()\n})\n"
           "it('stays strict', () => {\n  expect(d).toBeTruthy()\n})\n")

    def judge(self, message, old=OLD, new=NEW):
        return sorted({rule for rule, _ in deletion_guard.judge(
            [("a.test.ts", "a.test.ts", old, new)], message, authorised=False, deleted_code=set(), quarantined={},
            bead_open=lambda _: True)})

    def test_canopi_f47t_52_228_10_an_added_title_appearing_in_the_message_is_not_a_route_for_every_change(self):
        self.assertEqual(self.judge("test: returns items"), ["gate-test-loosened", "gate-test-reworded"])
        self.assertIn("gate-test-loosened", self.judge("test: 'returns items' replaces both"))

    def test_canopi_f47t_52_228_10_a_quoted_replacement_routes_one_deletion_with_no_fewer_assertions(self):
        old = "it('keeps order', () => {\n  expect(c).toBe(3)\n})\n"
        new = "it('keeps the order of rows', () => {\n  expect(c).toBe(3)\n})\n"
        self.assertEqual(self.judge("test: the new test 'keeps the order of rows' holds it", old, new), [])
        self.assertEqual(self.judge("test: the new test keeps the order of rows", old, new), ["gate-test-reworded"])
        two = old + "it('keeps size', () => {\n  expect(e).toBe(5)\n})\n"
        self.assertEqual(self.judge("test: 'keeps the order of rows' holds it", two, new), ["gate-test-deleted"])


    def test_canopi_f47t_52_228_10_quoted_replacements_pair_own_file_first_then_by_assertions(self):
        """A deletion with no replacement in its own file never takes the one a later deletion's file holds."""
        one = lambda title, n: f"it('{title}', () => {{\n" + "  expect(1).toBe(1)\n" * n + "})\n"  # noqa: E731
        files = [("a.test.ts", "a.test.ts", one("a one", 1) + one("a keep", 1), one("a keep", 1)),
                 ("b.test.ts", "b.test.ts", one("b one", 3), one("b two", 3)),
                 (None, "c.test.ts", "", one("c moved", 1))]
        found = deletion_guard.judge(files, "test: 'b two' and 'c moved' hold them", authorised=False, deleted_code={},
                                     quarantined={}, bead_open=lambda _: True)
        self.assertEqual(found, [])
        files = [("a.test.ts", "a.test.ts", one("a one", 1) + one("a keep", 1), one("a keep", 1)),
                 ("b.test.ts", "b.test.ts", one("b one", 3) + one("b keep", 1), one("b keep", 1)),
                 (None, "c.test.ts", "", one("c big", 3) + one("c small", 1))]
        found = deletion_guard.judge(files, "test: 'c big' and 'c small' hold them", authorised=False, deleted_code={},
                                     quarantined={}, bead_open=lambda _: True)
        self.assertEqual(found, [])


class TestBodies(unittest.TestCase):
    def test_canopi_f47t_52_228_10_a_test_body_ends_with_its_own_block_not_at_the_next_test(self):
        """A helper's asserts between two tests are no test's: adding a test before the helper loosens nothing."""
        python = ("class A(unittest.TestCase):\n    def test_one(self):\n        self.assertTrue(1)\n\n\n"
                  "class B(unittest.TestCase):\n    def helper(self):\n        self.assertEqual(1, 1)\n\n    def test_two(self):\n        pass\n")
        self.assertEqual(deletion_guard.asserts("scripts/test_a.py", deletion_guard.tests("scripts/test_a.py", python)["test_one"]), 1)
        rust = "#[test]\nfn one() {\n    let s = \"}\";\n    assert!(true);\n}\n\nfn helper() { assert_eq!(1, 1); }\n"
        self.assertEqual(deletion_guard.asserts("a.rs", deletion_guard.tests("a.rs", rust)["one"]), 1)
        js = "it('one', () => {\n  expect(')').toBe(')') // )\n})\n\nfunction helper() { expect(1).toBe(1) }\n"
        self.assertEqual(deletion_guard.asserts("a.test.ts", deletion_guard.tests("a.test.ts", js)["one"]), 1)


ROWS = "import { expect, it } from 'vitest'\n\nit.each([1, 2, 3])('keeps row %i', (n) => {\n  expect(n).toBeGreaterThan(0)\n})\n"


class VitestListPass(unittest.TestCase):
    """`vitest list --staticParse=false`, base against head, sees `.each` rows the regex reads as one title."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = GateRepo(Path(self._tmp.name))
        (self.repo.path / "desktop/web").mkdir(parents=True)
        (self.repo.path / "desktop/web/node_modules").symlink_to(ROOT / "desktop/web/node_modules")
        self.repo.write({".gitignore": "node_modules\n", "desktop/web/src/rows.test.ts": ROWS})
        self.repo.base = self.repo.commit("test(frontend): three rows")

    def tearDown(self):
        self._tmp.cleanup()

    def gate(self, files, message, before=None):
        if before:
            self.repo.write({"notes.txt": "x\n"})
            self.repo.commit(before)
        self.repo.write(files)
        result = self.repo.gate("pr", self.repo.base, self.repo.commit(message), "--vitest")
        return result.returncode, result.stdout + result.stderr

    def test_canopi_f47t_52_228_10_a_deleted_each_row_is_refused_by_the_vitest_list_pass(self):
        code, out = self.gate({"desktop/web/src/rows.test.ts": ROWS.replace("[1, 2, 3]", "[1, 2]")}, "test(frontend): two rows")
        self.assertEqual(code, 1, out)
        self.assertIn("vitest list: gate-test-deleted: 'keeps row 3'", out)

    def test_canopi_f47t_52_228_10_a_test_split_into_a_new_file_passes_the_vitest_list_pass(self):
        code, out = self.gate({"desktop/web/src/rows.test.ts": ROWS.replace("[1, 2, 3]", "[1, 2]"),
                               "desktop/web/src/row-three.test.ts": ROWS.replace("[1, 2, 3]", "[3]")},
                              "test(frontend): row three in its own file")
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_a_renamed_test_file_dropping_an_each_row_is_refused(self):
        (self.repo.path / "desktop/web/src/rows.test.ts").unlink()
        code, out = self.gate({"desktop/web/src/kept-rows.test.ts": ROWS.replace("[1, 2, 3]", "[1, 2]")},
                              "test(frontend): rename the rows test")
        self.assertEqual(code, 1, out)
        self.assertIn("'keeps row 3'", out)

    def test_canopi_f47t_52_228_10_only_the_deleting_commit_routes_a_vitest_list_loss(self):
        """A Q row in a sibling commit, or the title unquoted in a sentence, routes nothing; the commit's own Q row does."""
        two = {"desktop/web/src/rows.test.ts": ROWS.replace("[1, 2, 3]", "[1, 2]")}
        code, out = self.gate(two, "test(frontend): keeps row 3 goes", before=f"feat(policy): guarded files ({Q_ROW})")
        self.assertEqual(code, 1, out)
        self.assertIn("'keeps row 3'", out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        code, out = self.gate(two, f"test(frontend): row three is no behaviour ({Q_ROW})")
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_a_quoted_title_routes_one_each_row_and_only_from_the_commit_that_adds_it(self):
        """One quoted title replaces one lost row; a title a later commit adds routes nothing in the deleting commit."""
        rows = "desktop/web/src/rows.test.ts"
        anything = "\nit('anything', () => {\n  expect(4).toBe(4)\n})\n"
        code, out = self.gate({rows: ROWS.replace("[1, 2, 3]", "[1]") + anything}, "test(frontend): 'anything' replaces rows")
        self.assertEqual(code, 1, out)
        self.assertEqual(out.count("vitest list: gate-test-deleted"), 1, out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        code, out = self.gate({rows: ROWS.replace("[1, 2, 3]", "[1, 2]") + anything}, "test(frontend): 'anything' replaces row 3")
        self.assertEqual(code, 0, out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        self.repo.write({rows: ROWS.replace("[1, 2, 3]", "[1, 2]")})
        self.repo.commit("test(frontend): 'anything' replaces row 3")
        self.repo.write({rows: ROWS.replace("[1, 2, 3]", "[1, 2]") + anything})
        result = self.repo.gate("pr", self.repo.base, self.repo.commit("test(frontend): add a test"), "--vitest")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("vitest list: gate-test-deleted: 'keeps row 3'", result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_rewords_test_in_the_vitest_pass_needs_its_new_title_added_in_the_same_file(self):
        rows = "desktop/web/src/rows.test.ts"
        held = "\nit('holds row 3', () => {\n  expect(3).toBe(3)\n})\n"
        message = "test(frontend): reword row 3\n\nRewords-test: keeps row 3 -> holds row 3\n"
        code, out = self.gate({rows: ROWS.replace("[1, 2, 3]", "[1, 2]")}, message)
        self.assertEqual(code, 1, out)
        self.assertIn("vitest list: gate-test-deleted: 'keeps row 3'", out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        code, out = self.gate({rows: ROWS.replace("[1, 2, 3]", "[1, 2]"),
                               "desktop/web/src/held.test.ts": "import { expect, it } from 'vitest'\n" + held}, message)
        self.assertEqual(code, 1, out)
        self.assertIn("vitest list: gate-test-deleted: 'keeps row 3'", out)


    def test_canopi_f47t_52_228_10_a_title_lost_before_the_gate_is_listed_and_one_lost_after_it_refused(self):
        """pr mode judges no commit whose parent lacks scripts/commit_gate.py, so a title such a commit deleted, on a
        branch merged after judged commits, is listed under "before the gate"; one a judged commit deletes still needs
        its route."""
        rows, env = "desktop/web/src/rows.test.ts", {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.repo.write({"notes.txt": "x\n"})
        judged = self.repo.commit("docs: notes")
        git(self.repo.path, "checkout", "-q", "--orphan", "pregate")
        git(self.repo.path, "rm", "-rq", "--cached", ".")
        for entry in self.repo.path.iterdir():
            if entry.name not in (".git", ".gitignore", "desktop"):
                shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
        shutil.rmtree(self.repo.path / "desktop/capabilities")
        self.repo.commit("test(frontend): three rows, no gate yet")
        self.repo.write({rows: ROWS.replace("[1, 2, 3]", "[1, 2]")})
        self.repo.commit("test(frontend): row 3 goes before the gate")
        git(self.repo.path, "checkout", "-q", "-f", judged)
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-commit", "--allow-unrelated-histories",
            "pregate", env=env, check=False)
        self.repo.write({rows: ROWS.replace("[1, 2, 3]", "[1, 2]")})
        merged = self.repo.commit("Merge branch 'pregate'")
        result = self.repo.gate("pr", self.repo.base, merged, "--vitest")
        out = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, out)
        self.assertIn("before the gate (removed by a commit before the gate; not judged): 'keeps row 3'", out)
        self.repo.write({rows: ROWS.replace("[1, 2, 3]", "[1]")})
        result = self.repo.gate("pr", self.repo.base, self.repo.commit("test(frontend): row 2 goes"), "--vitest")
        out = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, out)
        self.assertIn("vitest list: gate-test-deleted: 'keeps row 2'", out)
        self.assertNotIn("gate-test-deleted: 'keeps row 3'", out)

if __name__ == "__main__":
    unittest.main()
