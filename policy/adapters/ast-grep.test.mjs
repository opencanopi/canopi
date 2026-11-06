// policy/adapters/ast-grep.mjs's shared scan (canopi-f47t.52.240): a check run holds about a hundred ast-grep families,
// and each scanned the whole rule set again over its own scope; one scan of the families' union now serves them all,
// each family reading only the sites in its own paths, as its own scan would give.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collect } from './ast-grep.mjs';

function plantedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grep-shared-'));
  fs.writeFileSync(path.join(root, 'sgconfig.yml'), 'ruleDirs:\n  - rules\n');
  fs.mkdirSync(path.join(root, 'rules'));
  fs.writeFileSync(path.join(root, 'rules/r.typescript.yml'), 'id: r.typescript\n');
  fs.mkdirSync(path.join(root, 'desktop/web/node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desktop/web/node_modules/.bin/ast-grep'), '');
  return root;
}

test('canopi-f47t.52.240: families sharing a run scan once over their union, each reading the sites of its own paths', () => {
  const root = plantedRoot();
  try {
    const scans = [];
    const exec = (_bin, args) => {
      const paths = args.slice(4);
      scans.push(paths);
      return { status: 0, stdout: paths.map((file) => JSON.stringify({ ruleId: 'r.typescript', file, severity: 'warning' })).join('\n'), stderr: '' };
    };
    const shared = { union: ['a.ts', 'b.ts', 'c.ts'] };
    const first = collect({ root, paths: ['a.ts', 'b.ts'], exec, shared });
    const second = collect({ root, paths: ['c.ts'], exec, shared });
    assert.deepEqual(scans, [['a.ts', 'b.ts', 'c.ts']]);
    assert.deepEqual(first, [{ rule: 'r', path: 'a.ts' }, { rule: 'r', path: 'b.ts' }]);
    assert.deepEqual(second, [{ rule: 'r', path: 'c.ts' }]);
    assert.deepEqual(second, collect({ root, paths: ['c.ts'], exec }), 'the shared reading equals the family\'s own scan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canopi-f47t.52.240: unreadable: a shared scan that fails fails every family that reads it', () => {
  const root = plantedRoot();
  try {
    let runs = 0;
    const exec = () => { runs += 1; return { status: 2, stdout: '', stderr: 'boom' }; };
    const shared = { union: ['a.ts', 'b.ts'] };
    assert.throws(() => collect({ root, paths: ['a.ts'], exec, shared }), { code: 'tool-failed' });
    assert.throws(() => collect({ root, paths: ['b.ts'], exec, shared }), { code: 'tool-failed' });
    assert.equal(runs, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
