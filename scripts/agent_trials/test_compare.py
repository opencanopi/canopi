"""Behaviour of the trial comparison: medians per task over scored runs against the baseline, worse tasks named."""
import json
import tempfile
import unittest
from pathlib import Path

from . import score


def run(task, files=10, read=None, status="scored", **extra):
    record = {"task": task, "status": status}
    if status == "scored":
        record.update({"files_changed": files, "lines_added": 5, "lines_removed": 1, "area_count": 2, "wrong_owner": 0,
                       "owners": {"touched": ["a"], "missed": [], "outside": []}})
        if read is not None:
            record.update({"files_read": read, "tokens": {"total": read * 1000}, "gate_failures": 0})
    record.update(extra)
    return record


class CompareTest(unittest.TestCase):
    def test_medians_per_task_and_each_task_that_got_worse_is_named(self):
        base = [run("t1", 10), run("t1", 12), run("t1", 30), run("t2", 5), run("t2", 5), run("t2", 5)]
        now = [run("t1", 11), run("t1", 9), run("t1", 10), run("t2", 6), run("t2", 7), run("t2", 4)]
        got = score.compare(base, now)
        self.assertEqual(got["tasks"]["t1"]["files_changed"], {"baseline": 12, "current": 10})
        self.assertEqual(got["tasks"]["t2"]["files_changed"], {"baseline": 5, "current": 6})
        self.assertEqual(got["worse"], {"t2": ["files_changed"]})

    def test_unscored_runs_are_left_out_of_every_median(self):
        base = [run("t1", 10), run("t1", 10), run("t1", 10)]
        now = [run("t1", 10), run("t1", 10), run("t1", status="unscored", unscored_reason="usage-limit")]
        got = score.compare(base, now)
        self.assertEqual(got["worse"], {})
        self.assertEqual(got["tasks"]["t1"]["runs"], {"baseline": 3, "current": 2, "unscored": 1})

    def test_an_absent_transcript_metric_is_never_read_as_zero(self):
        base = [run("t1", read=40), run("t1", read=50), run("t1", read=60)]
        now = [run("t1", read=70), run("t1"), run("t1")]
        got = score.compare(base, now)
        self.assertEqual(got["tasks"]["t1"]["files_read"], {"baseline": 50, "current": 70})
        self.assertEqual(got["worse"], {"t1": ["files_read", "tokens"]})
        none = score.compare(base, [run("t1"), run("t1")])
        self.assertNotIn("files_read", none["tasks"]["t1"])
        self.assertEqual(none["worse"], {})

    def test_the_cli_reads_a_baseline_file_and_a_directory_of_run_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            baseline = Path(tmp) / "baseline.json"
            baseline.write_text(json.dumps({"start": "a699e290b", "runs": [run("t1", 10), run("t1", 10), run("t1", 10)]}))
            runs = Path(tmp) / "phase-1"
            (runs / "t1-r1.logs").mkdir(parents=True)
            (runs / "t1-r1.json").write_text(json.dumps(run("t1", 20)))
            self.assertEqual(score.main(["compare", str(baseline), str(runs)]), 1)
            (runs / "t1-r1.json").write_text(json.dumps(run("t1", 10)))
            self.assertEqual(score.main(["compare", str(baseline), str(runs)]), 0)


if __name__ == "__main__":
    unittest.main()
