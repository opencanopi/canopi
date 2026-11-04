// policy/adapters/clippy.test.mjs: a commit-lane clippy family reads its sites from source and never runs cargo; only a
// family selecting clippy::disallowed_methods (push lane) asks clippy which method a site excuses (canopi-f47t.52.228.54).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeFamily } from '../core/observe.mjs';
import { writtenRepo } from '../core/test-repo.mjs';
import * as clippy from './clippy.mjs';

const SOURCE = [
  '#[expect(clippy::disallowed_methods, reason = "the shell spawns it")]',
  'fn spawn() {}',
  '#[expect(clippy::too_many_arguments, reason = "a planted site")]',
  'fn many(a: u8, b: u8, c: u8, d: u8, e: u8, f: u8, g: u8, h: u8) {}',
  '',
].join('\n');

const repo = () => writtenRepo({
  'Cargo.toml': '[workspace]\nmembers = ["crate"]\n',
  'crate/Cargo.toml': '[package]\nname = "planted"\nversion = "0.1.0"\n',
  'crate/src/lib.rs': SOURCE,
});

const noCargo = () => { throw new Error('cargo ran for a family that does not select clippy::disallowed_methods'); };

test('canopi-f47t.52.228.54: a commit-lane clippy family counts its lint from source without running cargo', () => {
  const sites = clippy.collect({ root: repo(), paths: ['crate/src/lib.rs'], exec: noCargo, select: ['clippy::too_many_arguments'] });
  assert.deepEqual(sites.map((s) => s.rule), ['clippy::too_many_arguments']);
});

test('canopi-f47t.52.228.54: the default check holds a commit-lane clippy family with no cargo on PATH', async () => {
  const root = repo();
  const doc = {
    version: 1, family: 'rust-too-many-arguments', ledger: '2.1-M188', tool: 'clippy', scope: ['**'], lane: 'commit',
    keys: 'path-rule', select: ['clippy::too_many_arguments'],
    entries: { 'crate/src/lib.rs: clippy:clippy::too_many_arguments': { count: 1 } },
  };
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const found = await observeFamily(root, 'policy/ratchets/rust-too-many-arguments.json', doc, ['crate/src/lib.rs'], clippy);
    assert.deepEqual(found, []);
  } finally {
    process.env.PATH = saved;
  }
});

test('a family selecting clippy::disallowed_methods still asks clippy which method each site excuses', () => {
  const asked = [];
  const exec = (command, args) => { asked.push([command, args[0]]); return { status: 0, stdout: '', stderr: '' }; };
  const sites = clippy.collect({ root: repo(), paths: ['crate/src/lib.rs'], exec, select: ['clippy::disallowed_methods'] });
  assert.deepEqual(asked, [['cargo', 'clippy']]);
  assert.deepEqual(sites.map((s) => s.rule), ['clippy::disallowed_methods']);
});
