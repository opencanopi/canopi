// policy/adapters/commit-gate.mjs: the commit gate's refusals as sites (contracts §12; 2.1-M195 to 2.1-M199, 2.1-M225).
//
// The gate rules in policy/rules.json (tool `commit-gate`, no family) fire on their planted violations through the real
// gate: each policy/fixtures/rules/<rule>/case.json holds base files, head files and a message (and `mode: tree` for a
// push to main), and one `scripts/commit_gate.py planted` process judges them all, each in a temporary repository
// outside the calling tree holding this checkout's gate and policy/. A site is reported for each rule id the gate
// names, so check.mjs's planted runner sees a rule fire only when the gate refuses by it. The gate itself runs in the
// tracked hooks and CI's Commit gate job; nothing here runs in the default check.
import path from 'node:path';

export async function collect({ root, paths, exec }) {
  const cases = paths.filter((p) => path.basename(p) === 'case.json').sort();
  if (!cases.length) return [];
  const { status, stdout, stderr } = exec('python3', [path.join(root, 'scripts/commit_gate.py'), 'planted', ...cases], { cwd: root });
  if (status !== 0) {
    throw Object.assign(new Error(`scripts/commit_gate.py planted exited ${status}: ${stderr.trim()}`), { code: 'tool-failed' });
  }
  return stdout.split('\n').filter(Boolean).flatMap((line) => {
    const { file, rules } = JSON.parse(line);
    return rules.map((rule) => ({ rule, path: file }));
  });
}
