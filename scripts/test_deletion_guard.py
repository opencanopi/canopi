"""The test-deletion guard (scripts/deletion_guard.py through commit_gate.py; 2.1-Q224, 2.1-M199; canopi-f47t.52.228.10).

Chunk 2's user paths (plan:157), expected failures until c2 builds them: a commit range judged by `commit_gate.py pr`.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.test_commit_gate import GateRepo

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

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_deleted_test_with_no_route_is_refused(self):
        code, out = self.judge(KEPT.split("it('keeps the second")[0], "test(frontend): drop one")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-deleted", out)

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_reworded_title_without_rewords_test_is_refused(self):
        code, out = self.judge(KEPT.replace("keeps the second behaviour", "keeps behaviour two"), "test(frontend): reword")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-reworded", out)

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_reworded_title_with_rewords_test_passes(self):
        code, out = self.judge(KEPT.replace("keeps the second behaviour", "keeps behaviour two"),
                               "test(frontend): reword\n\nRewords-test: keeps the second behaviour -> keeps behaviour two")
        self.assertEqual(code, 0, out)

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_removed_expect_in_a_kept_test_is_refused(self):
        code, out = self.judge(KEPT.replace("  expect(2).toBe(2)\n", ""), "test(frontend): fewer asserts")
        self.assertEqual(code, 1, out)
        self.assertIn("gate-test-loosened", out)

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_moved_test_passes(self):
        second = "import { expect, it } from 'vitest'\n\n" + "it('keeps the second" + KEPT.split("it('keeps the second")[1]
        code, out = self.judge(KEPT.split("it('keeps the second")[0], "test(frontend): move",
                               {"desktop/web/src/b.test.ts": second})
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
