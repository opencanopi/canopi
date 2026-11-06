// policy/adapters/flake-quarantine.test.mjs: the flake-quarantine family's static half through policy/core's observer
// (2.1-M203, 2.1-Q267; canopi-f47t.52.228.10): a marker naming no bead is refused whatever the baseline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAdapter, observeFamily } from '../core/observe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAMILY = 'policy/ratchets/flake-quarantine.json';

test('canopi-f47t.52.228.10: a flake-quarantine marker naming no bead is refused by the family', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-flake-'));
  try {
    const marker = 'flake-' + 'quarantine:';
    fs.writeFileSync(path.join(root, 'a.test.ts'),
      `// ${marker}\nit.skip('x', () => {})\n// ${marker} canopi-x.1\nit.skip('y', () => {})\n`);
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, FAMILY), 'utf8'));
    const found = await observeFamily(root, FAMILY, doc, ['a.test.ts'], await loadAdapter(REPO, doc.tool));
    assert.deepEqual(found.map((r) => r.code).sort(), ['refused-site', 'unlisted'], JSON.stringify(found));
    assert.match(found.find((r) => r.code === 'refused-site').message, /names no bead/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
