"""The tracked commit hooks and scripts/commit_gate.py (2.1-M14, 2.1-M196, 2.1-Q205, 2.1-Q223; canopi-f47t.52.228.10).

Each case builds a temporary repository holding copies of the real .githooks and scripts/commit_gate.py, with a linked
worktree and the shared relative core.hooksPath=.githooks, and makes real commits there. A PATH shim stands in for npm
and records each call; a stub scripts/check_docs.py records the Docs row's calls.
"""
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest
import unittest.mock

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ("pre-commit", "commit-msg", "pre-merge-commit")

NPM_SHIM = """#!/bin/sh
echo "npm $* offline=${npm_config_offline:-unset}" >> "$SHIM_LOG"
if [ "$1 $2" = "run typecheck" ] && [ -n "$SHIM_TYPECHECK_FAILS" ]; then exit 2; fi
exit 0
"""
CHECK_DOCS_STUB = """import os, sys
if __name__ == "__main__":
    with open(os.environ["SHIM_LOG"], "a") as log:
        log.write("check_docs " + " ".join(sys.argv[1:]) + "\\n")


def ledger_rows(text):
    return iter(())
"""


def git(cwd, *args, env=None, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True, env=env)


class HookRepo:
    """A repository with the real hooks, a linked worktree, an origin/main ref and the npm shim on PATH."""

    def __init__(self, root):
        self.root = root
        self.main = root / "repo"
        self.main.mkdir()
        git(self.main, "init", "-q", "-b", "main")
        git(self.main, "config", "user.email", "test@example.invalid")
        git(self.main, "config", "user.name", "test")
        (self.main / "scripts").mkdir()
        for name in ("commit_gate.py", "deletion_guard.py", "gate.py"):
            shutil.copy(ROOT / "scripts" / name, self.main / "scripts" / name)
        shutil.copytree(ROOT / "policy", self.main / "policy", ignore=shutil.ignore_patterns("fixtures"))
        (self.main / "scripts/check_docs.py").write_text(CHECK_DOCS_STUB, encoding="utf-8")
        shutil.copytree(ROOT / ".githooks", self.main / ".githooks")
        (self.main / "desktop/web/src").mkdir(parents=True)
        (self.main / "desktop/web/src/a.ts").write_text("export const a = 1\n", encoding="utf-8")
        (self.main / "docs").mkdir()
        (self.main / "docs/a.md").write_text("# A\n", encoding="utf-8")
        (self.main / ".beads").mkdir()
        (self.main / ".beads/issues.jsonl").write_text("{}\n", encoding="utf-8")
        git(self.main, "add", "-A")
        git(self.main, "commit", "-q", "-m", "init", env=self.env(hooks=False))
        git(self.main, "update-ref", "refs/remotes/origin/main", "HEAD")
        git(self.main, "config", "core.hooksPath", ".githooks")
        self.linked = root / "linked"
        git(self.main, "worktree", "add", "-q", "-b", "topic", str(self.linked))
        self.bin = root / "bin"
        self.bin.mkdir()
        for name in ("npm", "cargo"):
            (self.bin / name).write_text(NPM_SHIM.replace("npm $*", f"{name} $*"), encoding="utf-8")
            (self.bin / name).chmod(0o755)
        self.log = root / "calls.log"
        self.log.write_text("", encoding="utf-8")

    def env(self, hooks=True, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k != "npm_config_offline"}
        env["PATH"] = f"{self.root / 'bin'}{os.pathsep}{env['PATH']}"
        env["SHIM_LOG"] = str(self.root / "calls.log")
        if not hooks:
            env["GIT_CONFIG_COUNT"], env["GIT_CONFIG_KEY_0"], env["GIT_CONFIG_VALUE_0"] = "1", "core.hooksPath", "/dev/null"
        env.update(extra)
        return env

    def commit(self, worktree, files, **extra):
        for name, text in files.items():
            path = worktree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            git(worktree, "add", name)
        return git(worktree, "commit", "-q", "-m", "change", env=self.env(**extra), check=False)

    def calls(self):
        return self.log.read_text(encoding="utf-8").splitlines()


class HookCase(unittest.TestCase):
    """Builds the repository on first use, inside the test, so a missing hook fails the test rather than its setup."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self._repo = None

    def tearDown(self):
        self._tmp.cleanup()

    @property
    def repo(self):
        if self._repo is None:
            self._repo = HookRepo(Path(self._tmp.name))
        return self._repo


class TrackedHooks(HookCase):
    def test_canopi_f47t_52_228_10_hooks_are_posix_wrappers_of_the_commit_gate(self):
        for hook in HOOKS:
            text = (ROOT / ".githooks" / hook).read_text(encoding="utf-8")
            self.assertTrue(text.startswith("#!/bin/sh\n"), hook)
            self.assertIn(f"exec python3 scripts/commit_gate.py {hook}", text)
            self.assertTrue(os.access(ROOT / ".githooks" / hook, os.X_OK), f"{hook} is executable")

    def test_canopi_f47t_52_228_10_a_linked_worktree_runs_its_own_hooks(self):
        marker = self.repo.root / "linked-hook-ran"
        hook = self.repo.linked / ".githooks/pre-commit"
        hook.write_text(f"#!/bin/sh\ntouch {marker}\n", encoding="utf-8")
        result = self.repo.commit(self.repo.linked, {"notes.txt": "x\n"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(marker.exists(), "the linked worktree's own .githooks/pre-commit ran")
        self.repo.commit(self.repo.main, {"notes.txt": "y\n"})
        self.assertEqual(git(self.repo.main, "config", "--get", "core.hooksPath").stdout.strip(), ".githooks")


class FastPath(HookCase):
    def test_canopi_f47t_52_228_10_docs_only_commit_runs_the_docs_row_and_no_npm(self):
        result = self.repo.commit(self.repo.linked, {"docs/a.md": "# A\n\nMore.\n", "NOTES.md": "x\n"})
        self.assertEqual(result.returncode, 0, result.stderr)
        base = git(self.repo.linked, "merge-base", "HEAD~1", "origin/main").stdout.strip()
        self.assertEqual(self.repo.calls(), ["check_docs ", f"check_docs --drift {base}"])

    def test_canopi_f47t_52_228_10_docs_only_commit_without_origin_main_is_refused(self):
        git(self.repo.main, "update-ref", "-d", "refs/remotes/origin/main")
        head = git(self.repo.linked, "rev-parse", "HEAD").stdout
        result = self.repo.commit(self.repo.linked, {"docs/a.md": "# A\n\nMore.\n"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("origin/main", result.stderr)
        self.assertEqual(git(self.repo.linked, "rev-parse", "HEAD").stdout, head, "no commit was made")

    def test_canopi_f47t_52_228_10_a_failing_git_diff_is_refused_not_read_as_nothing_staged(self):
        index = Path(git(self.repo.linked, "rev-parse", "--path-format=absolute", "--git-path", "index").stdout.strip())
        index.write_bytes(b"garbage")
        result = subprocess.run([sys.executable, "scripts/commit_gate.py", "pre-commit"], cwd=self.repo.linked,
                                capture_output=True, text=True, env=self.repo.env(), timeout=60)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("git diff", result.stderr)
        self.assertEqual(self.repo.calls(), [])

    def test_canopi_f47t_52_228_10_bead_only_commit_runs_nothing(self):
        result = self.repo.commit(self.repo.linked, {".beads/issues.jsonl": "{}\n{}\n"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.repo.calls(), [])


class HuskyParity(HookCase):
    def test_canopi_f47t_52_228_10_ts_commit_runs_the_typecheck_offline(self):
        started = time.monotonic()
        result = self.repo.commit(self.repo.linked, {"desktop/web/src/a.ts": "export const a = 2\n"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.repo.calls(), ["npm run typecheck offline=true"])
        self.assertLess(time.monotonic() - started, 30)

    def test_canopi_f47t_52_228_10_the_hook_runs_the_gate_tables_commit_lane(self):
        result = self.repo.commit(self.repo.linked, {"desktop/src/lib.rs": "fn main() {}\n"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.repo.calls(), ["cargo fmt --all -- --check offline=true", "npm run test:policies:commit offline=true"])

    def test_canopi_f47t_52_228_10_failing_typecheck_refuses_the_commit(self):
        head = git(self.repo.linked, "rev-parse", "HEAD").stdout
        result = self.repo.commit(self.repo.linked, {"desktop/web/src/a.ts": "export const a: string = 2\n"}, SHIM_TYPECHECK_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(git(self.repo.linked, "rev-parse", "HEAD").stdout, head, "no commit was made")



class CommitMsgHook(HookCase):
    """commit-msg through the real hook: the index tree against the new commit's parent (the probe's reading)."""

    def git_commit(self, *args):
        return git(self.repo.linked, "commit", "-q", *args, env=self.repo.env(), check=False)

    def raise_entry(self, key):
        path = self.repo.linked / "policy/ratchets/suppressions.json"
        family = json.loads(path.read_text(encoding="utf-8"))
        family["entries"][key] = {"count": 1}
        path.write_text(json.dumps(family, indent=2) + "\n", encoding="utf-8")
        git(self.repo.linked, "add", "policy/ratchets/suppressions.json")

    def test_canopi_f47t_52_228_10_commit_msg_refuses_an_attribution_and_makes_no_commit(self):
        head = git(self.repo.linked, "rev-parse", "HEAD").stdout
        (self.repo.linked / "docs/a.md").write_text("# A\n\nB.\n", encoding="utf-8")
        git(self.repo.linked, "add", "docs/a.md")
        result = self.git_commit("-m", f"docs: b\n\n{ATTRIBUTION}")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("gate-no-attribution", result.stdout + result.stderr)
        self.assertEqual(git(self.repo.linked, "rev-parse", "HEAD").stdout, head, "no commit was made")

    def test_canopi_f47t_52_228_10_commit_msg_judges_the_staged_tree_and_an_amend_against_its_parent(self):
        self.raise_entry("desktop/web/src/x.ts: oxlint:no-console")
        (self.repo.linked / "policy/ratchets/suppressions.json").write_text("{}", encoding="utf-8")  # unstaged junk
        result = self.git_commit("-m", "feat: an unauthorised raise")
        self.assertNotEqual(result.returncode, 0, "the staged raise is judged, not the working tree")
        self.assertIn("gate-loosening-authority", result.stdout + result.stderr)
        git(self.repo.linked, "checkout", "HEAD", "--", "policy/ratchets/suppressions.json")
        self.assertEqual(self.git_commit("-m", "chore: a staged unrelated change", "--allow-empty").returncode, 0)
        self.raise_entry("desktop/web/src/y.ts: oxlint:no-console")
        result = self.git_commit("--amend", "-m", "chore: the amend sneaks a raise in")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("y.ts", result.stdout + result.stderr)


# ---------------------------------------------------------------------------------------------------------------------
# Chunk 2's user paths (plan:157, :169), expected failures until c2 builds `commit_gate.py pr`: a commit range judged
# with the head's gate, resolution from files only (2.1-M195, 2.1-M197).

OPEN_BEAD = "canopi-f47t.52.900"
CLOSED_BEAD = "canopi-f47t.52.901"
# Ids of no ledger, built at runtime so the repository's own missing-id check never reads them.
Q_ROW, M_ROW, BRANCH_Q_ROW = ("2.1-" + ident for ident in ("Q900", "M900", "Q901"))
LEDGER = f"""# 2.1 decisions

| id | date | decision | user's words | supersedes / superseded by | implemented by |
|---|---|---|---|---|---|
| {Q_ROW} | 2026-10-26 | A user decision that authorises the planted raise. | | | plan |
| {M_ROW} | 2026-10-26 | An engineering decision, which authorises no exception. | | | plan |
"""
ATTRIBUTION = "Co-Authored-" + "By: Cl" + "aude <noreply@example.invalid>"


class GateRepo:
    """A repository with the real policy/ and scripts/, a ledger, two beads and an origin/main base commit."""

    def __init__(self, root):
        self.root = root
        self.path = root / "repo"
        self.path.mkdir()
        git(self.path, "init", "-q", "-b", "main")
        git(self.path, "config", "user.email", "test@example.invalid")
        git(self.path, "config", "user.name", "test")
        shutil.copytree(ROOT / "policy", self.path / "policy", ignore=shutil.ignore_patterns("fixtures"))
        (self.path / "scripts").mkdir()
        for name in ("commit_gate.py", "check_docs.py", "deletion_guard.py", "check_docs_model.py", "check_docs_gates.py",
                     "check_docs_policy.py", "check_docs_fields.py", "change_coupling.py"):
            if (ROOT / "scripts" / name).exists():
                shutil.copy(ROOT / "scripts" / name, self.path / "scripts" / name)
        self.write({
            "docs/decisions/2-1.md": LEDGER,
            ".beads/issues.jsonl": "\n".join(json.dumps(b) for b in (
                {"id": OPEN_BEAD, "status": "open", "assignee": "test"},
                {"id": CLOSED_BEAD, "status": "closed", "assignee": "test"})) + "\n",
            "desktop/capabilities/main-window.json": json.dumps({"permissions": ["dialog:allow-open"]}) + "\n",
        })
        self.base = self.commit("chore: base")
        git(self.path, "update-ref", "refs/remotes/origin/main", self.base)

    def write(self, files):
        for name, text in files.items():
            target = self.path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

    def commit(self, message):
        git(self.path, "add", "-A")
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.hooksPath", GIT_CONFIG_VALUE_0="/dev/null")
        git(self.path, "commit", "-q", "--allow-empty", "-m", message, env=env)
        return git(self.path, "rev-parse", "HEAD").stdout.strip()

    def stage_suppression(self):
        family = json.loads((self.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
        family["entries"]["desktop/web/src/new.ts: oxlint:no-console"] = {"count": 1}
        self.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
        git(self.path, "add", "policy/ratchets/suppressions.json")

    def raise_suppression(self, message):
        self.stage_suppression()
        return self.commit(message)

    def gate(self, *args, env=None):
        return subprocess.run([sys.executable, "scripts/commit_gate.py", *args], cwd=self.path, capture_output=True,
                              text=True, env=env, timeout=300)


class CommitGateAuthority(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = GateRepo(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def assertRefused(self, head, rule):
        result = self.repo.gate("pr", self.repo.base, head)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(rule, result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_an_exception_without_ids_is_refused(self):
        self.assertRefused(self.repo.raise_suppression("feat: add an exception"), "gate-loosening-authority")

    def test_canopi_f47t_52_228_10_an_exception_citing_only_an_m_row_is_refused(self):
        self.assertRefused(self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, {M_ROW})"), "gate-loosening-authority")

    def test_canopi_f47t_52_228_10_an_exception_citing_a_closed_bead_is_refused(self):
        self.assertRefused(self.repo.raise_suppression(f"feat: add ({CLOSED_BEAD}, {Q_ROW})"), "gate-loosening-authority")

    def test_canopi_f47t_52_228_10_an_exception_citing_a_branch_added_q_row_is_refused(self):
        self.repo.write({"docs/decisions/2-1.md": LEDGER + f"| {BRANCH_Q_ROW} | 2026-10-26 | Added on the branch. | | | plan |\n"})
        self.repo.commit("docs: a branch row")
        self.assertRefused(self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, {BRANCH_Q_ROW})"), "gate-loosening-authority")

    def test_canopi_f47t_52_228_10_an_open_bead_and_a_merge_base_q_row_pass(self):
        head = self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, {Q_ROW})")
        result = self.repo.gate("pr", self.repo.base, head)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_a_bead_closed_by_a_later_commit_still_authorises_the_earlier_one(self):
        self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, {Q_ROW})")
        beads = (self.repo.path / ".beads/issues.jsonl").read_text(encoding="utf-8")
        self.repo.write({".beads/issues.jsonl": beads.replace('"open"', '"closed"', 1)})
        head = self.repo.commit(f"chore(beads): close {OPEN_BEAD} with its receipt")
        for result in self.pr_verdicts(head).values():
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def commit_bead(self, ident, status, commit=True):
        """The base's beads plus `ident` at `status`, committed or left in the working tree."""
        beads = git(self.repo.path, "show", f"{self.repo.base}:.beads/issues.jsonl").stdout
        self.repo.write({".beads/issues.jsonl": beads + json.dumps({"id": ident, "status": status, "assignee": "t"}) + "\n"})
        return self.repo.commit(f"chore(beads): {ident} {status}") if commit else None

    def commit_msg(self, message):  # the local verdict on the staged change, as the hook runs it
        (self.repo.root / "MSG").write_text(message + "\n", encoding="utf-8")
        return self.repo.gate("commit-msg", str(self.repo.root / "MSG"), env={**os.environ, "GITHUB_ACTIONS": ""})

    def pr_verdicts(self, head):  # the gate never reads GITHUB_ACTIONS for beads: local and CI agree
        return {ci: self.repo.gate("pr", self.repo.base, head, env={**os.environ, "GITHUB_ACTIONS": ci}) for ci in ("", "true")}

    def test_canopi_f47t_52_228_10_local_and_ci_refuse_a_bead_only_the_unstaged_working_tree_holds(self):
        # Seam 8 of the Phase 0 hand-off: a bead filed in the working tree but never committed open is no authority CI
        # can see, so the local commit-msg refuses it too instead of accepting what CI later refuses.
        late = "canopi-f47t.52.903"
        self.repo.stage_suppression()
        self.commit_bead(late, "open", commit=False)
        message = f"feat: add ({late}, {Q_ROW})"
        local = self.commit_msg(message)
        self.assertEqual(local.returncode, 1, "the unstaged working tree is no bead source: " + local.stdout)
        self.assertIn(f"{late} (absent)", local.stdout)
        self.assertIn(".beads/issues.jsonl", local.stdout + local.stderr, "the refusal says to commit the bead")
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message)
        for ci, result in self.pr_verdicts(self.commit_bead(late, "closed")).items():
            self.assertEqual(result.returncode, 1, f"GITHUB_ACTIONS={ci!r}: " + result.stdout)
            self.assertIn(f"{late} (closed)", result.stdout)

    def test_canopi_f47t_52_228_10_a_bead_open_in_any_commit_of_the_pr_range_authorises_it_locally_and_in_ci(self):
        late = "canopi-f47t.52.902"
        self.repo.raise_suppression(f"feat: add ({late}, {Q_ROW})")
        self.commit_bead(late, "open")
        head = self.commit_bead(late, "closed")
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        for ci, result in self.pr_verdicts(head).items():
            self.assertEqual(result.returncode, 0, f"GITHUB_ACTIONS={ci!r}: " + result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_commit_msg_reads_the_branch_commits_and_the_integration_tip(self):
        late, tip_only = "canopi-f47t.52.904", "canopi-f47t.52.905"
        self.commit_bead(late, "open")
        branch = self.commit_bead(late, "closed")
        tip = self.commit_bead(tip_only, "open")
        git(self.repo.path, "checkout", "-q", "-B", "topic", branch)
        git(self.repo.path, "config", "branch.topic.canopiIntegration", tip)
        self.repo.stage_suppression()
        for bead in (late, tip_only):
            result = self.commit_msg(f"feat: add ({bead}, {Q_ROW})")
            self.assertEqual(result.returncode, 0, bead + ": " + result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_a_guarded_file_change_without_a_q_row_is_refused(self):
        self.repo.write({"desktop/capabilities/main-window.json": json.dumps({"permissions": []}) + "\n"})
        self.assertRefused(self.repo.commit(f"fix: drop the dialog grant ({OPEN_BEAD})"), "gate-guarded-file")

    def test_canopi_f47t_52_228_10_f5_drops_the_dialog_grants_with_q240_and_its_open_bead(self):
        self.repo.write({"docs/decisions/2-1.md": (ROOT / "docs/decisions/2-1.md").read_text(encoding="utf-8"),
                         "desktop/capabilities/main-window.json": (ROOT / "desktop/capabilities/main-window.json").read_text(encoding="utf-8")})
        self.repo.base = self.repo.commit("docs: main's ledger and capability")
        grants = json.loads((ROOT / "desktop/capabilities/main-window.json").read_text(encoding="utf-8"))
        grants["permissions"] = [g for g in grants["permissions"] if g not in ("dialog:allow-open", "dialog:allow-save")]
        self.repo.write({"desktop/capabilities/main-window.json": json.dumps(grants, indent=2) + "\n"})
        result = self.repo.gate("pr", self.repo.base, self.repo.commit(f"feat(desktop): host dialogs only ({OPEN_BEAD}, 2.1-Q240)"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_a_coverage_floor_change_names_both_numbers(self):
        coverage = json.loads((self.repo.path / "policy/ratchets/coverage.json").read_text(encoding="utf-8"))
        coverage["floors"]["vitest"]["floors"]["lines"] = 94.9
        self.repo.write({"policy/ratchets/coverage.json": json.dumps(coverage, indent=2) + "\n"})
        self.assertRefused(self.repo.commit(f"test: raise the floor ({OPEN_BEAD}, {Q_ROW})"), "gate-guarded-file")
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        self.repo.write({"policy/ratchets/coverage.json": json.dumps(coverage, indent=2) + "\n"})
        head = self.repo.commit(f"test: raise the lines floor from 94.8 to 94.9 ({OPEN_BEAD}, {M_ROW})")
        self.assertRefused(head, "a Q row on the merge base")
        git(self.repo.path, "checkout", "-q", "--detach", self.repo.base)
        self.repo.write({"policy/ratchets/coverage.json": json.dumps(coverage, indent=2) + "\n"})
        head = self.repo.commit(f"test: raise the lines floor from 94.8 to 94.9 ({OPEN_BEAD}, {Q_ROW})")
        result = self.repo.gate("pr", self.repo.base, head)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_canopi_f47t_52_228_10_a_guarded_files_entry_joins_free_with_its_file_and_renames_need_a_q_row(self):
        family = json.loads((self.repo.path / "policy/ratchets/guarded-files.json").read_text(encoding="utf-8"))
        family["entries"]["canopi-types/edition-capabilities.json"] = {"count": 1}
        self.repo.write({"policy/ratchets/guarded-files.json": json.dumps(family, indent=2) + "\n",
                         "canopi-types/edition-capabilities.json": "{}\n"})
        head = self.repo.commit("feat: the capability table joins guarded-files")
        result = self.repo.gate("pr", self.repo.base, head)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        family["entries"]["canopi-types/capabilities.json"] = family["entries"].pop("canopi-types/edition-capabilities.json")
        git(self.repo.path, "mv", "canopi-types/edition-capabilities.json", "canopi-types/capabilities.json")
        self.repo.write({"policy/ratchets/guarded-files.json": json.dumps(family, indent=2) + "\n"})
        result = self.repo.gate("pr", head, self.repo.commit(f"chore: rename ({OPEN_BEAD})"))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("gate-guarded-file", result.stdout)

    def test_canopi_f47t_52_228_10_an_attribution_trailer_is_refused(self):
        self.repo.write({"notes.txt": "x\n"})
        self.assertRefused(self.repo.commit(f"docs: notes\n\n{ATTRIBUTION}"), "gate-no-attribution")

    def test_canopi_f47t_52_228_10_the_gate_calls_no_gh_bd_or_npm_and_is_deterministic(self):
        head = self.repo.raise_suppression("feat: add an exception")
        shims = self.repo.root / "bin"
        shims.mkdir()
        log = self.repo.root / "calls.log"
        for tool in ("gh", "bd", "npm"):
            (shims / tool).write_text(f'#!/bin/sh\necho "{tool} $*" >> "{log}"\nexit 1\n', encoding="utf-8")
            (shims / tool).chmod(0o755)
        env = {**os.environ, "PATH": f"{shims}{os.pathsep}{os.environ['PATH']}"}
        first = self.repo.gate("pr", self.repo.base, head, env=env)
        second = self.repo.gate("pr", self.repo.base, head, env=env)
        self.assertEqual(first.returncode, 1)
        self.assertEqual((first.stdout, first.stderr), (second.stdout, second.stderr))
        self.assertFalse(log.exists(), log.read_text(encoding="utf-8") if log.exists() else "")


class CommitGateModes(unittest.TestCase):
    """Tree mode, merges on --cc, rebases, the demotion rules and the failure states (plan:169, design-check:628-630)."""

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = GateRepo(Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def run_gate(self, *args):
        result = self.repo.gate(*args)
        return result.returncode, result.stdout + result.stderr

    def test_canopi_f47t_52_228_10_tree_mode_fails_on_a_first_parent_commit_naming_no_pr(self):
        self.repo.write({"notes.txt": "x\n"})
        squash = self.repo.commit("docs: notes (#74)")
        self.assertEqual(self.run_gate("tree", self.repo.base, squash)[0], 0)
        self.repo.write({"notes.txt": "y\n"})
        direct = self.repo.commit("docs: a direct push")
        code, out = self.run_gate("tree", squash, direct)
        self.assertEqual(code, 1, out)
        self.assertIn("gate-squash-subject", out)

    def test_canopi_f47t_52_228_10_tree_mode_passes_a_merge_pull_request_commit_and_skips_its_branch(self):
        git(self.repo.path, "checkout", "-q", "-b", "topic")
        self.repo.raise_suppression("feat: an unauthorised raise on the PR branch")
        git(self.repo.path, "checkout", "-q", "main")
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-ff", "-m",
            "Merge pull request #75 from opencanopi/topic", "topic", env=env)
        head = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        code, out = self.run_gate("tree", self.repo.base, head)
        self.assertEqual(code, 0, out)

    def merge(self, extra_entry=None):
        """main and topic each add an authorised entry; the merge resolves suppressions.json, optionally adding one."""
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        git(self.repo.path, "checkout", "-q", "-b", "topic")
        self.repo.raise_suppression(f"feat: topic's entry ({OPEN_BEAD}, {Q_ROW})")
        topic = json.loads((self.repo.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
        git(self.repo.path, "checkout", "-q", "main")
        family = json.loads((self.repo.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
        family["entries"]["desktop/web/src/other.ts: oxlint:no-console"] = {"count": 1}
        self.repo.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
        self.repo.commit(f"feat: main's entry ({OPEN_BEAD}, {Q_ROW})")
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "merge", "-q", "--no-commit", "topic", env=env, check=False)
        family["entries"].update(topic["entries"])
        if extra_entry:
            family["entries"][extra_entry] = {"count": 1}
        self.repo.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
        return self.repo.commit("Merge branch 'topic'")

    def test_canopi_f47t_52_228_10_a_merge_of_an_authorised_branch_passes(self):
        code, out = self.run_gate("pr", self.repo.base, self.merge())
        self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_an_unauthorised_change_in_a_conflict_resolution_is_refused(self):
        code, out = self.run_gate("pr", self.repo.base, self.merge("desktop/web/src/sneaked.ts: oxlint:no-console"))
        self.assertEqual(code, 1, out)
        self.assertIn("gate-loosening-authority", out)
        self.assertIn("sneaked.ts", out)

    def test_canopi_f47t_52_228_10_rebased_commits_are_rechecked(self):
        head = self.repo.raise_suppression("feat: add an exception")
        self.assertEqual(self.run_gate("pr", self.repo.base, head)[0], 1)
        git(self.repo.path, "checkout", "-q", "-b", "newbase", self.repo.base)
        self.repo.write({"notes.txt": "x\n"})
        newbase = self.repo.commit("docs: notes")
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        git(self.repo.path, "-c", "core.hooksPath=/dev/null", "rebase", "-q", "--onto", newbase, self.repo.base, "main", env=env)
        rebased = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        self.assertNotEqual(rebased, head)
        code, out = self.run_gate("pr", newbase, rebased)
        self.assertEqual(code, 1, out)
        self.assertIn("gate-loosening-authority", out)

    def test_canopi_f47t_52_228_10_a_commit_changing_the_gate_table_its_scripts_or_hooks_is_listed(self):
        heads = []
        for path in ("scripts/gate.py", "scripts/check_docs_gates.py", ".githooks/pre-commit", "notes.txt"):
            target = self.repo.path / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "a", encoding="utf-8") as file:
                file.write("# changed\n")
            heads.append(self.repo.commit(f"chore: change {path}"))
        code, out = self.run_gate("pr", self.repo.base, heads[-1])
        self.assertEqual(code, 0, out)
        listed = [line for line in out.splitlines() if line.startswith("changes the gate's own files: ")]
        self.assertEqual([line.split("chore: change ")[1] for line in listed],
                         ["scripts/gate.py", "scripts/check_docs_gates.py", ".githooks/pre-commit"])

    def test_canopi_f47t_52_228_10_an_inventory_demotion_or_a_dropped_rule_row_needs_a_q_row(self):
        rules = json.loads((self.repo.path / "policy/rules.json").read_text(encoding="utf-8"))
        inventory = {"rules": [{"id": "x-rule", "doc": "AGENTS.md", "quote": "x", "state": {"exists": {"check": "x"}}}]}
        self.repo.write({"policy/inventory.json": json.dumps(inventory) + "\n"})
        base = self.repo.commit("chore: inventory")
        inventory["rules"][0]["state"] = "advice"
        dropped = {**rules, "rules": [r for r in rules["rules"] if r["id"] != "suppressions"]}
        for files, rule in (({"policy/inventory.json": json.dumps(inventory) + "\n"}, "x-rule"),
                            ({"policy/rules.json": json.dumps(dropped, indent=2) + "\n"}, "suppressions")):
            with self.subTest(rule=rule):
                git(self.repo.path, "checkout", "-q", "--detach", base)
                self.repo.write(files)
                code, out = self.run_gate("pr", base, self.repo.commit(f"chore: demote ({OPEN_BEAD})"))
                self.assertEqual(code, 1, out)
                self.assertIn("gate-inventory-demotion", out)
                self.assertIn(rule, out)
                git(self.repo.path, "checkout", "-q", "--detach", base)
                self.repo.write(files)
                code, out = self.run_gate("pr", base, self.repo.commit(f"chore: demote ({OPEN_BEAD}, {Q_ROW})"))
                self.assertEqual(code, 0, out)

    def test_canopi_f47t_52_228_10_sigint_exits_non_zero_and_leaves_status_and_index_unchanged(self):
        for n in range(4):
            self.repo.raise_suppression(f"feat: raise {n}")
            family = json.loads((self.repo.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
            family["entries"] = {f"{k}{n}" if "new.ts" in k else k: v for k, v in family["entries"].items()}
            self.repo.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
            self.repo.commit(f"feat: rename {n}")
        head = git(self.repo.path, "rev-parse", "HEAD").stdout.strip()
        index = self.repo.path / ".git/index"
        before = (git(self.repo.path, "status", "--porcelain").stdout, hashlib.sha256(index.read_bytes()).hexdigest())
        process = subprocess.Popen([sys.executable, "scripts/commit_gate.py", "pr", self.repo.base, head], cwd=self.repo.path,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        process.send_signal(signal.SIGINT)
        _, err = process.communicate(timeout=60)
        self.assertNotEqual(process.returncode, 0, err)
        self.assertIn("interrupted", err)
        after = (git(self.repo.path, "status", "--porcelain").stdout, hashlib.sha256(index.read_bytes()).hexdigest())
        self.assertEqual(before, after)

    def test_canopi_f47t_52_228_10_enospc_fails_naming_the_path(self):
        spec = importlib.util.spec_from_file_location("commit_gate_under_test", ROOT / "scripts/commit_gate.py")
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)

        def full(*_args, **_kwargs):
            raise OSError(errno.ENOSPC, "No space left on device", "/tmp/canopi-gate-full")

        case = Path(self._tmp.name) / "case"
        case.mkdir()
        (case / "case.json").write_text(json.dumps({"base": {}, "head": {"a.txt": "x"}, "message": "docs: x"}), encoding="utf-8")
        err = io.StringIO()
        with unittest.mock.patch.object(gate.tempfile, "mkdtemp", full), unittest.mock.patch("sys.stderr", err):
            code = gate.main(["commit_gate.py", "planted", str(case)])
        self.assertEqual(code, 1)
        self.assertIn("/tmp/canopi-gate-full", err.getvalue())
        self.assertIn("No space left", err.getvalue())
