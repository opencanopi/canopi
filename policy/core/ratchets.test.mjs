// The refusal texts the checker prints (REFUSALS): a user reads each one when a run is refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFUSALS } from './ratchets.mjs';

test('canopi-f47t.52.228.54: no refusal text repeats a word back to back', () => {
  const doubled = Object.entries(REFUSALS)
    .filter(([, text]) => /\b(\w+) \1\b/i.test(text))
    .map(([code]) => code);
  assert.deepEqual(doubled, []);
});
