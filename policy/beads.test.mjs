// policy/beads.test.mjs: the tracker export reader and the absent-bead refusal (policy/beads.mjs) on this repository and
// on written repositories, with the export's failure states: absent (skipped) and a malformed line (refused, naming the
// line) (design check AR10; canopi-f47t.52.228.54). The checker's planted cases (policy/fixtures/check/repo/absent-bead-*)
// cover the codes; these pin where each refusal points.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absentBeadRefusals, closedBeadCheck, textBeads, trackerExport } from './beads.mjs';
import { REPO_ROOT } from './core/base.mjs';
import { writtenRepo } from './core/test-repo.mjs';
import { loadRatchets } from './core/ratchets.mjs';
import { loadTableRules } from './core/tables.mjs';

const repo = (files) => writtenRepo(files, 'policy-beads-');
const lines = (refusals) => refusals.map((r) => `${r.code}: ${r.where}: ${r.message.split(' is ')[0]}`);
/** A bead id spelt so this file's own titles and strings cite none: the repository check reads them too. */
const id = (hash) => ['canopi', hash].join('-');
const EXPORT = '{"id": "canopi-ab1", "status": "open"}\n';
const LEDGER = "| id | date | decision | user's words | supersedes / superseded by | implemented by |\n|---|---|---|---|---|---|\n";

test('the repository cites only beads its tracker export holds, held by the checker\'s absent-bead refusal (canopi-f47t.52.228.54)', () => {
  const exported = trackerExport(REPO_ROOT);
  assert.equal(exported.present, true);
  assert.deepEqual(lines([...exported.refusals, ...absentBeadRefusals(loadRatchets(REPO_ROOT).families, loadTableRules(REPO_ROOT), exported)]), []);
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

test('a ledger cell or test title citing a bead the export dropped is history: absent-bead reads only the beads the policy files cite (canopi-f47t.52.228.54)', () => {
  const root = repo({
    '.beads/issues.jsonl': EXPORT,
    'docs/decisions/2-1.md': `${LEDGER}| 2.1-M1 | 2026-11-04 | Paid by ${id('zz9')}.2. | | | |\n`,
    'src/a.test.tsx': `it('keeps it (${id('zz8')})', () => {})\n`,
  });
  assert.deepEqual(closedBeadCheck(root), []);
});

test('textBeads reads the ledger\'s table cells and the test titles with their lines, never prose, a code span or a test body', () => {
  const ledger = `Prose names ${id('pr0')}.\n\n${LEDGER}| 2.1-M1 | 2026-11-04 | Paid by ${id('zz9')}.2 and ${id('ab1')}, not \`${id('library')}\`. | | | |\n`;
  assert.deepEqual(textBeads('docs/decisions/2-1.md', ledger), [{ bead: id('zz9.2'), at: 'line 5' }, { bead: id('ab1'), at: 'line 5' }]);
  assert.deepEqual(textBeads('src/a.test.tsx', `it.each([1])('keeps \\'it\\' (${id('zz8')})', () => { const body = '${id('bd0')}' })\n`),
    [{ bead: id('zz8'), at: 'line 1 title' }]);
  assert.deepEqual(textBeads('e2e/b.spec.ts', `\ntest.describe(\`chrome ${id('zz7')}\`, () => {})\n`), [{ bead: id('zz7'), at: 'line 2 title' }]);
  assert.deepEqual(textBeads('src/c.ts', `it('not a test file (${id('zz6')})')\n`), []);
});
