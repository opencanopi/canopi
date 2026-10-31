import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import change_coupling as cc


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args], check=True, capture_output=True)


def commit(repo: Path, files: dict[str, str], message: str) -> None:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        git(repo, "add", name)
    git(repo, "commit", "-q", "-m", message)


class AreaTest(unittest.TestCase):
    def test_areas_name_the_owning_folder(self) -> None:
        self.assertEqual(cc.area("desktop/web/src/app/lidar/profile.ts"), "web/app/lidar")
        self.assertEqual(cc.area("desktop/web/src/canvas/runtime/tools/tool-host.ts"), "web/canvas/runtime")
        self.assertEqual(cc.area("desktop/web/src/maplibre/site-overlay.ts"), "web/maplibre")
        self.assertEqual(cc.area("desktop/src/services/lidar/mod.rs"), "desktop/services/lidar")
        self.assertEqual(cc.area("desktop/src/lib.rs"), "desktop")
        self.assertEqual(cc.area("common-types/src/lidar.rs"), "common-types")
        self.assertEqual(cc.area("desktop/web/ui-gallery/main.tsx"), "web-tooling/ui-gallery")
        self.assertEqual(cc.area("desktop/web/vite.config.ts"), "web-tooling")
        self.assertEqual(cc.area("desktop/build.rs"), "desktop-root")

    def test_a_folder_and_its_subfolder_are_one_area_for_pairing(self) -> None:
        self.assertTrue(cc.nested("web/canvas", "web/canvas/runtime"))
        self.assertFalse(cc.nested("web/canvas", "web/canvas-map"))

    def test_docs_tests_locales_and_generated_files_are_not_counted(self) -> None:
        for path in (
            "docs/plans/canvas-v2-plan.md",
            ".beads/issues.jsonl",
            "desktop/web/src/i18n/locales/fr.json",
            "desktop/web/src/app/lidar/profile.test.ts",
            "desktop/web/src/generated/contracts.ts",
            "desktop/src/services/lidar/fixed_library_tests.rs",
            "desktop/web/e2e/gallery/profile.spec.ts",
            "desktop/web/package-lock.json",
        ):
            self.assertFalse(cc.counted(path), path)
        for path in ("desktop/web/src/app/lidar/profile.ts", "common-types/analysis-registry.json", "desktop/web/src/styles/global.css"):
            self.assertTrue(cc.counted(path), path)

    def test_policy_data_a_code_change_produces_is_not_counted(self) -> None:
        # Ratchet baselines, planted violations and scenarios follow the code they record, like snapshots.
        for path in ("policy/ratchets/knip.json", "policy/fixtures/rules/knip/src/lib.ts", "policy/scenarios/session.json"):
            self.assertFalse(cc.counted(path), path)
        for path in ("policy/check.mjs", "policy/adapters/knip.mjs", "policy/layers.json"):
            self.assertTrue(cc.counted(path), path)


class CouplingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        a, b = "desktop/web/src/app/lidar/a.ts", "desktop/web/src/maplibre/b.ts"
        c = "desktop/web/src/app/lidar/c.ts"
        for i in range(3):
            commit(self.repo, {a: f"a{i}\n", b: f"b{i}\n" * 50}, f"together {i}")
        git(self.repo, "tag", "after-together")
        commit(self.repo, {a: "a-alone\n"}, "a alone")
        commit(self.repo, {a: "a-c\n", c: "c0\n"}, "a with c, one area")
        commit(self.repo, {c: "c\n", "docs/x.md": "d\n"}, "c with docs")
        commit(self.repo, {f"desktop/web/src/app/x/f{i}.ts": "x\n" for i in range(5)}, "mass edit")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_files_changed_together_across_areas_are_reported_with_their_degree(self) -> None:
        report = cc.analyse(self.repo, since=None, max_files=4)
        pair = report.pairs[0]
        self.assertEqual((pair.a, pair.b), ("desktop/web/src/app/lidar/a.ts", "desktop/web/src/maplibre/b.ts"))
        self.assertEqual(pair.shared, 3)
        self.assertAlmostEqual(pair.degree, 1.0)  # b never changed without a
        self.assertEqual(report.area_pairs[("web/app/lidar", "web/maplibre")], 3)

    def test_mass_edits_are_skipped_and_counted(self) -> None:
        report = cc.analyse(self.repo, since=None, max_files=4)
        self.assertEqual(report.skipped, 1)
        self.assertFalse(any("app/x/" in p.a or "app/x/" in p.b for p in report.pairs))

    def test_hotspots_rank_changes_times_size(self) -> None:
        report = cc.analyse(self.repo, since=None, max_files=4)
        # a changed 5 times but has 1 line; b changed 3 times with 50 lines.
        self.assertEqual([h[0] for h in report.hotspots[:2]], ["desktop/web/src/maplibre/b.ts", "desktop/web/src/app/lidar/a.ts"])
        hotspots = cc.render(report, top=10).split("## Hotspots")[1]
        self.assertLess(hotspots.index("maplibre/b.ts"), hotspots.index("lidar/a.ts"))

    def test_files_in_one_area_never_pair(self) -> None:
        report = cc.analyse(self.repo, since=None, max_files=4)
        self.assertFalse(any({p.a, p.b} == {"desktop/web/src/app/lidar/a.ts", "desktop/web/src/app/lidar/c.ts"} for p in report.pairs))

    def test_since_takes_a_ref_or_a_date(self) -> None:
        self.assertEqual(cc.analyse(self.repo, since="after-together", max_files=4).commits, 3)
        self.assertEqual(cc.analyse(self.repo, since="2000-01-01", max_files=4).commits, 6)

    def test_merge_commits_are_not_counted(self) -> None:
        git(self.repo, "checkout", "-q", "-b", "side", "after-together")
        commit(self.repo, {"desktop/web/src/maplibre/d.ts": "d\n"}, "side")
        git(self.repo, "checkout", "-q", "-")
        git(self.repo, "merge", "-q", "--no-ff", "-m", "merge side", "side")
        self.assertEqual(cc.analyse(self.repo, since=None, max_files=4).commits, 7)

    def test_the_report_is_markdown_with_its_three_tables(self) -> None:
        text = cc.render(cc.analyse(self.repo, since=None, max_files=4), top=10)
        for heading in ("## Files that change together across areas", "## Areas that change together", "## Hotspots"):
            self.assertIn(heading, text)


if __name__ == "__main__":
    unittest.main()
