from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.check_docs import BYTE_BUDGETS, LINE_BUDGETS, PARAGRAPH_EXEMPT, ROOT, anchors, check_document, check_ledger, check_model, check_placement, drift


class DocumentationChecks(unittest.TestCase):
    def test_canopi_s25y_guides_name_the_code_they_cover(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src/canvas").mkdir(parents=True)
            (root / "src/canvas/a.ts").write_text("", encoding="utf-8")
            guide = root / "docs/guides/map.md"
            guide.parent.mkdir(parents=True)
            guide.write_text("# Map\n\n## Purpose\n", encoding="utf-8")
            self.assertIn("needs a `Covers:` line", check_document(guide, root)[0])
            guide.write_text("# Map\n\nCovers: `src/canvas/`, `src/canvas/a.ts`\n", encoding="utf-8")
            self.assertEqual(check_document(guide, root), [])
            guide.write_text("# Map\n\nCovers: `src/gone/`, `src/canvas`\n", encoding="utf-8")
            self.assertEqual(check_document(guide, root), [
                "docs/guides/map.md: covers missing path src/gone/",
                "docs/guides/map.md: covers missing path src/canvas",
            ])
            guide.write_text("# Map\n\nCovers: none\n" + "x\n" * 5996, encoding="utf-8")
            self.assertEqual(check_document(guide, root), [], "the Covers line is outside the byte budget")

    def test_canopi_s25y_drift_names_the_most_specific_unchanged_guide(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/guides").mkdir(parents=True)
            (root / "docs/guides/frontend.md").write_text("# F\n\nCovers: `src/`\n", encoding="utf-8")
            (root / "docs/guides/map.md").write_text("# M\n\nCovers: `src/canvas/`\n", encoding="utf-8")
            (root / "docs/guides/glossary.md").write_text("# G\n\nCovers: none\n", encoding="utf-8")
            changed = {"src/canvas/a.ts", "src/canvas/a.test.ts", "src/shell.ts", "README.md"}
            self.assertEqual(drift(root, changed), {"docs/guides/map.md": ["src/canvas/a.ts"], "docs/guides/frontend.md": ["src/shell.ts"]})
            # A guide changed in the same branch was reread; tests alone never ask for a reread.
            self.assertEqual(drift(root, changed | {"docs/guides/map.md"}), {"docs/guides/frontend.md": ["src/shell.ts"]})
            self.assertEqual(drift(root, {"src/canvas/a.test.ts"}), {})

    def test_local_links_fragments_and_code_examples(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "other.md").write_text("# Valid heading\n# Valid heading\n", encoding="utf-8")
            page = root / "README.md"
            page.write_text('[ok](other.md#valid-heading-1)\n[bad](missing.md)\n[bad heading](other.md#absent)\n[remote](https://example.org)\n`[example](ignored.md)`\n```md\n[example](ignored.md)\n```\n[ref]: other.md#valid-heading\n', encoding="utf-8")
            errors = check_document(page, root)
            self.assertEqual(len(errors), 2)
            self.assertIn("missing target missing.md", errors[0])
            self.assertIn("missing heading other.md#absent", errors[1])

    def test_docs_outside_the_v2_layout_are_refused(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("docs/README.md", "docs/decisions/2-1.md", "docs/guides/frontend.md", "docs/adr/0001-x.md", "docs/release-notes/v2.0.0.md", "docs/plans/hydrology.md", "docs/review-checklist.md", "docs/design/plan.md", "docs/evidence.md"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("# Doc\n", encoding="utf-8")
            errors = check_placement(root)
            self.assertEqual(len(errors), 2)
            self.assertIn("docs/design/plan.md", errors[0])
            self.assertIn("docs/evidence.md", errors[1])

    def test_line_budgets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / "docs/workflow.md"
            page.parent.mkdir(parents=True)
            page.write_text("# Workflow\n" + "line\n" * 100, encoding="utf-8")
            self.assertIn("docs/workflow.md: 101 lines exceeds its 100-line budget", check_document(page, root))
            page.write_text("# Workflow\n", encoding="utf-8")
            self.assertEqual(check_document(page, root), [])

    def test_byte_and_paragraph_budgets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            guide = root / "docs/guides/editions.md"
            guide.parent.mkdir(parents=True)
            guide.write_text("# Editions\n" + ("short line\n" * 1200), encoding="utf-8")
            self.assertTrue(any("exceeds its 12000-byte budget" in e for e in check_document(guide, root)))
            guide.write_text("# Editions\n\nCovers: none\n" + "x" * 601 + "\n| " + "y" * 700 + " |\n", encoding="utf-8")
            errors = check_document(guide, root)
            self.assertEqual(len(errors), 1)
            self.assertIn("paragraph of 601 characters exceeds 600", errors[0])
            plan = root / "docs/plans/hydrology.md"
            plan.parent.mkdir(parents=True)
            plan.write_text("# Plan\n" + "z" * 600 + "\n", encoding="utf-8")
            self.assertEqual(check_document(plan, root), ["docs/plans/hydrology.md: a plan needs a `Status:` line (proposed, agreed, in progress)"])
            plan.write_text("# Plan\n\nStatus: agreed\n" + "z" * 600 + "\n", encoding="utf-8")
            self.assertEqual(check_document(plan, root), [])

    def test_named_byte_budgets_and_the_legacy_plan_exemption(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            notes = root / "docs/release-notes/v2.0.0.md"
            notes.parent.mkdir(parents=True)
            notes.write_text("# 2.0\n" + ("short line\n" * 1300), encoding="utf-8")
            self.assertTrue(any("exceeds its 14000-byte budget" in e for e in check_document(notes, root)))
            # The paragraph budget applies to plans, except the legacy files named in PARAGRAPH_EXEMPT.
            other = root / "docs/plans/hydrology.md"
            other.parent.mkdir(parents=True)
            other.write_text("Status: agreed\n" + "z" * 601 + "\n", encoding="utf-8")
            self.assertEqual(check_document(other, root), ["docs/plans/hydrology.md:2: paragraph of 601 characters exceeds 600"])
            legacy = root / "docs/plans/onf-plugin-adaptation.md"
            legacy.write_text("Status: in progress\n" + "z" * 900 + "\n", encoding="utf-8")
            self.assertEqual(check_document(legacy, root), [])

    def test_every_named_budget_and_exemption_exists(self):
        # A deleted document takes its budget and exemption entries with it.
        for name in list(LINE_BUDGETS) + list(BYTE_BUDGETS) + list(PARAGRAPH_EXEMPT):
            self.assertTrue((ROOT / name).exists(), name)

    def test_decision_ledger_rows_need_an_id_a_date_and_an_existing_implementation(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/adr").mkdir(parents=True)
            (root / "docs/adr/0026-stored-data.md").write_text("Status: Accepted\n", encoding="utf-8")
            ledger = root / "docs/decisions/2-1.md"
            ledger.parent.mkdir(parents=True)
            header = "# 2.1\n\n| id | date | decision | implemented by |\n|---|---|---|---|\n"
            ledger.write_text(header + "| 2.1-Q6 | 2026-10-16 | chained steps | ADR 0026 one rule |\n| 2.1-Q35r | 2026-10-17 | backup copy | ADR 0026 |\n", encoding="utf-8")
            self.assertEqual(check_ledger(ledger, root), [])
            ledger.write_text(header + "| Q6 | 2026-10-16 | a | ADR 0026 |\n| 2.1-Q7 | soon | b | ADR 0026 |\n| 2.1-Q8 | 2026-10-16 | c |  |\n| 2.1-Q9 | 2026-10-16 | d | ADR 0099 |\n| 2.1-Q9 | 2026-10-16 | e | ADR 0026 |\n", encoding="utf-8")
            errors = check_ledger(ledger, root)
            self.assertEqual(len(errors), 5)
            self.assertIn("ledger id 'Q6'", errors[0])
            self.assertIn("2.1-Q7 has no YYYY-MM-DD date", errors[1])
            self.assertIn("2.1-Q8 names no implementation", errors[2])
            self.assertIn("cites ADR 0099, which does not exist", errors[3])
            self.assertIn("duplicate ledger id 2.1-Q9", errors[4])
            ledger.write_text(header + "| 2.1-Q10 | 2026-10-16 | f | ADRs 0026, 0099 and 0098 |\n| 2.1-Q11 | 2026-10-16 | replaces ADR 0097 | ADR 0026 |\n| 2.2-Q1 | 2026-10-16 | g | ADR 0026 |\n", encoding="utf-8")
            errors = check_ledger(ledger, root)
            self.assertEqual(len(errors), 4)
            self.assertIn("2.1-Q10 cites ADR 0098, which does not exist", errors[0])
            self.assertIn("2.1-Q10 cites ADR 0099, which does not exist", errors[1])
            self.assertIn("2.1-Q11 cites ADR 0097, which does not exist", errors[2])
            self.assertIn("ledger id 2.2-Q1 is not of this file's release 2.1", errors[3])
            ledger.write_text("# 2.1\n\n| id | decision |\n|---|---|\n| 2.1-Q1 | x |\n", encoding="utf-8")
            errors = check_ledger(ledger, root)
            self.assertEqual(len(errors), 1)
            self.assertIn("needs the columns", errors[0])
            ledger.write_text("# 2.1\n\nNo table.\n", encoding="utf-8")
            self.assertIn("needs a table of decisions", check_ledger(ledger, root)[0])

    def test_superseded_adr_requires_existing_replacement(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / "docs/adr/old.md"
            page.parent.mkdir(parents=True)
            page.write_text('---\nstatus: superseded\nsuperseded_by: missing.md\n---\n', encoding="utf-8")
            self.assertEqual(len(check_document(page, root)), 1)

    def test_heading_code_fences_and_unicode(self):
        self.assertEqual(anchors('# Café `owner`\n~~~\n# ignored\n~~~\n'), {'café-owner'})


def model_root(directory):
    root = Path(directory)
    files = {
        "Cargo.toml": '[workspace]\nmembers = ["core", "app"]\n',
        "core/Cargo.toml": '[package]\nname = "canopi-core"\n',
        "app/Cargo.toml": '[package]\nname = "canopi-app"\n[dependencies]\ncanopi-core = { path = "../core" }\n',
        "desktop/src/jobs.rs": "pub enum JobState {\n    Queued,\n    Running { progress: u8 },\n    #[serde(rename = \"done\")]\n    Done(Outcome),\n}\npub struct Job { state: JobState }\n",
        "desktop/web/src/app/session/state.ts": "export type SessionState = 'idle' | 'open';\n",
    }
    for name, content in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(content, encoding="utf-8")
    (root / "docs/architecture").mkdir(parents=True)
    return root


class ArchitectureModelChecks(unittest.TestCase):
    def errors(self, body):
        with TemporaryDirectory() as directory:
            root = model_root(directory)
            page = root / "docs/architecture/model.md"
            page.write_text(body, encoding="utf-8")
            return check_model(page, root)

    def test_every_diagram_says_current_or_target(self):
        self.assertIn("needs a 'Model: current' or 'Model: target' line", self.errors("```mermaid\nflowchart LR\n  a --> b\n```\n")[0])

    def test_paths_must_exist_unless_marked_and_marks_drop_once_built(self):
        errors = self.errors('Model: target\n\n```mermaid\nflowchart LR\n  a["app/session/state.ts"] --> b["app/missing/ (2.1)"]\n  c["app/gone/"]\n  d["desktop/src/jobs.rs (2.1)"]\n```\n')
        self.assertEqual(len(errors), 2)
        self.assertIn("app/gone/ is not in the code", errors[0])
        self.assertIn("desktop/src/jobs.rs is built; drop (2.1)", errors[1])

    def test_a_current_diagram_draws_only_what_is_built(self):
        errors = self.errors('Model: current\n```mermaid\nflowchart LR\n  a["app/next/ (2.1)"]\n```\n')
        self.assertIn("a current diagram carries (2.1)", errors[0])

    def test_class_names_are_real_types_or_annotated(self):
        errors = self.errors("Model: target\n```mermaid\nclassDiagram\n  class Job\n  Job --> Ledger\n  class Plan {\n    <<2.1>>\n  }\n  <<2.1>> JobState\n```\n")
        self.assertEqual(errors, [errors[0], errors[1]])
        self.assertIn("type JobState is built; drop <<2.1>>", errors[0])
        self.assertIn("type Ledger is not in the code", errors[1])

    def test_state_diagrams_match_their_enum_both_ways(self):
        good = "Model: current\nEnum: jobs.rs::JobState\n```mermaid\nstateDiagram-v2\n  [*] --> Queued\n  Queued --> Running\n  Running --> Done\n```\n"
        self.assertEqual(self.errors(good), [])
        errors = self.errors("Model: current\nEnum: app/session/state.ts::SessionState\n```mermaid\nstateDiagram-v2\n  [*] --> idle\n  idle --> closing\n```\n")
        self.assertEqual(len(errors), 2)
        self.assertIn("state closing is not a member", errors[0])
        self.assertIn("member open is not drawn", errors[1])
        self.assertIn("names no enum", self.errors("Model: target\nEnum: jobs.rs::Missing\n```mermaid\nstateDiagram-v2\n  [*] --> a\n```\n")[0])
        self.assertEqual(self.errors("Model: target\nEnum: Missing (2.1)\n```mermaid\nstateDiagram-v2\n  [*] --> a\n```\n"), [])

    def test_a_current_crate_graph_matches_cargo(self):
        page = "Model: current\nGraph: cargo\n```mermaid\nflowchart LR\n  canopi-app --> canopi-core\n```\n"
        self.assertEqual(self.errors(page), [])
        errors = self.errors(page.replace("canopi-app --> canopi-core", "canopi-core --> canopi-app"))
        self.assertEqual(len(errors), 2)

    def test_crates_and_backticked_paths_outside_diagrams(self):
        errors = self.errors("Owned by `app/session/` and `app/later/` (2.1); `app/lost/` owns nothing.\n\nModel: target\n```mermaid\nflowchart LR\n  a[canopi-core] --> b[canopi-future]\n```\n")
        self.assertEqual(len(errors), 2)
        self.assertIn("app/lost/ is not in the code", errors[0])
        self.assertIn("crate canopi-future is not in the workspace", errors[1])


if __name__ == "__main__":
    unittest.main()
