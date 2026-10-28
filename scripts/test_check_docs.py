from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

from scripts.check_docs import BYTE_BUDGETS, LINE_BUDGETS, PARAGRAPH_EXEMPT, ROOT, anchors, changed_files, check, check_document, check_ledger, check_model, check_models, check_placement, crate_graph, drift, drift_main, lost_decisions, size_warnings
from scripts.check_docs_model import check_layer_diagram
from scripts.check_docs_gates import check_gate_rows, gate_rows
from scripts.check_docs_policy import BaseNotFound, ledger_drift, ledger_rows, ledger_table, missing_ids


# Ids of no ledger are built at runtime, so the repository's own missing-id check never reads them here.
NEXT_RELEASE_ID = "2.2-" + "Q1"
GHOST_ID = "2.1-" + "Q9999"


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
            self.assertEqual(size_warnings(guide, root), [], "the Covers line is outside the byte budget")

    def test_a_deleted_plan_keeps_its_decisions_in_the_ledger_or_an_adr(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
            for name, text in {
                "docs/decisions/2-1.md": "| id | date | implemented by |\n|---|---|---|\n| 2.1-Q7 | 2026-10-16 | x |\n",
                "docs/adr/0012-vegetation.md": "Status: accepted\n",
                "docs/plans/built.md": "Status: agreed\n\n## Decisions\n\n- Caps: 25 M cells (2.1-Q7).\n- Lane: in-process, ADR 0012.\n\n### Detail\n\n- Still a decision (2.1-Q9).\n\n## Sources\n\n- Not a decision.\n",
                "docs/plans/recorded.md": "Status: agreed\n\n## 3. Decisions\n\n1. **Fixtures:** see [ADR](../adr/0012-vegetation.md).\n",
            }.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(text, encoding="utf-8")
            git("init", "-q", "-b", "main")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "base", "--allow-empty")
            git("add", "-A")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "plans")
            git("rm", "-q", "docs/plans/built.md", "docs/plans/recorded.md")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "built")
            self.assertEqual(lost_decisions(root, "HEAD~1"), {"docs/plans/built.md": ["- Still a decision (2.1-Q9)."]})

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
            self.assertIn("docs/workflow.md: 101 lines exceeds its 100-line budget", size_warnings(page, root))
            # A budget warns and never fails: a hard limit made trims drop rules (canopi-f47t.52.214).
            self.assertEqual(check_document(page, root), [])
            page.write_text("# Workflow\n", encoding="utf-8")
            self.assertEqual(check_document(page, root), [])

    def test_byte_and_paragraph_budgets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            guide = root / "docs/guides/editions.md"
            guide.parent.mkdir(parents=True)
            guide.write_text("# Editions\n" + ("short line\n" * 1200), encoding="utf-8")
            self.assertTrue(any("exceeds its 12000-byte budget" in e for e in size_warnings(guide, root)))
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
            self.assertTrue(any("exceeds its 14000-byte budget" in e for e in size_warnings(notes, root)))
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
            ledger.write_text(header + "| 2.1-Q10 | 2026-10-16 | f | ADRs 0026, 0099 and 0098 |\n| 2.1-Q11 | 2026-10-16 | replaces ADR 0097 | ADR 0026 |\n| " + NEXT_RELEASE_ID + " | 2026-10-16 | g | ADR 0026 |\n", encoding="utf-8")
            errors = check_ledger(ledger, root)
            self.assertEqual(len(errors), 4)
            self.assertIn("2.1-Q10 cites ADR 0098, which does not exist", errors[0])
            self.assertIn("2.1-Q10 cites ADR 0099, which does not exist", errors[1])
            self.assertIn("2.1-Q11 cites ADR 0097, which does not exist", errors[2])
            self.assertIn(f"ledger id {NEXT_RELEASE_ID} is not of this file's release 2.1", errors[3])
            ledger.write_text("# 2.1\n\n| id | decision |\n|---|---|\n| 2.1-Q1 | x |\n", encoding="utf-8")
            errors = check_ledger(ledger, root)
            self.assertEqual(len(errors), 1)
            self.assertIn("needs the columns", errors[0])
            ledger.write_text("# 2.1\n\nNo table.\n", encoding="utf-8")
            self.assertIn("needs a table of decisions", check_ledger(ledger, root)[0])

    def test_canopi_f47t_52_228_10_ledger_table_is_the_one_row_reader(self):
        """check_ledger and, through ledger_rows, the commit gate's Q-row lookup read rows through ledger_table (design-check:528)."""
        text = ("# L\n\n| id | date | decision | implemented by |\n|---|---|---|---|\n| 2.1-Q1 | 2026-10-16 | A. | plan |\n"
                "\n```\n| 2.1-Q9 | fenced | x | y |\n```\n\n| other | table |\n|---|---|\n| a | b |\n")
        rows = list(ledger_table(text))
        self.assertEqual(rows[0], (5, ["id", "date", "decision", "implemented by"], ["2.1-Q1", "2026-10-16", "A.", "plan"]))
        self.assertEqual(rows[1], (11, ["other", "table"], None), "a table without the ledger columns is named once")
        self.assertEqual(len(rows), 2, "fenced rows and the rows of a table without the columns are not read")

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

    def test_the_crate_graph_resolves_workspace_inherited_path_dependencies(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for rel, text in {
                "Cargo.toml": '[workspace]\nmembers = ["app", "core"]\n\n[workspace.dependencies]\ncore = { path = "core" }\n',
                "app/Cargo.toml": '[package]\nname = "canopi-app"\n\n[dependencies]\ncore = { workspace = true }\n',
                "core/Cargo.toml": '[package]\nname = "canopi-core"\n',
            }.items():
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text(text, encoding="utf-8")
            self.assertEqual(crate_graph(root), ({"app": "canopi-app", "core": "canopi-core"}, {("canopi-app", "canopi-core")}))

    def test_crates_and_backticked_paths_outside_diagrams(self):
        errors = self.errors("Owned by `app/session/` and `app/later/` (2.1); `app/lost/` owns nothing.\n\nModel: target\n```mermaid\nflowchart LR\n  a[canopi-core] --> b[canopi-future]\n```\n")
        self.assertEqual(len(errors), 2)
        self.assertIn("app/lost/ is not in the code", errors[0])
        self.assertIn("crate canopi-future is not in the workspace", errors[1])


LEDGER_HEADER = "# 2.1\n\n| id | date | decision | user's words | supersedes / superseded by | implemented by |\n|---|---|---|---|---|---|\n"
LEDGER_BASE = {
    "2.1-Q1": "| 2.1-Q1 | 2026-10-16 | One table. | \"yes, one\" |  | ADR 0026 |",
    "2.1-Q2": "| 2.1-Q2 | 2026-10-16 | Two lanes. |  | extends 2.1-Q1 and M3 | ADR 0026, ADR 0022; plan F1b |",
    "2.1-M3": "| 2.1-M3 | 2026-10-17 | Three rows. |  |  | ADRs 0022 and 0026 |",
}


def git_repo(root, files):
    """A repository at `root` with `files` committed as its first commit; returns its git runner."""
    def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=root, check=True, capture_output=True)
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text, encoding="utf-8")
    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-qm", "base")
    return git


class LedgerDriftChecks(unittest.TestCase):
    """2.1-M194: --drift holds every ledger row of the base, matched by id."""

    def drift_errors(self, rows):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            git = git_repo(root, {"docs/decisions/2-1.md": LEDGER_HEADER + "\n".join(LEDGER_BASE.values()) + "\n"})
            (root / "docs/decisions/2-1.md").write_text(LEDGER_HEADER + "\n".join(rows) + "\n", encoding="utf-8")
            git("commit", "-qam", "head", "--allow-empty")
            return ledger_drift(root, "HEAD~1")

    def edited(self, ident, old, new):
        return [row.replace(old, new) if key == ident else row for key, row in LEDGER_BASE.items()]

    def test_an_unchanged_or_appended_ledger_passes(self):
        self.assertEqual(self.drift_errors(list(LEDGER_BASE.values())), [])
        self.assertEqual(self.drift_errors([*LEDGER_BASE.values(), "| 2.1-Q4 | 2026-10-18 | Four. |  |  | ADR 0026 |"]), [])
        # Re-padding a table is no edit.
        self.assertEqual(self.drift_errors([row.replace(" | ", "  |  ") for row in LEDGER_BASE.values()]), [])

    def test_a_deleted_row_fails(self):
        errors = self.drift_errors([LEDGER_BASE["2.1-Q2"], LEDGER_BASE["2.1-M3"]])
        self.assertEqual(len(errors), 1)
        self.assertIn("2.1-Q1", errors[0])
        self.assertIn("deleted", errors[0])

    def test_an_edited_id_fails_as_a_deleted_row(self):
        errors = self.drift_errors(self.edited("2.1-Q1", "2.1-Q1", "2.1-Q5"))
        self.assertEqual(len(errors), 1)
        self.assertIn("2.1-Q1", errors[0])

    def test_an_edited_date_decision_or_words_fails(self):
        for old, new, column in (("2026-10-16", "2026-10-15", "date"), ("One table.", "One table, two.", "decision"), ('"yes, one"', '"yes"', "user's words")):
            with self.subTest(column=column):
                errors = self.drift_errors(self.edited("2.1-Q1", old, new))
                self.assertEqual(len(errors), 1)
                self.assertIn(f"2.1-Q1 {column} cell was edited", errors[0])

    def test_citing_cells_may_grow_and_rejoin_but_keep_every_cited_id_and_adr(self):
        regrown = self.edited("2.1-Q2", "extends 2.1-Q1 and M3 | ADR 0026, ADR 0022; plan F1b", "extends M3, 2.1-Q1; extended by 2.1-Q5 | plan F1b; ADRs 0022, 0026 and 0030")
        self.assertEqual(self.drift_errors(regrown), [])
        lost = self.edited("2.1-Q2", "extends 2.1-Q1 and M3 | ADR 0026, ADR 0022; plan F1b", "extends M3 | ADR 0026; plan Phase 0")
        errors = self.drift_errors(lost)
        self.assertEqual(len(errors), 2)
        self.assertIn("2.1-Q2 supersedes / superseded by no longer cites 2.1-Q1", errors[0])
        self.assertIn("2.1-Q2 implemented by no longer cites ADR 0022", errors[1])

    def test_a_base_that_does_not_resolve_fails_loudly(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            git_repo(root, {"docs/decisions/2-1.md": LEDGER_HEADER + "\n".join(LEDGER_BASE.values()) + "\n"})
            for check in (ledger_drift, lost_decisions, changed_files):
                with self.subTest(check=check.__name__), self.assertRaisesRegex(BaseNotFound, "^base origin/gone not found$"):
                    check(root, "origin/gone")
            with redirect_stderr(StringIO()) as stderr, redirect_stdout(StringIO()):
                self.assertEqual(drift_main(root, "origin/gone"), 1)
            self.assertEqual(stderr.getvalue(), "base origin/gone not found\n")

    def test_ledger_rows_reads_each_row_by_id(self):
        rows = ledger_rows(LEDGER_HEADER + "\n".join(LEDGER_BASE.values()) + "\n")
        self.assertEqual(list(rows), ["2.1-Q1", "2.1-Q2", "2.1-M3"])
        self.assertEqual(rows["2.1-Q2"]["supersedes / superseded by"], "extends 2.1-Q1 and M3")


class MissingIdChecks(unittest.TestCase):
    """DR22: a full id anywhere in the tracked text, or a short id inside a ledger row, names a ledger row."""

    def test_full_ids_everywhere_and_short_ids_only_inside_ledger_rows(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = LEDGER_HEADER + "| 2.1-Q1 | 2026-10-16 | One. |  |  | ADR 0026 |\n| 2.1-M2 | 2026-10-16 | Refines Q1, Q8 and E3; contract F3, R2. |  | after 2.1-Q1 | plan F1b |\n\nProse outside rows: Q77.\n"
            git_repo(root, {
                "docs/decisions/2-1.md": ledger,
                "notes.md": f"Per 2.1-Q1 and {GHOST_ID}.\nNext: {NEXT_RELEASE_ID}.\nContract M0, F1-F39, R22, Q7 and v12.1-Q3 are not ledger ids.\n",
                "src/a.ts": "// 2.1-M2, 2.1-Q35r\n",
            })
            (root / "blob.bin").write_bytes(b"\x00" + GHOST_ID.encode())
            (root / "untracked.md").write_text(GHOST_ID, encoding="utf-8")
            subprocess.run(["git", "add", "blob.bin"], cwd=root, check=True)
            self.assertEqual(missing_ids(root), [
                "docs/decisions/2-1.md:6: Q8 (2.1-Q8) is in no decision ledger",
                "docs/decisions/2-1.md:6: E3 (2.1-E3) is in no decision ledger",
                f"notes.md:1: {GHOST_ID} is in no decision ledger",
                f"notes.md:2: {NEXT_RELEASE_ID} is in no decision ledger",
                "src/a.ts:1: 2.1-Q35r is in no decision ledger",
            ])
            errors = check(root)
            self.assertIn(f"notes.md:1: {GHOST_ID} is in no decision ledger", errors, "the default check runs it")
            self.assertIn("policy/suites.json: missing; the contract-suite registry (2.1-M193)", errors, "and the suite registry check")
            self.assertIn("policy/check.mjs --list-rules exited 1: the rule registry is unreadable, so no inventory or rule-id check ran", errors, "and the inventory and rule-id checks")


LAYER_TABLE = {
    "version": 1,
    "layers": [
        {"path": "utils/", "layer": "L0", "edition": "both"},
        {"path": "geo/", "layer": "L0", "status": "new", "phase": "2a", "edition": "both"},
        {"path": "ipc/", "layer": "L1", "rank": 1, "edition": "desktop"},
        {"path": "platform/", "layer": "L1", "rank": 2, "edition": "both"},
        {"path": "app/", "layer": "L3", "edition": "both"},
        {"path": "app/settings/", "layer": "L2", "rank": 1, "edition": "both", "owner": "settings"},
        {"path": "app/lidar/", "layer": "L3", "destination": "app/data-library/", "phase": "2a", "edition": "desktop"},
        {"path": "maplibre/", "layer": "L1", "rank": 2, "edition": "both"},
        {"path": "maplibre/worker.ts", "layer": "L1", "rank": 2, "edition": "desktop", "entry": True},
    ],
}
LAYER_DIAGRAM = """Model: target

```mermaid
flowchart TB
  subgraph L3["L3 features"]
    feat["other app/ features"]
    dlib["app/data-library/ (2.1)"]:::target
  end
  subgraph L2["L2 runtimes"]
    set["1 app/settings/, owner settings"]
  end
  subgraph L1["L1 adapters"]
    ipc["1 ipc/"]
    ml["2 maplibre/"]
    plat["2 platform/"]
  end
  subgraph L0["L0 pure"]
    utils["utils/"]
    geo["geo/ (2.1)"]:::target
  end
  L3 --> L2
```
"""


class LayerDiagramChecks(unittest.TestCase):
    """The components diagram's layers, ranks, owners and (2.1) marks equal policy/layers.json (2.1-M192, ADR 0028)."""

    def errors(self, body, table=LAYER_TABLE):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/architecture").mkdir(parents=True)
            page = root / "docs/architecture/components.md"
            page.write_text(body, encoding="utf-8")
            if table is not None:
                (root / "policy").mkdir()
                (root / "policy/layers.json").write_text(json.dumps(table), encoding="utf-8")
            return check_layer_diagram(page, root)

    def test_a_diagram_equal_to_the_table_passes(self):
        self.assertEqual(self.errors(LAYER_DIAGRAM), [])

    def test_a_page_without_the_layer_diagram_is_not_checked(self):
        self.assertEqual(self.errors("Model: current\n```mermaid\nflowchart LR\n  a --> b\n```\n", table=None), [])

    def test_a_layer_or_rank_unequal_to_the_table_fails(self):
        errors = self.errors(LAYER_DIAGRAM.replace('plat["2 platform/"]', 'plat["1 platform/"]').replace('    utils["utils/"]\n', "").replace('feat["other app/ features"]', 'feat["other app/ features"]\n    utils["utils/"]'))
        self.assertEqual(len(errors), 2, errors)
        self.assertIn("utils/ is L0 in policy/layers.json, drawn in L3", errors[0])
        self.assertIn("platform/ has rank 2 in policy/layers.json, drawn 1", errors[1])

    def test_a_ranked_or_new_row_left_undrawn_fails(self):
        errors = self.errors(LAYER_DIAGRAM.replace('    ipc["1 ipc/"]\n', ""))
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("ipc/ (L1, rank 1) is in policy/layers.json but not drawn", errors[0])

    def test_marks_follow_the_table(self):
        errors = self.errors(LAYER_DIAGRAM.replace('utils["utils/"]', 'utils["utils/ (2.1)"]').replace('geo["geo/ (2.1)"]', 'geo["geo/"]'))
        self.assertEqual(len(errors), 2, errors)
        self.assertIn("utils/ is built in policy/layers.json; drop (2.1)", errors[0])
        self.assertIn("geo/ is new in policy/layers.json; mark it (2.1)", errors[1])

    def test_owners_and_unknown_paths_fail(self):
        errors = self.errors(LAYER_DIAGRAM.replace("owner settings", "owner Scene").replace('dlib["app/data-library/ (2.1)"]', 'dlib["app/elsewhere/ (2.1)"]'))
        self.assertEqual(len(errors), 2, errors)
        self.assertIn("app/elsewhere/ is no row or destination of policy/layers.json", errors[0])
        self.assertIn("app/settings/ is owned by settings in policy/layers.json, drawn Scene", errors[1])

    def test_an_owner_left_out_fails(self):
        errors = self.errors(LAYER_DIAGRAM.replace(", owner settings", ""))
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("app/settings/ is owned by settings in policy/layers.json, drawn no one", errors[0])

    def test_a_layer_diagram_without_the_table_fails(self):
        self.assertIn("policy/layers.json is missing", self.errors(LAYER_DIAGRAM, table=None)[0])

    def test_the_docs_check_runs_the_layer_check(self):
        with TemporaryDirectory() as directory:
            root = model_root(directory)
            (root / "docs/architecture/components.md").write_text(LAYER_DIAGRAM, encoding="utf-8")
            self.assertTrue(any("policy/layers.json is missing" in error for error in check_models(root)))


def load_tests(loader, tests, pattern):
    """The Docs gate and the CI docs job name this module only; the policy-table tests (scripts/test_check_docs_policy.py,
    moved out to stay under 600 lines, 2.1-Q243) run with it, so no gate line can leave them out."""
    from scripts import test_check_docs_policy
    tests.addTests(loader.loadTestsFromModule(test_check_docs_policy))
    return tests


if __name__ == "__main__":
    unittest.main()


class GateRowChecks(unittest.TestCase):
    def test_canopi_f47t_52_228_10_agents_gate_rows_that_drift_from_gate_py_fail(self):
        """F3b c3 (2.1-M198): AGENTS.md's Quality gates rows and scripts/gate.py's table name the same checks."""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "scripts").mkdir()
            shutil.copy(ROOT / "scripts/gate.py", root / "scripts/gate.py")
            agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
            row = next(line for line in agents.splitlines() if line.startswith("| Frontend |"))
            (root / "AGENTS.md").write_text(agents.replace(row, row[:-1] + "&& `npm run made-up-check` |"), encoding="utf-8")
            errors = check(root)
            self.assertTrue(any("gate.py" in e and "made-up-check" in e for e in errors), errors)

    def test_canopi_f47t_52_228_10_rows_equal_to_gate_py_pass_and_a_missing_side_fails(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "scripts").mkdir()
            shutil.copy(ROOT / "scripts/gate.py", root / "scripts/gate.py")
            rows = "\n".join(f"| {label} | {run} |" for label, run in gate_rows(root))
            (root / "AGENTS.md").write_text(f"# A\n\n## Quality gates\n\n| Change | Run |\n|---|---|\n{rows}\n\nAfter.\n",
                                            encoding="utf-8")
            self.assertEqual(check_gate_rows(root), [])
            self.assertEqual([e for e in check(root) if "gate.py" in e], [])
            (root / "scripts/gate.py").unlink()
            self.assertIn("scripts/gate.py is missing", check_gate_rows(root)[0])
            (root / "AGENTS.md").write_text("# A\n\nNo gates.\n", encoding="utf-8")
            self.assertEqual(check_gate_rows(root), [])

