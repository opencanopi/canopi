// policy/adapters/scenario-owners.test.mjs: the scenario owner matcher reads the layer table's moves through
// policy/core, as the ratchet diff does (2.1-M348; canopi-f47t.52.228.54).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { context, ownerOf } from './scenario-owners.mjs';

const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function repo(layers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-owners-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'policy'));
  fs.writeFileSync(path.join(root, 'policy/layers.json'), JSON.stringify({ layers }));
  fs.writeFileSync(path.join(root, 'policy/rules.json'), JSON.stringify({ phases: ['0', '1'], rules: [] }));
  return root;
}

test('a layer row written without its trailing slash moves the files under it, as the ratchet diff moves them', () => {
  const ctx = context(repo([{ path: 'app/old', destination: 'app/new' }]));
  assert.equal(ownerOf('app/old/x.ts', ['app/new/'], ctx.moves), 'app/new/');
});

test('a layer row whose destination is not a module path fails the run, naming the layer table', () => {
  assert.throws(() => context(repo([{ path: 'app/old/', destination: '../outside/' }])),
    (error) => error.code === 'tool-failed' && /layer-table/u.test(error.message));
});
