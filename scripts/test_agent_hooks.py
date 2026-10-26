"""Agent hooks (scripts/agent_hooks.py): PreToolUse JSON in, decision out; SessionStart warns, never blocks.

2.1-M196 (refusals, SessionStart), 2.1-M219 (discards ask), canopi-f47t.52.228.10. Each case runs the real script in a
temporary layout: a canopi-like main worktree (the user's checkout) holding .rq-scratch/phase-0 (a linked worktree) and
.rq-scratch/tools (another repository), with CLAUDE_PROJECT_DIR naming the main worktree.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

SCRIPT = Path(__file__).resolve().parent / "agent_hooks.py"
HUSKY_PACKAGE = {"name": "web", "scripts": {"prepare": "cd ../.. && husky desktop/web/.husky"}}
PLAIN_PACKAGE = {"name": "web", "scripts": {"test": "vitest"}}


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def make_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "user.name", "test")
    (path / "README.md").write_text("x\n", encoding="utf-8")
    git(path, "add", "README.md")
    git(path, "commit", "-q", "-m", "init")


def write_package(worktree, package):
    web = worktree / "desktop/web"
    web.mkdir(parents=True, exist_ok=True)
    (web / "package.json").write_text(json.dumps(package), encoding="utf-8")


class Layout:
    """The user's checkout with a linked worktree and a separate tools repository inside .rq-scratch."""

    def __init__(self, root):
        self.root = root
        self.main = root / "canopi"
        make_repo(self.main)
        self.linked = self.main / ".rq-scratch/phase-0"
        git(self.main, "worktree", "add", "-q", "-b", "phase-0", str(self.linked))
        self.tools = self.main / ".rq-scratch/tools"
        make_repo(self.tools)
        self.old = self.main / ".rq-scratch/wt-old"
        git(self.main, "worktree", "add", "-q", "-b", "old", str(self.old))
        write_package(self.old, HUSKY_PACKAGE)
        write_package(self.linked, PLAIN_PACKAGE)


def run_hook(mode, payload, project, env=None):
    stdin = payload if isinstance(payload, str) else json.dumps(payload)
    full_env = {k: v for k, v in os.environ.items() if k not in ("HUSKY", "CLAUDE_PROJECT_DIR")}
    full_env["CLAUDE_PROJECT_DIR"] = str(project)
    full_env.update(env or {})
    return subprocess.run([sys.executable, str(SCRIPT), mode], input=stdin, capture_output=True, text=True, env=full_env, timeout=60)


class AgentHookCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = TemporaryDirectory()
        cls.layout = Layout(Path(cls._tmp.name))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def decide(self, command, cwd=None, env=None):
        """The permission decision and reason for a Bash call: ('allow-silent', '') when the hook says nothing."""
        cwd = cwd or self.layout.linked
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": str(cwd), "tool_input": {"command": command}}
        result = run_hook("pre-tool-use", payload, self.layout.main, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        if not result.stdout.strip():
            return "pass", ""
        out = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "PreToolUse")
        return out["permissionDecision"], out["permissionDecisionReason"]

    def assertDecision(self, command, decision, rule=None, cwd=None, env=None):
        got, reason = self.decide(command, cwd, env)
        self.assertEqual(got, decision, f"{command!r}: {reason}")
        if rule:
            self.assertTrue(reason.startswith(f"[{rule}] "), f"{command!r}: reason {reason!r} starts with [{rule}]")


class Refusals(AgentHookCase):
    """Deny: the commands that skip or remove the commit gate, create a stash, or commit in the user's checkout."""

    def test_canopi_f47t_52_228_10_no_verify_is_refused(self):
        for command in ("git commit --no-verify -m x", "git commit -n -m x", "git commit -anm x", "git push --no-verify",
                        "git merge --no-verify topic", "git commit --no-veri -m x"):
            self.assertDecision(command, "deny", "hook-no-verify")
        self.assertIn("pre-commit gate", self.decide("git commit --no-verify -m x")[1])

    def test_canopi_f47t_52_228_10_plumbing_commit_is_refused(self):
        self.assertDecision("git commit-tree HEAD^{tree} -m x", "deny", "hook-plumbing-commit")

    def test_canopi_f47t_52_228_10_husky_skip_before_git_is_refused(self):
        self.assertDecision("HUSKY=0 git commit -m x", "deny", "hook-husky-skip")
        self.assertDecision("export HUSKY=0 && git commit -m x", "deny", "hook-husky-skip")
        self.assertDecision("env HUSKY=0 git commit -m x", "deny", "hook-husky-skip")

    def test_canopi_f47t_52_228_10_hooks_path_override_is_refused(self):
        for command in ("git -c core.hooksPath=/dev/null commit -m x", "git config core.hooksPath x",
                        "git config --local core.hookspath .husky", "git config --unset core.hooksPath",
                        "git config set core.hooksPath x", "npx husky", "npx -y husky@9 desktop/web/.husky"):
            self.assertDecision(command, "deny", "hook-hooks-path-override")
        self.assertDecision("git config --get core.hooksPath", "pass")
        self.assertDecision("git config core.hooksPath", "pass")

    def test_canopi_f47t_52_228_10_creating_a_stash_is_refused(self):
        for command in ("git stash", "git stash push -m wip", "git stash save wip", "git stash -u"):
            self.assertDecision(command, "deny", "hook-bare-stash")
        self.assertIn("WIP commit", self.decide("git stash")[1])

    def test_canopi_f47t_52_228_10_commit_in_the_user_checkout_is_refused(self):
        main = self.layout.main
        self.assertDecision("git commit -m x", "deny", "hook-user-checkout-commit", cwd=main)
        self.assertDecision(f"git -C {main} commit -m x", "deny", "hook-user-checkout-commit")
        self.assertDecision(f"cd {main} && git commit -m x", "deny", "hook-user-checkout-commit")
        self.assertDecision("cd ../.. && git commit -m x", "deny", "hook-user-checkout-commit")
        self.assertDecision("git merge topic", "deny", "hook-user-checkout-commit", cwd=main)
        self.assertDecision("git merge --no-ff topic", "deny", "hook-user-checkout-commit", cwd=main)
        self.assertIn("worktree", self.decide("git commit -m x", cwd=main)[1])

    def test_canopi_f47t_52_228_10_install_running_husky_prepare_is_refused(self):
        web = self.layout.old / "desktop/web"
        self.assertDecision("npm ci", "deny", "hook-old-husky-install", cwd=web)
        self.assertDecision("npm install", "deny", "hook-old-husky-install", cwd=web)
        self.assertDecision(f"cd {web} && npm i", "deny", "hook-old-husky-install")
        self.assertIn("HUSKY=0 npm ci", self.decide("npm ci", cwd=web)[1])
        self.assertDecision("HUSKY=0 npm ci", "pass", cwd=web)
        self.assertDecision("npm ci", "pass", cwd=self.layout.linked / "desktop/web")


class Asks(AgentHookCase):
    """Ask through the permission prompt: commands that discard user work or change the shared stash stack (2.1-M219)."""

    def test_canopi_f47t_52_228_10_reset_hard_asks(self):
        self.assertDecision("git reset --hard HEAD~1", "ask", "hook-reset-hard-asks")
        self.assertDecision("git reset --soft HEAD~1", "pass")

    def test_canopi_f47t_52_228_10_discards_ask(self):
        for command in ("git checkout -- f.txt", "git checkout -f main", "git restore f.txt", "git restore --worktree f.txt",
                        "git clean -fd", "git clean -xdf", "git clean --force"):
            self.assertDecision(command, "ask", "hook-discard-asks")
        self.assertDecision("git restore --staged f.txt", "pass")
        self.assertDecision("git clean -n", "pass")
        self.assertDecision("git checkout -b topic", "pass")

    def test_canopi_f47t_52_228_10_stash_stack_changes_ask(self):
        for command in ("git stash pop", "git stash apply stash@{1}", "git stash drop", "git stash clear"):
            self.assertDecision(command, "ask", "hook-stash-stack-asks")


class Passes(AgentHookCase):
    """Pass: reads, mentions in text, other repositories, linked worktrees and fast-forward updates of the checkout."""

    def test_canopi_f47t_52_228_10_reads_and_mentions_pass(self):
        for command in ("git log --oneline", "git stash list", "git stash show -p", "grep -- --no-verify AGENTS.md",
                        'git commit -m "text naming --no-verify"', "git commit -m 'no -n here'",
                        'git commit -F msg.txt --author "A <a@b>"'):
            self.assertDecision(command, "pass")

    def test_canopi_f47t_52_228_10_other_repositories_and_linked_worktrees_pass(self):
        main = self.layout.main
        self.assertDecision("git commit -m x", "pass", cwd=self.layout.linked)
        self.assertDecision("git -C .rq-scratch/tools commit -m x", "pass", cwd=main)
        self.assertDecision("cd .rq-scratch/phase-0 && git commit -m x", "pass", cwd=main)
        self.assertDecision("git -C .rq-scratch/phase-0 merge topic", "pass", cwd=main)

    def test_canopi_f47t_52_228_10_fast_forward_updates_of_the_checkout_pass(self):
        main = self.layout.main
        for command in ("git fetch", "git pull --ff-only", "git merge --ff-only origin/main",
                        "git worktree add .rq-scratch/wt-x -b wt/x", "git worktree remove .rq-scratch/wt-x", "git status"):
            self.assertDecision(command, "pass", cwd=main)

    def test_canopi_f47t_52_228_10_other_tools_pass(self):
        self.assertDecision("ls -la", "pass")
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Read", "cwd": str(self.layout.main), "tool_input": {"file_path": "x"}}
        result = run_hook("pre-tool-use", payload, self.layout.main)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, ""))


class Parsing(AgentHookCase):
    """Chains, prefixes, one level of shell -c, and fail-closed answers for what it cannot parse."""

    def test_canopi_f47t_52_228_10_chains_are_split(self):
        for command in ("git status && git commit --no-verify -m x", "false || git commit -n -m x",
                        "git add . ; git commit --no-verify -m x", "echo x | git commit --no-verify -F -",
                        "git add .\ngit commit --no-verify -m x", "(cd sub && git commit --no-verify -m x)"):
            self.assertDecision(command, "deny", "hook-no-verify")

    def test_canopi_f47t_52_228_10_prefixes_are_skipped(self):
        self.assertDecision("GIT_AUTHOR_NAME=x git commit --no-verify -m x", "deny", "hook-no-verify")
        self.assertDecision("env FOO=1 git commit --no-verify -m x", "deny", "hook-no-verify")
        self.assertDecision("time git reset --hard", "ask", "hook-reset-hard-asks")

    def test_canopi_f47t_52_228_10_one_level_of_shell_c_is_read(self):
        for shell in ("sh -c", "bash -c", "bash -lc"):
            self.assertDecision(f"{shell} 'git commit --no-verify -m x'", "deny", "hook-no-verify")
        self.assertDecision("bash -c 'git log'", "pass")
        self.assertDecision("""bash -c "sh -c 'git log'" """, "ask")

    def test_canopi_f47t_52_228_10_heredoc_bodies_are_text_unless_a_shell_reads_them(self):
        body = "fix: the hook's message\n\nIt names --no-verify; git stash and HUSKY=0 git commit are text.\n"
        self.assertDecision(f"git commit -F - <<'EOF'\n{body}EOF\ngit log -1", "pass")
        self.assertDecision(f'git commit -m "$(cat <<\'EOF\'\n{body}EOF\n)"', "pass")
        self.assertDecision(f"git commit --no-verify -F - <<'EOF'\n{body}EOF", "deny", "hook-no-verify")
        self.assertDecision(f"git commit -F - <<EOF\n{body}EOF\ngit stash", "deny", "hook-bare-stash")
        self.assertDecision("bash <<'EOF'\ngit commit --no-verify -m x\nEOF", "deny", "hook-no-verify")

    def test_canopi_f47t_52_228_10_unparseable_input_asks_and_never_crashes(self):
        self.assertDecision('git commit -m "unbalanced', "ask")
        result = run_hook("pre-tool-use", "{not json", self.layout.main)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")


class SessionStart(unittest.TestCase):
    """SessionStart prints a warning when the hooks would not run; nothing when all is well; it never blocks."""

    def start(self, worktree, env=None):
        payload = {"hook_event_name": "SessionStart", "cwd": str(worktree), "source": "startup"}
        result = run_hook("session-start", payload, worktree, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.repo = Path(self._tmp.name) / "canopi"
        make_repo(self.repo)
        (self.repo / ".githooks").mkdir()
        (self.repo / ".githooks/pre-commit").write_text("#!/bin/sh\n", encoding="utf-8")
        git(self.repo, "config", "core.hooksPath", ".githooks")
        write_package(self.repo, PLAIN_PACKAGE)

    def tearDown(self):
        self._tmp.cleanup()

    def test_canopi_f47t_52_228_10_session_start_is_silent_when_the_hooks_run(self):
        self.assertEqual(self.start(self.repo).strip(), "")

    def test_canopi_f47t_52_228_10_session_start_warns_on_another_hooks_path(self):
        git(self.repo, "config", "core.hooksPath", "desktop/web/.husky/_")
        self.assertIn("core.hooksPath", self.start(self.repo))
        git(self.repo, "config", "--unset", "core.hooksPath")
        self.assertIn("core.hooksPath", self.start(self.repo))

    def test_canopi_f47t_52_228_10_session_start_warns_on_a_worktree_without_githooks(self):
        (self.repo / ".githooks/pre-commit").unlink()
        (self.repo / ".githooks").rmdir()
        self.assertIn(".githooks", self.start(self.repo))

    def test_canopi_f47t_52_228_10_session_start_warns_on_husky_prepare_without_husky_0(self):
        write_package(self.repo, HUSKY_PACKAGE)
        self.assertIn("HUSKY=0", self.start(self.repo))
        self.assertEqual(self.start(self.repo, {"HUSKY": "0"}).strip(), "")

    def test_canopi_f47t_52_228_10_session_start_never_blocks_on_garbage(self):
        result = run_hook("session-start", "garbage", self.repo)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
