"""The docs gate's classDiagram field check (scripts/check_docs_fields.py; 2.1-M165, 2.1-M192, ADR 0028 Diagrams), moved
out of scripts/test_check_docs.py to stay under 600 lines (2.1-Q243); that module's load_tests runs these too."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.check_docs import check_models
from scripts.check_docs_fields import check_class_fields
from scripts.test_check_docs import model_root

TYPE_MANIFEST = [
    {"name": "CanopiFile", "fields": [{"name": "name", "flatten": False, "skip": False}, {"name": "extra", "flatten": True, "skip": True}]},
    {"name": "TimelineAction", "fields": [{"name": "id", "flatten": False, "skip": False}]},
]
FIELD_DIAGRAM = """Model: target

```mermaid
classDiagram
  class CanopiFile {
    <<owner Document>>
    +name Document
    +extra Document
  }
  class TimelineAction {
    +id
    +offset_from_placement (v10, optional)
  }
  class StampPayload {
    +anything at all
  }
```
"""


class FieldModelChecks(unittest.TestCase):
    """A classDiagram field on a bindings type is a field of that type, or marked (2.1) (2.1-M165, 2.1-M192, ADR 0028 Diagrams)."""

    def errors(self, body, manifest=TYPE_MANIFEST):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs/architecture").mkdir(parents=True)
            page = root / "docs/architecture/data-design.md"
            page.write_text(body, encoding="utf-8")
            if manifest is not None:
                (root / "desktop/web/src/generated").mkdir(parents=True)
                text = manifest if isinstance(manifest, str) else json.dumps(manifest)
                (root / "desktop/web/src/generated/type-manifest.json").write_text(text, encoding="utf-8")
            return check_class_fields(page, root)

    def test_an_unmarked_field_absent_from_the_type_fails_naming_class_and_field(self):
        errors = self.errors(FIELD_DIAGRAM)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("docs/architecture/data-design.md:12:", errors[0])
        self.assertIn("TimelineAction has no field offset_from_placement", errors[0])

    def test_the_same_field_marked_target_passes(self):
        marked = FIELD_DIAGRAM.replace("(v10, optional)", "(v10, optional) (2.1)")
        self.assertEqual(self.errors(marked), [])

    def test_a_marked_field_that_is_present_fails_with_drop_mark(self):
        marked = FIELD_DIAGRAM.replace("(v10, optional)", "(v10, optional) (2.1)").replace("+id", "+id (2.1)")
        errors = self.errors(marked)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("TimelineAction field id is built; drop (2.1)", errors[0])

    def test_a_flattened_or_skipped_field_passes_when_drawn(self):
        marked = FIELD_DIAGRAM.replace("(v10, optional)", "(v10, optional) (2.1)")
        manifest = [{"name": "CanopiFile", "fields": [{"name": "extra", "flatten": True, "skip": False}, {"name": "name", "flatten": False, "skip": False}, {"name": "hidden", "flatten": False, "skip": True}]}, TYPE_MANIFEST[1]]
        self.assertEqual(self.errors(marked.replace("+name Document", "+name Document\n    +hidden"), manifest), [])

    def test_a_class_absent_from_the_manifest_is_left_to_the_class_name_check(self):
        marked = FIELD_DIAGRAM.replace("(v10, optional)", "(v10, optional) (2.1)")
        self.assertEqual(self.errors(marked.replace("+anything at all", "+anything at all\n    +more")), [])

    def test_a_bare_or_other_visibility_member_is_a_field_too(self):
        marked = FIELD_DIAGRAM.replace("(v10, optional)", "(v10, optional) (2.1)")
        for member in ("source_pth", "-source_pth", "#source_pth", "~source_pth"):
            errors = self.errors(marked.replace("+id\n", f"+id\n    {member}\n"))
            self.assertEqual(len(errors), 1, (member, errors))
            self.assertIn("TimelineAction has no field source_pth", errors[0])

    def test_a_method_member_is_not_a_field(self):
        marked = FIELD_DIAGRAM.replace("(v10, optional)", "(v10, optional) (2.1)")
        self.assertEqual(self.errors(marked.replace("+id\n", "+id\n    +decode(ItemRow) Result\n    claims() LibraryPath list\n")), [])

    def test_a_missing_or_unreadable_manifest_fails_loudly(self):
        for manifest in (None, "{not json", json.dumps({"types": []})):
            errors = self.errors(FIELD_DIAGRAM, manifest)
            self.assertEqual(len(errors), 1, (manifest, errors))
            self.assertIn("desktop/web/src/generated/type-manifest.json is missing or unreadable", errors[0])

    def test_the_docs_check_runs_the_field_check(self):
        with TemporaryDirectory() as directory:
            root = model_root(directory)
            (root / "docs/architecture/fields.md").write_text(FIELD_DIAGRAM, encoding="utf-8")
            self.assertTrue(any("type-manifest.json is missing or unreadable" in error for error in check_models(root)))


if __name__ == "__main__":
    unittest.main()
