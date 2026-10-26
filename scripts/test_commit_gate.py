"""The tracked commit hooks and scripts/commit_gate.py (2.1-M14, 2.1-M196, 2.1-Q205, 2.1-Q223; canopi-f47t.52.228.10).

Each case builds a temporary repository holding copies of the real .githooks and scripts/commit_gate.py, with a linked
worktree and the shared relative core.hooksPath=.githooks, and makes real commits there. A PATH shim stands in for npm
and records each call; a stub scripts/check_docs.py records the Docs row's calls.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ("pre-commit", "commit-msg", "pre-merge-commit")

NPM_SHIM = """#!/bin/sh
echo "npm $* offline=${npm_config_offline:-unset}" >> "$SHIM_LOG"
if [ "$1 $2" = "run typecheck" ] && [ -n "$SHIM_TYPECHECK_FAILS" ]; then exit 2; fi
exit 0
"""
CHECK_DOCS_STUB = """import os, sys
with open(os.environ["SHIM_LOG"], "a") as log:
    log.write("check_docs " + " ".join(sys.argv[1:]) + "\\n")
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
        shutil.copy(ROOT / "scripts/commit_gate.py", self.main / "scripts/commit_gate.py")
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
        (self.bin / "npm").write_text(NPM_SHIM, encoding="utf-8")
        (self.bin / "npm").chmod(0o755)
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

    def test_canopi_f47t_52_228_10_failing_typecheck_refuses_the_commit(self):
        head = git(self.repo.linked, "rev-parse", "HEAD").stdout
        result = self.repo.commit(self.repo.linked, {"desktop/web/src/a.ts": "export const a: string = 2\n"}, SHIM_TYPECHECK_FAILS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(git(self.repo.linked, "rev-parse", "HEAD").stdout, head, "no commit was made")


# ---------------------------------------------------------------------------------------------------------------------
# Chunk 2's user paths (plan:157, :169), expected failures until c2 builds `commit_gate.py pr`: a commit range judged
# with the head's gate, resolution from files only (2.1-M195, 2.1-M197).

OPEN_BEAD = "canopi-f47t.52.900"
CLOSED_BEAD = "canopi-f47t.52.901"
LEDGER = """# 2.1 decisions

| Id | Date | Decision |
|---|---|---|
| 2.1-Q900 | 2026-10-26 | A user decision that authorises the planted raise. |
| 2.1-M900 | 2026-10-26 | An engineering decision, which authorises no exception. |
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
        for name in ("commit_gate.py", "check_docs.py", "deletion_guard.py"):
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

    def raise_suppression(self, message):
        family = json.loads((self.path / "policy/ratchets/suppressions.json").read_text(encoding="utf-8"))
        family["entries"]["desktop/web/src/new.ts: oxlint:no-console"] = {"count": 1}
        self.write({"policy/ratchets/suppressions.json": json.dumps(family, indent=2) + "\n"})
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

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_an_exception_without_ids_is_refused(self):
        self.assertRefused(self.repo.raise_suppression("feat: add an exception"), "gate-loosening-authority")

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_an_exception_citing_only_an_m_row_is_refused(self):
        self.assertRefused(self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, 2.1-M900)"), "gate-loosening-authority")

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_an_exception_citing_a_closed_bead_is_refused(self):
        self.assertRefused(self.repo.raise_suppression(f"feat: add ({CLOSED_BEAD}, 2.1-Q900)"), "gate-loosening-authority")

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_an_exception_citing_a_branch_added_q_row_is_refused(self):
        self.repo.write({"docs/decisions/2-1.md": LEDGER + "| 2.1-Q901 | 2026-10-26 | Added on the branch. |\n"})
        self.repo.commit("docs: a branch row")
        self.assertRefused(self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, 2.1-Q901)"), "gate-loosening-authority")

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_an_open_bead_and_a_merge_base_q_row_pass(self):
        head = self.repo.raise_suppression(f"feat: add ({OPEN_BEAD}, 2.1-Q900)")
        result = self.repo.gate("pr", self.repo.base, head)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_a_guarded_file_change_without_a_q_row_is_refused(self):
        self.repo.write({"desktop/capabilities/main-window.json": json.dumps({"permissions": []}) + "\n"})
        self.assertRefused(self.repo.commit(f"fix: drop the dialog grant ({OPEN_BEAD})"), "gate-guarded-file")

    @unittest.expectedFailure
    def test_canopi_f47t_52_228_10_an_attribution_trailer_is_refused(self):
        self.repo.write({"notes.txt": "x\n"})
        self.assertRefused(self.repo.commit(f"docs: notes\n\n{ATTRIBUTION}"), "gate-no-attribution")

    @unittest.expectedFailure
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
