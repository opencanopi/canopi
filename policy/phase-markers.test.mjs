// policy/phase-markers.test.mjs: the stale "to be created by Phase N" markers --phase-close refuses (policy/phase-markers.mjs;
// canopi-f47t.52.258), on this repository at the Phase 0 close and on written repositories for where each points.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { REPO_ROOT } from './core/base.mjs';
import { loadTableRules } from './core/tables.mjs';
import { markerPhase, phaseMarkerRefusals } from './phase-markers.mjs';

const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-markers-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  return root;
}
const PHASES = ['F4', '0', '1a', '1', '2.0.4', '2a', '2m', '2', 'N1', '3'];

test('the docs leave no marker of a phase closed by the Phase 0 close (canopi-f47t.52.258)', () => {
  const refusals = phaseMarkerRefusals(REPO_ROOT, loadTableRules(REPO_ROOT).phases, '0');
  assert.deepEqual(refusals.map((r) => `${r.where}: ${r.message}`), []);
});

test('a marker names the latest part, a step after its phase, and no phase for a placeholder', () => {
  assert.deepEqual(['0', '3 N1', '0 F4', '1a and 2a', '2 (2m', '2.0.4', 'N', 'a later step'].map((t) => markerPhase(t, PHASES)),
    [1, 8, 0, 5, 7, 4, -1, -1]);
});

test('--phase-close points at each due marker by file and line, the ledgers left out', () => {
  const root = repo({
    'docs/adr/x.md': '# X\n- a (to be created by Phase 0; bans by Phase 3).\n- b (To be created by Phase 1). c (to be created by 2.0.4).\n- d (to be created by Phase 0 F4).\n',
    'AGENTS.md': 'e, to be created by Phase 2a.\n',
    'docs/decisions/2-1.md': '| 2.1-M1 | f (to be created by Phase 0) |\n',
    'notes.txt': 'to be created by Phase 0\n',
  });
  assert.deepEqual(phaseMarkerRefusals(root, PHASES, '1').map((r) => r.where), ['docs/adr/x.md:2', 'docs/adr/x.md:3', 'docs/adr/x.md:4']);
  assert.deepEqual(phaseMarkerRefusals(root, PHASES, 'later'), []);
});
