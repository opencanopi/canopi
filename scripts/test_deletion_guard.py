"""The test-deletion guard (scripts/deletion_guard.py through commit_gate.py; 2.1-Q224, 2.1-M199; canopi-f47t.52.228.10).

Chunk 2's user paths (plan:157), each a commit range judged by `commit_gate.py pr`: the routes for a deleted test (a
named new test, a merge-base Q row, `Retires-test` with the code deleted), rewording, loosening, skips and moves.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest

from scripts.test_commit_gate import CLOSED_BEAD, GateRepo, OPEN_BEAD

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

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_flake_quarantine_skip_with_its_entry_and_open_bead_passes(self):
        skipped = KEPT.replace("it('keeps the second", f"// flake-quarantine: {OPEN_BEAD}\nit.skip('keeps the second")
        entry = {"desktop/web/src/a.test.ts": {"count": 1, "bead": OPEN_BEAD}}
        code, out = self.judge(skipped, f"test(frontend): quarantine a flake ({OPEN_BEAD})", self.quarantine(entry))
        self.assertEqual(code, 0, out)

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_flake_quarantine_marker_naming_no_bead_or_a_closed_one_is_refused(self):
        for marker, bead in (("// flake-quarantine:", OPEN_BEAD), (f"// flake-quarantine: {CLOSED_BEAD}", CLOSED_BEAD)):
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


if __name__ == "__main__":
    unittest.main()
