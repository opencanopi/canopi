// policy/adapters/agent-hooks.mjs: the agent hooks' refusals as sites (2.1-M196, 2.1-M219; contracts §12; 2.1-M225).
//
// The hook rules in policy/rules.json (tool `agent-hooks`, no family) fire on their planted violations through the real
// hook: each policy/fixtures/rules/<rule>/command.json is a PreToolUse input, and one `node policy/gate/cli.mjs
// agent-hook planted` process (policy/gate/agent-hooks.ts) answers them all. A deny or ask reports a site whose rule is
// the id its reason starts with (`[<id>] …`), so check.mjs's planted runner sees each rule fire only when the hook names
// it; a pass reports nothing. The hook itself runs in Claude Code sessions (.claude/settings.json); nothing here runs in
// the default check.
import path from 'node:path';

const REASON_ID = /^\[([a-z0-9-]+)\] /;

export async function collect({ root, paths, exec }) {
  const inputs = paths.filter((p) => path.basename(p) === 'command.json').sort();
  if (!inputs.length) return [];
  const { status, stdout, stderr } = exec(process.execPath, [path.join(root, 'policy/gate/cli.mjs'), 'agent-hook', 'planted', ...inputs], { cwd: root });
  if (status !== 0) {
    throw Object.assign(new Error(`agent-hook planted exited ${status}: ${stderr.trim()}`), { code: 'tool-failed' });
  }
  const sites = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const { file, decision, reason } = JSON.parse(line);
    if (decision === 'error') throw Object.assign(new Error(`${file}: ${reason}`), { code: 'tool-failed' });
    const id = REASON_ID.exec(reason ?? '')?.[1];
    if (id && (decision === 'deny' || decision === 'ask')) sites.push({ rule: id, path: file });
  }
  return sites;
}
