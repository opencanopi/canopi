// The refusal texts the checker prints (REFUSALS) and derived family loading/diffing (canopi-uxyr, 2.1-M530).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, SCHEMA_FILE } from './base.mjs';
import { diffRatchets } from './diff.mjs';
import { git } from './exec.mjs';
import { loadRatchets, REFUSALS } from './ratchets.mjs';
import { phaseCloseRefusals } from './tables.mjs';

test('canopi-f47t.52.228.54: no refusal text repeats a word back to back', () => {
  const doubled = Object.entries(REFUSALS)
    .filter(([, text]) => /\b(\w+) \1\b/i.test(text))
    .map(([code]) => code);
  assert.deepEqual(doubled, []);
});

test('canopi-uxyr: loadRatchets derives headers from rules.json for empty and shrunk ast-grep/dependency-cruiser families', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-uxyr-'));
  try {
    const write = (rel, content) => {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    };
    write(SCHEMA_FILE, fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8'));
    write('policy/adapters/ast-grep.mjs', '');
    write('policy/adapters/dependency-cruiser.mjs', '');
    write('desktop/web/src/a.ts', 'export const a = 1;\n');
    write('policy/rules.json', {
      version: 1,
      phases: ['2g'],
      rules: [
        { id: 'empty-rule', tool: 'ast-grep', ledger: '2.1-M530', family: 'empty-rule' },
        { id: 'shrunk-rule', tool: 'dependency-cruiser', ledger: '2.1-M530', family: 'shrunk-rule', scope: ['desktop/web/src/**'] },
      ],
    });
    write('policy/ratchets/shrunk-rule.json', {
      $schema: './ratchet.schema.json',
      family: 'shrunk-rule',
      entries: { 'a.ts -> b.ts': { count: 1 } },
    });
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    const { families, refusals } = loadRatchets(root);
    assert.deepEqual(refusals, []);
    assert.deepEqual(families.get('empty-rule')?.doc, {
      version: 1, family: 'empty-rule', ledger: '2.1-M530', tool: 'ast-grep',
      scope: ['desktop/web/src/**'], lane: 'commit', keys: 'path', select: ['empty-rule'], entries: {},
    });
    assert.equal(families.get('shrunk-rule')?.doc.keys, 'name');
    assert.deepEqual(families.get('shrunk-rule')?.doc.entries, { 'a.ts -> b.ts': { count: 1 } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canopi-uxyr: diffRatchets treats emptied derived file deletion as removed and scope edits in rules.json as header changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-uxyr-diff-'));
  try {
    const write = (rel, content) => {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    };
    const rules = (scope) => ({
      version: 1,
      phases: ['2g'],
      rules: [
        { id: 'fam-a', tool: 'ast-grep', ledger: '2.1-M530', family: 'fam-a', ...(scope ? { scope } : {}) },
      ],
    });
    write('policy/rules.json', rules());
    write('policy/ratchets/fam-a.json', { family: 'fam-a', entries: { 'desktop/web/src/a.ts': { count: 1 } } });
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'base']);
    git(root, ['tag', 'base']);
    // Deleting the emptied derived family file while the rule stays in rules.json is `removed`, not `deleted`.
    git(root, ['rm', '-q', 'policy/ratchets/fam-a.json']);
    const afterDelete = await diffRatchets(root, 'base');
    assert.deepEqual(afterDelete.map((c) => c.change), ['removed']);
    // Narrowing scope in rules.json without touching a family file produces a `header` change.
    write('policy/rules.json', rules(['desktop/web/src/app/**']));
    const afterScope = await diffRatchets(root, 'base');
    assert.ok(afterScope.some((c) => c.change === 'header' && c.family === 'fam-a' && c.fields?.includes('scope')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canopi-0kjje: --phase-close 4 refuses beadless entries in non-standing violation families', () => {
  const tables = { phases: ['2', '3', '4'], rules: new Map(), planned: new Map() };
  const families = new Map([
    ['unbeaded', { file: 'policy/ratchets/unbeaded.json', doc: { family: 'unbeaded', entries: { 'a.ts': { count: 1 } } } }],
    ['standing-fam', { file: 'policy/ratchets/standing-fam.json', doc: { family: 'standing-fam', standing: true, entries: { 'b.ts': { count: 1 } } } }],
    ['beaded-fam', { file: 'policy/ratchets/beaded-fam.json', doc: { family: 'beaded-fam', bead: 'canopi-a', entries: { 'c.ts': { count: 1 } } } }],
  ]);
  assert.deepEqual(phaseCloseRefusals(tables, '2', families), []);
  const at4 = phaseCloseRefusals(tables, '4', families);
  assert.equal(at4.length, 1);
  assert.equal(at4[0].code, 'phase-close');
  assert.match(at4[0].message, /unbeaded/);
});
