// policy/adapters/guarded-files.test.mjs: the guarded-files family's static half through policy/core's observer
// (2.1-Q225, 2.1-Q267; canopi-f47t.52.228.54): a listed file deleted or renamed leaves its entry stale.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAdapter, observeFamily } from '../core/observe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILY = 'policy/ratchets/guarded-files.json';

test('canopi-f47t.52.228.10: a guarded file deleted or renamed is stale', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, FAMILY), 'utf8'));
  assert.deepEqual(Object.keys(doc.entries).sort(),
    ['desktop/capabilities/main-window.json', 'policy/ratchets/bundle-size.json', 'policy/ratchets/coverage.json']);
  const found = await observeFamily(REPO, FAMILY, doc, ['policy/ratchets/bundle-size.json', 'policy/ratchets/coverage.json'],
    await loadAdapter(REPO, doc.tool));
  assert.deepEqual(found.map((r) => r.code), ['stale'], JSON.stringify(found));
  assert.match(found[0].message, /main-window\.json/u);
});
