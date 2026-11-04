// policy/adapters/jscpd.test.mjs: jscpd's report read as one site per clone, keyed by its sorted file pair, so a clone
// can carry its own bead in the jscpd-clones family (canopi-f47t.52.257, design check AR10). Failure state: retried, the
// same pair reported in either file order reads as one key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from './jscpd.mjs';

const root = '/repo';
const report = (...pairs) => JSON.stringify({
  statistics: { total: { sources: 3 } },
  duplicates: pairs.map(([a, b, start]) => ({ firstFile: { name: `${root}/${a}`, start }, secondFile: { name: `${root}/${b}`, start: 1 } })),
});

test('retried: a clone pair reported in either file order reads as one sorted key', () => {
  const sites = parse(report(['src/b.ts', 'src/a.ts', 4], ['src/a.ts', 'src/b.ts', 9], ['src/c.ts', 'src/c.ts', 2]), { root, given: 3 });
  assert.deepEqual(sites.map((s) => `${s.name} @ ${s.path}:${s.line}`), [
    'src/a.ts <-> src/b.ts @ src/b.ts:4',
    'src/a.ts <-> src/b.ts @ src/a.ts:9',
    'src/c.ts <-> src/c.ts @ src/c.ts:2',
  ]);
});

test('a clone naming no second file is tool-failed, never a key of one file', () => {
  const text = JSON.stringify({ statistics: { total: { sources: 1 } }, duplicates: [{ firstFile: { name: `${root}/src/a.ts`, start: 1 } }] });
  assert.throws(() => parse(text, { root, given: 1 }), (error) => error.code === 'tool-failed' && /second file/.test(error.message));
});
