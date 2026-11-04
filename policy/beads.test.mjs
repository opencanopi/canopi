// policy/beads.test.mjs: the tracker export reader and the absent-bead refusal (policy/beads.mjs) on this repository and
// on written repositories, with the export's failure states: absent (skipped) and a malformed line (refused, naming the
// line) (design check AR10; canopi-f47t.52.228.54). The checker's planted cases (policy/fixtures/check/repo/absent-bead-*)
// cover the codes; these pin where each refusal points.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { absentBeadRefusals, closedBeadCheck, trackerExport } from './beads.mjs';
import { REPO_ROOT } from './core/base.mjs';
import { loadRatchets } from './core/ratchets.mjs';
import { loadTableRules } from './core/tables.mjs';

const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A git work tree holding `files` ({path: text}), every file staged. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-beads-'));
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
const lines = (refusals) => refusals.map((r) => `${r.code}: ${r.where}: ${r.message.split(' is ')[0]}`);
/** A bead id spelt so this file's own titles and strings cite none: the repository check reads them too. */
const id = (hash) => ['canopi', hash].join('-');
const EXPORT = '{"id": "canopi-ab1", "status": "open"}\n';
const LEDGER = "| id | date | decision | user's words | supersedes / superseded by | implemented by |\n|---|---|---|---|---|---|\n";

test('the repository cites only beads its tracker export holds, held by the checker\'s absent-bead refusal (canopi-f47t.52.228.54)', () => {
  const exported = trackerExport(REPO_ROOT);
  assert.equal(exported.present, true);
  assert.deepEqual(lines([...exported.refusals, ...absentBeadRefusals(REPO_ROOT, loadRatchets(REPO_ROOT).families, loadTableRules(REPO_ROOT), exported)]), []);
});

test('unreadable: with no tracker export the absent-bead check is skipped, a planted repository citing anything', () => {
  const root = repo({ 'docs/decisions/2-1.md': `${LEDGER}| 2.1-M1 | 2026-11-04 | ${id('zz9')} | | | |\n`, 'a.test.ts': `it('x (${id('zz8')})', () => {})\n` });
  const exported = trackerExport(root);
  assert.deepEqual([exported.present, exported.statuses.size, exported.refusals], [false, 0, []]);
  assert.deepEqual(closedBeadCheck(root), []);
});

test('unreadable: a malformed export line is refused naming its line, never skipped', () => {
  const root = repo({ '.beads/issues.jsonl': `${EXPORT}\n{"id": "canopi-ab2", "status": "clo\n["canopi-ab3"]\n` });
  assert.deepEqual(trackerExport(root).refusals.map((r) => `${r.code}: ${r.where}`), ['unreadable: .beads/issues.jsonl:3', 'unreadable: .beads/issues.jsonl:4']);
});

test('absent-bead points at the ledger line and the test title, never at prose or a test body', () => {
  const root = repo({
    '.beads/issues.jsonl': EXPORT,
    'docs/decisions/2-1.md': `Prose names canopi-pr0.\n\n${LEDGER}| 2.1-M1 | 2026-11-04 | Paid by canopi-zz9.2 and canopi-ab1. | | | |\n`,
    'src/a.test.tsx': `it.each([1])('keeps \\'it\\' (${id('zz8')})', () => { const body = '${id('bd0')}' })\n`,
    'e2e/b.spec.ts': `test.describe(\`chrome ${id('zz7')}\`, () => {})\n`,
    'src/c.ts': `it('not a test file (${id('zz6')})')\n`,
  });
  assert.deepEqual(lines(closedBeadCheck(root)), [
    'absent-bead: docs/decisions/2-1.md: line 5: canopi-zz9.2',
    'absent-bead: e2e/b.spec.ts: line 1 title: canopi-zz7',
    'absent-bead: src/a.test.tsx: line 1 title: canopi-zz8',
  ]);
});

test('absent-bead leaves out the workspace crates by name and a crate named by a word', () => {
  const root = repo({
    '.beads/issues.jsonl': EXPORT,
    'Cargo.toml': '[workspace]\nmembers = ["app"]\n',
    'app/Cargo.toml': '[package]\nname = "canopi-app"\n',
    'docs/decisions/2-1.md': `${LEDGER}| 2.1-M1 | 2026-11-04 | canopi-app, canopi-format, canopi-core.db | | | |\n`,
  });
  assert.deepEqual(closedBeadCheck(root), []);
});
