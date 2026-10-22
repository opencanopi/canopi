from pathlib import Path
from tempfile import TemporaryDirectory
import json
import subprocess
import unittest

from scripts.check_playwright_pins import ROOT, check, locked_version

# Built by concatenation so this file holds no image literal the check would read in the repository.
REGISTRY = "mcr.microsoft.com/playwright:" + "v"


def image(version: str) -> str:
    return f"{REGISTRY}{version}-noble"


def repo(root: Path, version: str | None, files: dict[str, str]) -> None:
    packages = {"": {"name": "canopi-web"}}
    if version is not None:
        packages["node_modules/@playwright/test"] = {"version": version}
    lock = root / "desktop/web/package-lock.json"
    lock.parent.mkdir(parents=True)
    lock.write_text(json.dumps({"lockfileVersion": 3, "packages": packages}), encoding="utf-8")
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)


class CheckPlaywrightPins(unittest.TestCase):
    def test_literals_matching_the_lockfile_pass(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo(root, "1.64.1", {
                ".github/workflows/lane.yml": f"    image: {image('1.64.1')}\n",
                "scripts/publish.sh": f'IMAGE="{image("1.64.1")}"\n',
            })
            self.assertEqual(check(root), [])

    def test_a_planted_mismatch_fails_naming_the_file_line_and_both_versions(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo(root, "1.64.1", {
                ".github/workflows/lane.yml": f"jobs:\n  e2e:\n    image: {image('1.64.1')}\n",
                "desktop/web/playwright.config.ts": f"// first line\n// Baselines only in {image('1.63.0')}.\n",
            })
            problems = check(root)
            self.assertEqual(len(problems), 1, problems)
            self.assertIn("desktop/web/playwright.config.ts:2", problems[0])
            self.assertIn("1.63.0", problems[0])
            self.assertIn("1.64.1", problems[0])

    def test_every_mismatch_on_a_line_is_found_and_tags_without_a_suffix_count(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo(root, "1.64.1", {"README.md": f"`{image('1.62.0')}` or `{REGISTRY}1.64.0`\n"})
            self.assertEqual(len(check(root)), 2)

    def test_history_in_beads_and_decisions_and_untracked_files_are_not_read(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo(root, "1.64.1", {
                ".beads/issues.jsonl": f'{{"title": "{image("1.50.0")}"}}\n',
                "docs/decisions/2-0.md": f"Moved to {image('1.60.0')}.\n",
            })
            (root / "scratch.txt").write_text(image("1.10.0"), encoding="utf-8")
            self.assertEqual(check(root), [])

    def test_a_lockfile_without_playwright_fails(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo(root, None, {})
            with self.assertRaisesRegex(SystemExit, "@playwright/test"):
                locked_version(root)

    def test_the_repository_pins_one_playwright(self):
        self.assertEqual(check(ROOT), [])


if __name__ == "__main__":
    unittest.main()
