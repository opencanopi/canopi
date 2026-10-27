"""`advisories.py` over planted exception tables and a fake osv-scanner, through the real adapter (2.1-M204).

The fake scanner replays JSON, an exit status and stderr from the environment and counts its runs, so the retry and
offline rules are seen without a network or a database. Needs node on PATH (the adapter is JavaScript).
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "advisories.py"
WORKFLOW = ROOT / ".github" / "workflows" / "advisories.yml"

FAKE_SCANNER = f"""#!{sys.executable}
import os, sys
with open(os.environ["FAKE_OSV_CALLS"], "a") as calls:
    calls.write(" ".join(sys.argv[1:]) + "\\n")
count = sum(1 for _ in open(os.environ["FAKE_OSV_CALLS"]))
if count <= int(os.environ.get("FAKE_OSV_FAILURES", "0")):
    sys.stderr.write("query failed: dial tcp: lookup api.osv.dev: no such host\\n")
    sys.stdout.write('{{"results": []}}\\n')
    sys.exit(127)
sys.stdout.write(open(os.environ["FAKE_OSV_JSON"]).read())
sys.exit(int(os.environ.get("FAKE_OSV_STATUS", "1")))
"""

GLIB = {"ids": ["GHSA-wrw7-89jp-8q8g", "RUSTSEC-2024-0429"], "aliases": ["GHSA-wrw7-89jp-8q8g", "RUSTSEC-2024-0429"]}
TOKIO = {"ids": ["RUSTSEC-2026-0386"], "aliases": ["RUSTSEC-2026-0386"]}
ENTRY = {"id": "RUSTSEC-2024-0429", "package": "glib", "reason": "Tauri 2's GTK3 webview chain", "until": "2027-04-27",
         "upstream": "W17"}


def report(*groups_by_package):
    """osv-scanner JSON naming both lockfiles: Cargo.lock holds each (package, groups); package-lock.json is clean."""
    cargo = [{"package": {"name": name, "version": "1.0.0", "ecosystem": "crates.io"}, "groups": groups,
              "vulnerabilities": [{"id": group["ids"][0]} for group in groups]} for name, groups in groups_by_package]
    cargo.append({"package": {"name": "serde", "version": "1.0.228", "ecosystem": "crates.io"}})
    return {"results": [
        {"source": {"path": "/work/Cargo.lock", "type": "lockfile"}, "packages": cargo},
        {"source": {"path": "/work/desktop/web/package-lock.json", "type": "lockfile"},
         "packages": [{"package": {"name": "preact", "version": "11.0.1", "ecosystem": "npm"}}]},
    ]}


class AdvisoriesCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.root = self.dir / "repo"
        (self.root / "policy").mkdir(parents=True)
        self.scanner = self.dir / "osv-scanner"
        self.scanner.write_text(FAKE_SCANNER)
        self.scanner.chmod(0o755)
        self.calls = self.dir / "calls"
        self.calls.write_text("")
        self.summary = self.dir / "summary.md"
        self.env = {}
        self.table([ENTRY])
        self.scan(report(("glib", [GLIB])))

    def table(self, entries):
        (self.root / "policy" / "advisories.json").write_text(json.dumps({"version": 1, "advisories": entries}))

    def scan(self, data, status=1):
        (self.dir / "scan.json").write_text(json.dumps(data))
        self.env["FAKE_OSV_STATUS"] = str(status)

    def run_script(self, *args):
        env = {**os.environ, "OSV_SCANNER": str(self.scanner), "FAKE_OSV_JSON": str(self.dir / "scan.json"),
               "FAKE_OSV_CALLS": str(self.calls), **self.env}
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args, "--root", str(self.root)], env=env,
                              capture_output=True, text=True, check=False)

    def generate(self):
        result = self.run_script("generate")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def check(self, *args):
        return self.run_script("check", "--today", "2026-10-27", "--summary", str(self.summary), *args)

    def assert_check_passes(self, *args):
        result = self.check(*args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def assert_check_fails(self, message, *args):
        result = self.check(*args)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(message, result.stderr)
        return result

    def scans(self):
        return len(self.calls.read_text().splitlines())


class GenerationTests(AdvisoriesCase):
    def test_generation_is_byte_identical_and_replaces_the_file_whole(self):
        self.generate()
        toml = self.root / "osv-scanner.toml"
        first = toml.read_bytes()
        linked = self.dir / "linked.toml"
        os.link(toml, linked)
        self.generate()
        self.assertEqual(toml.read_bytes(), first)
        # Temp plus rename: the old inode (a hard link to it) is never written in place.
        self.assertNotEqual(os.stat(toml).st_ino, os.stat(linked).st_ino)
        self.assertIn(b'id = "RUSTSEC-2024-0429"', first)
        self.assertIn(b"ignoreUntil = 2027-04-27T00:00:00Z", first)

    def test_a_hand_edited_config_fails_and_check_never_writes(self):
        self.generate()
        toml = self.root / "osv-scanner.toml"
        edited = toml.read_text().replace("2027-04-27", "2099-01-01")
        toml.write_text(edited)
        self.assert_check_fails("osv-scanner.toml differs from what policy/advisories.json generates")
        self.assertEqual(toml.read_text(), edited)

    def test_the_repositorys_config_is_what_its_table_generates(self):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "generate", "--root", str(ROOT), "--stdout"],
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, (ROOT / "osv-scanner.toml").read_text(encoding="utf-8"))


class TableTests(AdvisoriesCase):
    def test_a_clean_run_passes(self):
        self.generate()
        self.assert_check_passes()

    def test_an_entry_with_no_w_tag_fails(self):
        self.table([{key: value for key, value in ENTRY.items() if key != "upstream"}])
        self.generate()
        self.assert_check_fails("RUSTSEC-2024-0429 has no upstream W tag")

    def test_an_expired_entry_fails(self):
        self.table([{**ENTRY, "until": "2026-10-01"}])
        self.generate()
        self.assert_check_fails("RUSTSEC-2024-0429 expired on 2026-10-01")

    def test_a_stale_entry_fails(self):
        self.table([ENTRY, {**ENTRY, "id": "RUSTSEC-2024-0370", "package": "proc-macro-error"}])
        self.generate()
        self.assert_check_fails("RUSTSEC-2024-0370 is no longer reported: delete its entry")

    def test_a_non_lockfile_pr_reports_expired_and_stale_entries_and_passes(self):
        """The database or the calendar moved, not the PR: the main or weekly run fails instead."""
        self.table([{**ENTRY, "until": "2026-10-01"}, {**ENTRY, "id": "RUSTSEC-2024-0370", "package": "proc-macro-error"}])
        self.generate()
        result = self.assert_check_passes("--event", "pull_request", "--changed", "renovate.json")
        self.assertIn("RUSTSEC-2024-0429 expired on 2026-10-01", result.stdout)
        self.assertIn("RUSTSEC-2024-0370 is no longer reported", result.stdout)
        self.assert_check_fails("RUSTSEC-2024-0429 expired on 2026-10-01", "--event", "pull_request", "--changed",
                                "desktop/web/package-lock.json")
        self.assert_check_fails("RUSTSEC-2024-0370 is no longer reported", "--event", "schedule")

    def test_a_non_lockfile_pr_still_fails_on_the_table_it_can_fix(self):
        self.table([{key: value for key, value in ENTRY.items() if key != "upstream"}])
        self.generate()
        self.assert_check_fails("RUSTSEC-2024-0429 has no upstream W tag", "--event", "pull_request", "--changed",
                                "renovate.json")

    def test_an_entry_listed_by_an_alias_matches_its_group(self):
        self.table([{**ENTRY, "id": "GHSA-wrw7-89jp-8q8g"}])
        self.generate()
        self.assert_check_passes()


class NewAdvisoryTests(AdvisoriesCase):
    def setUp(self):
        super().setUp()
        self.generate()
        self.scan(report(("glib", [GLIB]), ("tokio", [TOKIO])))

    def test_an_unlisted_advisory_fails_with_a_ready_bead_line(self):
        self.assert_check_fails("RUSTSEC-2026-0386 (tokio@1.0.0 in Cargo.lock) is not in policy/advisories.json",
                                "--event", "schedule")
        summary = self.summary.read_text()
        self.assertRegex(summary, r"(?m)^bd create .*RUSTSEC-2026-0386.*tokio@1\.0\.0")

    def test_main_fails_and_a_lockfile_pr_fails(self):
        self.assert_check_fails("RUSTSEC-2026-0386", "--event", "push")
        self.assert_check_fails("RUSTSEC-2026-0386", "--event", "pull_request", "--changed", "Cargo.lock")

    def test_a_non_lockfile_pr_reports_the_bead_line_and_passes(self):
        result = self.assert_check_passes("--event", "pull_request", "--changed", "policy/advisories.json")
        self.assertIn("RUSTSEC-2026-0386", result.stdout)
        self.assertRegex(self.summary.read_text(), r"(?m)^bd create .*RUSTSEC-2026-0386")


class ScannerFailureTests(AdvisoriesCase):
    def setUp(self):
        super().setUp()
        self.generate()

    def test_an_unreachable_api_fails_after_one_retry(self):
        self.env["FAKE_OSV_FAILURES"] = "5"
        self.assert_check_fails("after one retry")
        self.assertEqual(self.scans(), 2)

    def test_one_failure_is_retried_once(self):
        self.env["FAKE_OSV_FAILURES"] = "1"
        self.assert_check_passes()
        self.assertEqual(self.scans(), 2)

    def test_offline_without_a_cached_database_fails_at_once(self):
        self.env["FAKE_OSV_FAILURES"] = "5"
        self.assert_check_fails("no cached advisory database", "--offline")
        self.assertEqual(self.scans(), 1)
        self.assertIn("--offline", self.calls.read_text())


class WorkflowTests(unittest.TestCase):
    def test_ci_holds_no_bd_call(self):
        """CI prints ready `bd create` lines; it never runs bd (2.1-M197)."""
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotRegex(text, r"(?m)^\s*(?:-\s*)?(?:run:\s*)?bd\s")
        self.assertIn("scripts/advisories.py check", text)


if __name__ == "__main__":
    unittest.main()
