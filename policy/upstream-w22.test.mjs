// Pin test for upstream workaround W22 (uutils coreutils timeout on Ubuntu 26.04): verifies both mutation lanes
// (Stryker and cargo-mutants) prefer `gnutimeout` when installed and pass `--signal=INT --kill-after=5m`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './core/base.mjs';

// upstream: W22
test('pin: mutation.yml runs gnutimeout when installed for Stryker and cargo-mutants (W22)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/mutation.yml'), 'utf8');
  const lines = src.split('\n');
  const invocations = lines
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => text.startsWith('"$tm" --signal=INT --kill-after=5m "$BUDGET" '));

  assert.equal(invocations.length, 2, 'expected both Stryker and cargo-mutants to run under $tm');
  assert.ok(
    invocations.some(({ text }) => text.includes('npm run test:mutation')),
    'Stryker Mutate step must invoke $tm with --signal=INT --kill-after=5m',
  );
  assert.ok(
    invocations.some(({ text }) => text.includes('cargo mutants')),
    'cargo-mutants Mutate step must invoke $tm with --signal=INT --kill-after=5m',
  );

  for (const { line } of invocations) {
    const prev = lines[line - 2]?.trim() ?? '';
    const marker = lines[line - 3]?.trim() ?? '';
    assert.equal(prev, 'tm=$(command -v gnutimeout || command -v timeout)', `line ${line - 1} must prefer gnutimeout`);
    assert.equal(marker, '# upstream: W22', `line ${line - 2} must carry the W22 upstream marker`);
  }
});
