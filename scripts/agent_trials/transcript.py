"""The one reader of Claude Code transcripts (.jsonl): the trial scorer and the tools repo's retro-tokens.py read them
through it (settlement 2026-10-26).

scan(path) gives retro-tokens' rows: requests [timestamp, model, effort, input, cache write 5m, cache write 1h, cache
read, output, thinking] (one per message id, synthetic messages left out) and tool results [request index, tool,
chars, image tokens, argument]. metrics(path, worktree) gives a trial's transcript metrics:

- files_read: the distinct files read, by the Read tool or by a shell reader (cat, head, tail, sed, nl, less) in a
  Bash command, made relative to the worktree when under it;
- tokens: input, cache_write, cache_read, output and their total over the requests;
- gate_failures: the failed gate commands (a Bash call running a gate whose result is an error) before the last
  passing one, all of them when none passed; gate_green: whether one passed.

ends_in_usage_limit(path) says whether the transcript's last assistant message is the usage-limit stop (a synthetic
rate_limit error, "You've hit your ... limit"): such a run stopped part-way, so the scorer leaves it unscored.
"""
import base64
import json
import re
import shlex
import struct

GATE = re.compile(
    r"\bnpm run (?:typecheck|test(?::[\w:-]+)?|check:[\w-]+|build(?::[\w-]+)?|lint)\b|\bnpx (?:vitest|playwright|tsc)\b"
    r"|\bcargo (?:test|clippy|fmt|cov)\b|\bpython3? -m unittest\b|quiet-gates\.sh|check_docs\.py|test:policies")
USAGE_LIMIT = re.compile(r"hit your (?:\w+ )?limit|usage limit", re.I)
SHELL_READERS = {"cat", "head", "tail", "sed", "nl", "less"}
PATHLIKE = re.compile(r"[\w./@~+-]*[A-Za-z_][\w./@~+-]*\.[A-Za-z0-9]{1,8}")


def png_tokens(b64):
    """An image's token estimate from its PNG size (w * h / 750, capped), else from its byte size."""
    try:
        raw = base64.b64decode(b64[:64] + "=" * (-len(b64[:64]) % 4))
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", raw[16:24])
            return min(w * h / 750, 1600 * 2.5)
    except (ValueError, struct.error):
        pass
    return len(b64) * 3 / 4 / 750


def _argument(name, inp):
    if name == "Read":
        part = inp.get("limit") or inp.get("offset") or inp.get("pages")
        return ("part " if part else "whole ") + str(inp.get("file_path", "")).split("canopi/")[-1]
    if name == "Bash":
        return str(inp.get("command", ""))[:160].replace("\t", " ").replace("\n", " ")
    return ""


def walk(path):
    """One pass over a transcript: (requests, results, calls, last assistant line). A call is {id, name, input,
    is_error} in order, is_error None until its result is read."""
    reqs, results, calls, seen, last = [], [], {}, set(), None
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get("message")
            if not isinstance(m, dict):
                continue
            content = m.get("content") if isinstance(m.get("content"), list) else []
            if d.get("type") == "assistant":
                last = d
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        calls[b.get("id")] = {"id": b.get("id"), "name": b.get("name", "?"), "input": b.get("input") or {}, "is_error": None}
                u = m.get("usage")
                if u and m.get("model") != "<synthetic>" and m.get("id") not in seen:
                    seen.add(m.get("id"))
                    cc = u.get("cache_creation") or {}
                    cw = u.get("cache_creation_input_tokens", 0) or 0
                    cw1 = cc.get("ephemeral_1h_input_tokens", 0) or 0
                    cw5 = cc.get("ephemeral_5m_input_tokens", 0) if cc else cw
                    reqs.append([d.get("timestamp", ""), m.get("model", "?"), d.get("effort") or "", u.get("input_tokens", 0) or 0,
                                 cw5 or 0, cw1, u.get("cache_read_input_tokens", 0) or 0, u.get("output_tokens", 0) or 0,
                                 (u.get("output_tokens_details") or {}).get("thinking_tokens", 0) or 0])
            elif d.get("type") == "user":
                for b in content:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    call = calls.get(b.get("tool_use_id"))
                    if call is not None:
                        call["is_error"] = bool(b.get("is_error"))
                    name, arg = (call["name"], _argument(call["name"], call["input"])) if call else ("?", "")
                    chars, img = 0, 0.0
                    c = b.get("content")
                    for part in c if isinstance(c, list) else [c]:
                        if isinstance(part, str):
                            chars += len(part)
                        elif isinstance(part, dict) and part.get("type") == "text":
                            chars += len(part.get("text", ""))
                        elif isinstance(part, dict) and part.get("type") == "image":
                            img += png_tokens((part.get("source") or {}).get("data", ""))
                    results.append([len(reqs), name, chars, round(img), arg])
    return reqs, results, list(calls.values()), last


def scan(path):
    """retro-tokens' request and tool-result rows (see the module header)."""
    reqs, results, _, _ = walk(path)
    return reqs, results


def ends_in_usage_limit(path):
    """Whether the last assistant message is a usage-limit stop (see the module header)."""
    last = walk(path)[3]
    if not last or (last.get("message") or {}).get("model") != "<synthetic>":
        return False
    text = " ".join(b.get("text", "") for b in last["message"].get("content") or [] if isinstance(b, dict))
    return last.get("error") == "rate_limit" or bool(USAGE_LIMIT.search(text))


def _relative(path, worktree):
    if worktree and path.startswith(worktree.rstrip("/") + "/"):
        return path[len(worktree.rstrip("/")) + 1:]
    return path


def shell_reads(command):
    """The files a Bash command reads with a shell reader (cat, head, tail, sed, nl, less)."""
    out = []
    for segment in re.split(r"&&|\|\||[;|\n]", command):
        try:
            words = shlex.split(segment)
        except ValueError:
            words = segment.split()
        if not words or words[0] not in SHELL_READERS:
            continue
        out += [w for w in words[1:] if not w.startswith("-") and PATHLIKE.fullmatch(w)]
    return out


def metrics(path, worktree=None):
    """A trial's transcript metrics (see the module header)."""
    reqs, _, calls, _ = walk(path)
    read = set()
    for call in calls:
        if call["name"] == "Read" and call["input"].get("file_path"):
            read.add(_relative(str(call["input"]["file_path"]), worktree))
        elif call["name"] == "Bash":
            read.update(_relative(p, worktree) for p in shell_reads(str(call["input"].get("command", ""))))
    gate_runs = [c["is_error"] for c in calls if c["name"] == "Bash" and c["is_error"] is not None
                 and GATE.search(str(c["input"].get("command", "")))]
    greens = [i for i, failed in enumerate(gate_runs) if not failed]
    before = gate_runs[:greens[-1]] if greens else gate_runs
    tokens = {"input": sum(r[3] for r in reqs), "cache_write": sum(r[4] + r[5] for r in reqs),
              "cache_read": sum(r[6] for r in reqs), "output": sum(r[7] for r in reqs)}
    tokens["total"] = sum(tokens.values())
    return {"files_read": len(read), "files_read_list": sorted(read), "tokens": tokens,
            "gate_failures": sum(1 for failed in before if failed), "gate_green": bool(greens)}
