"""Behaviour of the one transcript reader: requests, tool results, files read, tokens, gate failures, usage limit."""
import json
import tempfile
import unittest
from pathlib import Path

from . import transcript

WT = "/work/wt-trial-t8"


def assistant(msg_id, uses=(), usage=None, model="claude-opus-5-5", text=None, **extra):
    content = [{"type": "tool_use", "id": i, "name": n, "input": inp} for i, n, inp in uses]
    if text:
        content.append({"type": "text", "text": text})
    message = {"id": msg_id, "model": model, "role": "assistant", "content": content}
    if usage is not None:
        message["usage"] = usage
    return {"type": "assistant", "timestamp": "2026-10-27T10:00:00Z", "message": message, **extra}


def result(use_id, text="ok", is_error=False):
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": use_id, "content": text, "is_error": is_error}]}}


def usage(inp=10, write=100, read=1000, out=50):
    return {"input_tokens": inp, "cache_creation_input_tokens": write, "cache_read_input_tokens": read, "output_tokens": out,
            "cache_creation": {"ephemeral_5m_input_tokens": write, "ephemeral_1h_input_tokens": 0}}


def write_transcript(lines):
    tmp = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    tmp.write("".join(json.dumps(line) + "\n" for line in lines))
    tmp.close()
    return Path(tmp.name)


class TranscriptTest(unittest.TestCase):
    def read(self, lines):
        path = write_transcript(lines)
        self.addCleanup(path.unlink)
        return transcript.metrics(path, worktree=WT)

    def test_files_read_by_the_read_tool_and_shell_readers_count_once_each(self):
        m = self.read([
            assistant("a", [("u1", "Read", {"file_path": f"{WT}/desktop/web/src/a.ts"}),
                            ("u2", "Bash", {"command": f"cd {WT} && sed -n 1,40p desktop/web/src/b.tsx | head -5"}),
                            ("u3", "Read", {"file_path": f"{WT}/desktop/web/src/a.ts", "offset": 10})], usage()),
            result("u1"), result("u2"), result("u3"),
        ])
        self.assertEqual(m["files_read"], 2)
        self.assertEqual(m["files_read_list"], ["desktop/web/src/a.ts", "desktop/web/src/b.tsx"])

    def test_tokens_sum_every_request_once(self):
        m = self.read([assistant("a", usage=usage()), assistant("a", usage=usage()), assistant("b", usage=usage(out=150))])
        self.assertEqual(m["tokens"], {"input": 20, "cache_write": 200, "cache_read": 2000, "output": 200, "total": 2420})

    def test_gate_failures_count_failed_gate_commands_before_the_last_green_one(self):
        m = self.read([
            assistant("a", [("g1", "Bash", {"command": "cd desktop/web && npm run typecheck"})], usage()), result("g1", "error", True),
            assistant("b", [("x1", "Bash", {"command": "grep -n foo src/a.ts"})], usage()), result("x1", "", True),
            assistant("c", [("g2", "Bash", {"command": "npx vitest run src/a.test.ts"})], usage()), result("g2", "fail", True),
            assistant("d", [("g3", "Bash", {"command": "npm run typecheck && npx vitest run src/a.test.ts"})], usage()), result("g3"),
            assistant("e", [("g4", "Bash", {"command": "npm run test:policies"})], usage()), result("g4", "fail", True),
        ])
        self.assertEqual(m["gate_failures"], 2)
        self.assertTrue(m["gate_green"])

    def test_no_green_gate_counts_every_failure_and_says_so(self):
        m = self.read([assistant("a", [("g1", "Bash", {"command": "cargo test -p canopi-desktop"})], usage()), result("g1", "x", True)])
        self.assertEqual((m["gate_failures"], m["gate_green"]), (1, False))

    def test_scan_keeps_the_request_and_result_rows_retro_tokens_reads(self):
        path = write_transcript([assistant("a", [("u1", "Read", {"file_path": f"{WT}/x.ts"})], usage()), result("u1", "abcd")])
        self.addCleanup(path.unlink)
        reqs, results = transcript.scan(path)
        self.assertEqual(reqs, [["2026-10-27T10:00:00Z", "claude-opus-5-5", "", 10, 100, 0, 1000, 50, 0]])
        self.assertEqual(results, [[1, "Read", 4, 0, f"whole {WT}/x.ts"]])


class UsageLimitTest(unittest.TestCase):
    def test_a_transcript_ending_in_a_usage_limit_stop_is_recognised(self):
        stop = assistant("s", model="<synthetic>", text="You've hit your session limit · resets 11:10am (Europe/Paris)",
                         isApiErrorMessage=True, error="rate_limit")
        path = write_transcript([assistant("a", usage=usage()), stop])
        self.addCleanup(path.unlink)
        self.assertTrue(transcript.ends_in_usage_limit(path))

    def test_a_limit_hit_earlier_and_resumed_is_no_stop(self):
        stop = assistant("s", model="<synthetic>", text="You've hit your weekly limit · resets Oct 5, 7pm", isApiErrorMessage=True, error="rate_limit")
        path = write_transcript([stop, assistant("a", usage=usage(), text="done")])
        self.addCleanup(path.unlink)
        self.assertFalse(transcript.ends_in_usage_limit(path))


if __name__ == "__main__":
    unittest.main()
