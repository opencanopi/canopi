// policy/adapters/commit-gate.mjs: the commit gate's refusals as sites (contracts §12; 2.1-M195 to 2.1-M199, 2.1-M225).
//
// The gate rules in policy/rules.json (tool `commit-gate`, no family) fire on their planted violations through the real
// gate: each policy/fixtures/rules/<rule>/case.json holds base files, head files and a message (and `mode: tree` for a
// push to main), and policy/gate/commit-gate.ts's planted() judges each, in a temporary repository outside the calling
// tree holding this checkout's policy/, through the gate's entry (so on the engines Node). A site is reported for each
// rule id the gate names, so check.mjs's planted runner sees a rule fire only when the gate refuses by it. The gate
// itself runs in the tracked hooks and CI's Commit gate job; nothing here runs in the default check.
import path from 'node:path';

export async function collect({ root, paths }) {
  const cases = paths.filter((p) => path.basename(p) === 'case.json').sort();
  if (!cases.length) return [];
  const { planted } = await import('../gate/commit-gate.ts');
  try {
    return planted(root, cases).flatMap(({ file, rules }) => rules.map((rule) => ({ rule, path: file })));
  } catch (error) {
    throw Object.assign(new Error(`policy/gate/commit-gate.ts planted: ${error.message}`), { code: 'tool-failed' });
  }
}
