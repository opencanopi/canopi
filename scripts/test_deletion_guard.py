"""The test-deletion guard (scripts/deletion_guard.py through commit_gate.py; 2.1-Q224, 2.1-M199; canopi-f47t.52.228.10).

Chunk 2's user paths (plan:157), each a commit range judged by `commit_gate.py pr`: the routes for a deleted test (a
named new test, a merge-base Q row, `Retires-test` with the code deleted), rewording, loosening, skips and moves.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest

from scripts import deletion_guard
from scripts.test_commit_gate import CLOSED_BEAD, GateRepo, OPEN_BEAD, ROOT, git

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
        code, out = self.judge(KEPT.split("it('keeps the second")[0], "test(frontend): drop one (2.1-Q900)")
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
        code, out = self.gate(two, "test(frontend): keeps row 3 goes", before="feat(policy): guarded files (2.1-Q900)")
        self.assertEqual(code, 1, out)
        self.assertIn("'keeps row 3'", out)
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        code, out = self.gate(two, "test(frontend): row three is no behaviour (2.1-Q900)")
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
