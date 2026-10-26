#!/usr/bin/env python3
"""Agent hooks for Claude Code sessions in Canopi (2.1-M196, 2.1-M219; ADR 0028 Agent enforcement).

    python3 scripts/agent_hooks.py pre-tool-use     PreToolUse JSON on stdin; prints a deny or ask decision, or nothing
    python3 scripts/agent_hooks.py session-start    SessionStart JSON on stdin; prints a warning when the hooks would
                                                    not run in this worktree; never blocks
    python3 scripts/agent_hooks.py planted <command.json>...
                                                    one JSON line per file, {file, decision, reason}: the planted runner
                                                    of policy/adapters/agent-hooks.mjs

A Bash command is split into simple commands (`&&`, `||`, `;`, `|`, `&`, newlines, parentheses), each read after its
environment assignments and wrapper words (`env`, `time`, `command`, ...); one level of `sh -c`, `bash -c` or
`bash -lc` is read, a deeper one asks. `cd` and `git -C` are followed to find the repository a git command targets:
the user's checkout is the main worktree of the session project's repository (`git rev-parse --git-common-dir`), and
another repository or a linked worktree is never it. What cannot be parsed asks; nothing here raises.

Each refusal's reason starts with its rule id in brackets (policy/rules.json, tool agent-hooks) and names the fix.
"""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

SEPARATORS = {"&&", "||", ";", "|", "&", "\n", "(", ")", ";;", "|&"}
WRAPPERS = {"time", "command", "exec", "nohup", "nice", "builtin"}
SHELLS = {"sh", "bash", "zsh", "dash"}
HOOKS_PATH = "core.hookspath"

FIX_GATE = "commit through the pre-commit gate; fix what it reports instead of skipping it"
REASONS = {
    "hook-no-verify": f"--no-verify skips the pre-commit gate (2.1-M196); {FIX_GATE}",
    "hook-plumbing-commit": f"git commit-tree makes a commit no hook sees (2.1-M196); use git commit, {FIX_GATE}",
    "hook-husky-skip": f"HUSKY=0 before a git command skips the hooks (2.1-M196); {FIX_GATE}",
    "hook-hooks-path-override": "this changes core.hooksPath, which must stay the shared relative .githooks (2.1-M14, "
                                "2.1-M196); only `git config core.hooksPath .githooks` may set it; install with HUSKY=0 "
                                "in a worktree that still has husky",
    "hook-bare-stash": "the stash stack is shared by every worktree (AGENTS.md, 2.1-M196); set work aside with a WIP "
                       "commit on your branch instead",
    "hook-user-checkout-commit": "this commits in the user's checkout (the main worktree, AGENTS.md); work in a "
                                 "worktree under .rq-scratch/, and update the checkout only by fetch and --ff-only",
    "hook-old-husky-install": "this package.json still runs husky's prepare, which rewrites the shared core.hooksPath "
                              "(2.1-M196); run HUSKY=0 npm ci (or HUSKY=0 npm install) instead",
    "hook-reset-hard-asks": "git reset --hard discards work (2.1-M219); proceed only if the user asked for it",
    "hook-discard-asks": "this discards uncommitted work (2.1-M219); proceed only if the user asked for it",
    "hook-stash-stack-asks": "this changes the shared stash stack (2.1-M219); proceed only if the user asked for it",
}
DENY = {"hook-no-verify", "hook-plumbing-commit", "hook-husky-skip", "hook-hooks-path-override", "hook-bare-stash",
        "hook-user-checkout-commit", "hook-old-husky-install"}

# git's global options that take a separate value.
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix",
                     "--config-env", "--list-cmds"}
# git commit's options that take a value: short ones end a cluster, long ones take the next word unless `=` is used.
COMMIT_SHORT_VALUE = set("mFcCt")
COMMIT_LONG_VALUE = {"--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message",
                     "--fixup", "--squash", "--trailer", "--cleanup", "--pathspec-from-file"}
COMMIT_CREATING = {"commit", "cherry-pick", "revert", "am", "rebase"}


class Unparsed(Exception):
    """A command this hook cannot read with confidence: it asks."""


def decision(rule, reason=None):
    return {"rule": rule, "decision": "deny" if rule in DENY else "ask",
            "reason": f"[{rule}] {reason or REASONS[rule]}"}


def unparsed(why):
    return {"rule": None, "decision": "ask", "reason": f"[agent-hooks] cannot read this command ({why}); ask the user"}


# --- tokenising -------------------------------------------------------------------------------------------------------

def tokens(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""  # strip_text removes comments the way bash reads them
    try:
        return list(lexer)
    except ValueError as error:
        raise Unparsed(str(error)) from error


HEREDOC = re.compile(r"<<(-?)[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")


WORD_START = set(" \t\r\n;&|()<>")


def strip_text(command):
    """`command` with its comments and here-document bodies removed, so a commit message's words and quotes are never
    read as commands; a body fed to a shell (`bash <<EOF`) stays, since the shell runs it. Quotes are tracked, so a `<<`
    or `#` inside a quoted string (`-m "$(cat <<'EOF' … EOF)"`) is part of that string. As in bash, a comment starts at
    a `#` that begins a word and ends before the newline, which still separates commands."""
    out, i, quote, pending = [], 0, None, []
    while i < len(command):
        c = command[i]
        if quote:
            if c == "\\" and quote == '"':
                out.append(command[i:i + 2])
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "\\":
            out.append(command[i:i + 2])
            i += 2
            continue
        elif c == "#" and (not out or out[-1] in WORD_START):
            end = command.find("\n", i)
            i = len(command) if end == -1 else end
            continue
        elif command.startswith("<<", i) and not command.startswith("<<<", i):
            match = HEREDOC.match(command, i)
            if match:
                line_start = command.rfind("\n", 0, i) + 1
                head = re.split(r"[;&|(]", command[line_start:i])[-1].split()
                words = [w for w in head if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w)]
                if not (words and os.path.basename(words[0]) in SHELLS):
                    pending.append((match.group(3), match.group(1) == "-"))
                out.append(match.group(0))
                i = match.end()
                continue
        elif c == "\n" and pending:
            out.append(c)
            i += 1
            for delimiter, tabs in pending:
                while i < len(command):
                    end = command.find("\n", i)
                    line = command[i:] if end == -1 else command[i:end]
                    i = len(command) if end == -1 else end + 1
                    if (line.lstrip("\t") if tabs else line) == delimiter:
                        break
            pending = []
            continue
        out.append(c)
        i += 1
    return "".join(out)


def segments(command):
    """The simple commands of `command`, each a list of words, in order."""
    out, current = [], []
    for token in tokens(strip_text(command)):
        # shlex groups a run of punctuation (`&&`, `)&&`, `\n\n`); a redirection such as `>` or `2>&1` is dropped.
        if token and all(c in "();<>|&\n" for c in token):
            if any(c in "();|&\n" for c in token.replace(">&", "").replace("<&", "")):
                if current:
                    out.append(current)
                current = []
            continue
        current.append(token)
    if current:
        out.append(current)
    return out


# --- context ----------------------------------------------------------------------------------------------------------

def git_out(cwd, *args):
    try:
        result = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=10,
                                env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")})
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def main_worktree(cwd):
    """The main worktree of the repository at `cwd` and that repository's common dir, or (None, None)."""
    common = git_out(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        return None, None
    common = Path(common).resolve()
    return (common.parent if common.name == ".git" else None), common


def project_dir():
    return Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[1])


def resolve(base, raw):
    """`raw` (a cd or -C argument) against `base`; None when either is unknown or a variable stays unexpanded."""
    if base is None:
        return None
    expanded = os.path.expanduser(os.path.expandvars(raw))
    if "$" in expanded or "`" in expanded:
        return None
    return Path(os.path.normpath(base / expanded))


class Context:
    def __init__(self, cwd, user_checkout):
        self.cwd = cwd
        self.env = {}
        self.user_checkout = user_checkout  # (main worktree, common dir) of the session project's repository

    def resolve(self, raw):
        return resolve(self.cwd, raw)

    def is_user_checkout(self, directory):
        """True when `directory` is in the main worktree of the session's repository; None when unknown."""
        main, common = self.user_checkout
        if directory is None:
            return None
        if main is None or not directory.exists():
            return False
        top = git_out(directory, "rev-parse", "--path-format=absolute", "--show-toplevel")
        here_main, here_common = main_worktree(directory)
        if not top or here_common is None:
            return False
        return here_common == common and Path(top).resolve() == main


# --- rules ------------------------------------------------------------------------------------------------------------

def strip_prefix(words, ctx):
    """Drops environment assignments and wrapper words; returns (words, assignments)."""
    env = {}
    i = 0
    while i < len(words):
        word = words[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", word):
            key, _, value = word.partition("=")
            env[key] = value
        elif word == "env":
            i += 1
            while i < len(words) and words[i].startswith("-"):
                i += 2 if words[i] in ("-u", "--unset", "-C", "--chdir", "-S") else 1
            continue
        elif word in WRAPPERS:
            pass
        elif word == "timeout":
            i += 1
            while i < len(words) and words[i].startswith("-"):
                i += 1
            i += 1  # the duration
            continue
        else:
            break
        i += 1
    return words[i:], env


def long_option(word, full, shortest):
    """True when `word` is `full` or an unambiguous prefix git accepts (at least `shortest`)."""
    name = word.split("=", 1)[0]
    return len(name) >= len(shortest) and full.startswith(name)


def commit_flags(args):
    """git commit's flags with option values skipped: yields each flag word and each short flag letter."""
    i = 0
    while i < len(args):
        word = args[i]
        if word == "--":
            return
        if word.startswith("--"):
            yield word
            if "=" not in word and word in COMMIT_LONG_VALUE:
                i += 1
        elif word.startswith("-") and len(word) > 1:
            for k, letter in enumerate(word[1:]):
                if letter in COMMIT_SHORT_VALUE:
                    if k == len(word) - 2:
                        i += 1
                    break
                yield f"-{letter}"
        i += 1


def check_git(words, ctx, env):
    i, target = 1, ctx.cwd
    while i < len(words) and words[i].startswith("-"):
        word = words[i]
        if word in GIT_VALUE_OPTIONS:
            value = words[i + 1] if i + 1 < len(words) else ""
            if word == "-C":
                target = resolve(target, value)
            if word == "-c" and value.split("=", 1)[0].lower() == HOOKS_PATH:
                return decision("hook-hooks-path-override")
            if word == "--config-env" and value.split("=", 1)[0].lower() == HOOKS_PATH:
                return decision("hook-hooks-path-override")
            i += 2
        else:
            if word.startswith("-c") and word[2:].split("=", 1)[0].lower() == HOOKS_PATH:
                return decision("hook-hooks-path-override")
            i += 1
    if i >= len(words):
        return None
    sub, args = words[i], words[i + 1:]
    if env.get("HUSKY") is not None or ctx.env.get("HUSKY") is not None:
        return decision("hook-husky-skip")
    for key, value in {**ctx.env, **env}.items():
        if key.startswith("GIT_CONFIG_KEY") and value.lower() == HOOKS_PATH:
            return decision("hook-hooks-path-override")

    if sub in ("commit", "push", "merge", "pull", "rebase", "cherry-pick", "revert", "am"):
        flags = list(commit_flags(args)) if sub == "commit" else [a for a in args if a.startswith("-")]
        if any(f.startswith("--no-v") and long_option(f, "--no-verify", "--no-v") for f in flags):
            return decision("hook-no-verify")
        if sub == "commit" and "-n" in flags:
            return decision("hook-no-verify")
    if sub == "commit-tree":
        return decision("hook-plumbing-commit")
    if sub == "config":
        return check_config(args)
    if sub == "stash":
        return check_stash(args)
    if sub == "reset" and "--hard" in args:
        return decision("hook-reset-hard-asks")
    if sub == "checkout" and ("--" in args or any(a in ("-f", "--force") for a in args)):
        return decision("hook-discard-asks")
    if sub == "switch" and any(a in ("-f", "--force", "--discard-changes") for a in args):
        return decision("hook-discard-asks")
    if sub == "restore":
        staged = any(a in ("--staged", "-S") for a in args)
        worktree = any(a in ("--worktree", "-W") for a in args)
        if not staged or worktree:
            return decision("hook-discard-asks")
    if sub == "clean" and any(a == "--force" or (re.match(r"^-[a-zA-Z]+$", a) and "f" in a) for a in args):
        return decision("hook-discard-asks")

    if sub in COMMIT_CREATING or sub in ("merge", "pull"):
        if sub in ("merge", "pull") and any(a in ("--ff-only", "--abort", "--quit") for a in args):
            return None
        if sub in ("rebase", "cherry-pick", "revert", "am") and any(a in ("--abort", "--quit") for a in args):
            return None
        mine = ctx.is_user_checkout(target)
        if mine is None:
            return unparsed("its repository depends on a variable")
        if mine:
            return decision("hook-user-checkout-commit")
    return None


def check_config(args):
    words = [a for a in args if not a.startswith("-")]
    flags = [a for a in args if a.startswith("-")]
    if words[:1] in (["set"], ["unset"]):
        verb, words = words[0], words[1:]
    else:
        verb = None
    if not words or words[0].lower() != HOOKS_PATH:
        return decision("hook-hooks-path-override") if "--edit" in flags or "-e" in flags else None
    if verb in (None, "set") and words[1:] == [".githooks"] and set(flags) <= {"--local"}:
        return None  # restoring the required value is SessionStart's fix for drift
    reads = {"--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"}
    if verb or len(words) > 1 or any(f in ("--unset", "--unset-all", "--add", "--replace-all") for f in flags):
        if not (set(flags) & reads) or verb:
            return decision("hook-hooks-path-override")
    return None


def check_stash(args):
    sub = args[0] if args and not args[0].startswith("-") else "push"
    if sub in ("push", "save"):
        return decision("hook-bare-stash")
    if sub in ("pop", "apply", "drop", "clear", "store", "branch"):
        return decision("hook-stash-stack-asks")
    return None


def husky_script(directory, name):
    package = directory / "package.json"
    try:
        scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts", {})
    except (OSError, ValueError, AttributeError):
        return False
    return isinstance(scripts, dict) and "husky" in str(scripts.get(name, ""))


def check_npm(args, ctx, env):
    directory = ctx.cwd
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] in ("--prefix", "-C") and i + 1 < len(args):
            directory = ctx.resolve(args[i + 1])
            i += 2
            continue
        i += 1
    if i >= len(args) or directory is None:
        return None
    verb, rest = args[i], args[i + 1:]
    skipped = (env.get("HUSKY") or ctx.env.get("HUSKY") or os.environ.get("HUSKY")) == "0"
    if verb in ("ci", "install", "i", "clean-install", "install-clean", "isntall", "add") and not skipped:
        if husky_script(directory, "prepare"):
            return decision("hook-old-husky-install")
    if verb in ("run", "run-script") and rest and not skipped and husky_script(directory, rest[0]):
        return decision("hook-hooks-path-override")
    if verb == "exec" and any(re.match(r"^husky(@|$)", a) for a in rest):
        return decision("hook-hooks-path-override")
    return None


def check_npx(args, ctx, env):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in ("-p", "--package") else 1
    if i >= len(args):
        return None
    program = args[i]
    if re.match(r"^husky(@|$)", program):
        return decision("hook-hooks-path-override")
    if re.match(r"^npm(@|$)", program):
        return check_npm(args[i + 1:], ctx, env)
    return None


def check_segment(words, ctx, depth):
    words, env = strip_prefix(words, ctx)
    if not words:
        ctx.env.update(env)  # a bare assignment sets the shell variable for the rest of the chain
        return None
    program = os.path.basename(words[0])
    if program == "cd":
        target = words[1] if len(words) > 1 else "~"
        ctx.cwd = None if target == "-" else ctx.resolve(target)
        return None
    if program == "export":
        for word in words[1:]:
            if "=" in word:
                key, _, value = word.partition("=")
                ctx.env[key] = value
        return None
    if program in SHELLS:
        script = next((words[k + 1] for k, w in enumerate(words[1:], 1)
                       if re.match(r"^-[a-z]*c[a-z]*$", w) and k + 1 < len(words)), None)
        if script is None:
            return None
        if depth >= 1:
            return unparsed("a shell -c inside a shell -c")
        return check_command(script, ctx, depth + 1)
    if program == "git":
        return check_git(words, ctx, env)
    if program == "npm":
        return check_npm(words[1:], ctx, env)
    if program == "npx":
        return check_npx(words[1:], ctx, env)
    if program == "husky":
        return decision("hook-hooks-path-override")
    return None


def check_command(command, ctx, depth=0):
    """The first deny in `command`, else its first ask, else None."""
    found = []
    for words in segments(command):
        result = check_segment(words, ctx, depth)
        if result:
            found.append(result)
            if result["decision"] == "deny":
                return result
    return found[0] if found else None


def decide(payload):
    """The decision for one PreToolUse payload: {decision, reason, rule} or None to say nothing."""
    if not isinstance(payload, dict):
        return unparsed("the hook input is not an object")
    if payload.get("tool_name") != "Bash":
        return None
    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str):
        return unparsed("no command")
    cwd = payload.get("cwd")
    ctx = Context(Path(cwd) if isinstance(cwd, str) and cwd else Path.cwd(), main_worktree(project_dir()))
    try:
        return check_command(command, ctx)
    except Unparsed as error:
        return unparsed(str(error))


def pre_tool_use(stdin):
    try:
        payload = json.loads(stdin)
    except ValueError:
        result = unparsed("the hook input is not JSON")
    else:
        try:
            result = decide(payload)
        except Exception as error:  # a hook bug asks rather than letting the command through or crashing
            result = unparsed(f"{type(error).__name__}: {error}")
    if result:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": result["decision"],
                                                 "permissionDecisionReason": result["reason"]}}))


# --- SessionStart -----------------------------------------------------------------------------------------------------

def session_warnings(worktree):
    top = git_out(worktree, "rev-parse", "--path-format=absolute", "--show-toplevel")
    if not top:
        return []
    top = Path(top)
    warnings = []
    hooks_path = git_out(top, "config", "--get", "core.hooksPath")
    if hooks_path != ".githooks":
        warnings.append(f"core.hooksPath is {hooks_path or 'unset'}, not .githooks: the pre-commit gate does not run. "
                        "Set it once for every worktree: git config core.hooksPath .githooks")
    if not (top / ".githooks").is_dir():
        warnings.append(f"{top} has no .githooks directory: commits here run no gate. Work in a worktree of the "
                        "integration branch or main")
    if os.environ.get("HUSKY") != "0" and husky_script(top / "desktop/web", "prepare"):
        warnings.append("desktop/web/package.json still runs husky's prepare: install with HUSKY=0 npm ci, or npm ci "
                        "rewrites core.hooksPath")
    return warnings


def session_start(stdin):
    try:
        payload = json.loads(stdin)
        cwd = payload.get("cwd") if isinstance(payload, dict) else None
        warnings = session_warnings(Path(cwd) if isinstance(cwd, str) and cwd else project_dir())
    except Exception as error:  # never block a session
        warnings = [f"agent_hooks.py session-start could not check the hooks: {type(error).__name__}: {error}"]
    for warning in warnings:
        print(f"Canopi hooks warning: {warning}")


# --- planted ----------------------------------------------------------------------------------------------------------

def planted(files):
    """Each planted PreToolUse input's decision. In its command and cwd, `{main_worktree}` names the session repository's
    checkout and `{dir}` the planted file's directory, so a case needs no machine's absolute path."""
    main, _ = main_worktree(project_dir())
    for name in files:
        try:
            payload = json.loads(Path(name).read_text(encoding="utf-8"))
            places = {"{main_worktree}": str(main or project_dir()), "{dir}": str(Path(name).resolve().parent)}

            def fill(text):
                for key, value in places.items():
                    text = text.replace(key, value) if isinstance(text, str) else text
                return text

            payload["cwd"] = fill(payload.get("cwd"))
            payload.setdefault("tool_input", {})["command"] = fill(payload["tool_input"].get("command"))
            result = decide(payload)
        except (OSError, ValueError, AttributeError, TypeError) as error:
            result = {"decision": "error", "rule": None, "reason": str(error)}
        result = result or {"decision": "pass", "rule": None, "reason": ""}
        print(json.dumps({"file": name, "decision": result["decision"], "reason": result["reason"]}))


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    if mode == "pre-tool-use":
        pre_tool_use(sys.stdin.read())
    elif mode == "session-start":
        session_start(sys.stdin.read())
    elif mode == "planted":
        planted(argv[2:])
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
