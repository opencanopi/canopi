// policy/core/observe.test.mjs: checkPlanted holds each planted file of a family on its own (canopi-f47t.52.224).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT, SCHEMA_FILE } from './base.mjs';
import { checkPlanted } from './observe.mjs';

const PLANTED_HELPERS = 'policy/fixtures/rules/helpers.json';
import { writtenRepo } from './test-repo.mjs';

/** The planted case `name`'s files as a written repository, with this repository's ratchet schema. */
function caseRepo(name, extra = {}) {
  const kase = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'policy/fixtures/check/planted', name), 'utf8'));
  const files = Object.fromEntries(Object.entries(kase.files).map(([rel, v]) => [rel, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`]));
  files[SCHEMA_FILE] = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8');
  return writtenRepo({ ...files, ...extra });
}

test('canopi-f47t.52.224: a planted file that never fires is named by planted-silent, its firing sibling is not', async () => {
  const refusals = await checkPlanted(caseRepo('one-planted-file-silent.json'));
  assert.deepEqual(refusals.map((r) => [r.code, r.where]), [['planted-silent', 'policy/fixtures/rules/plants/c.ts']]);
});

test('canopi-f47t.52.224: a planted file declared a helper, with its reason, need not fire', async () => {
  const helpers = JSON.stringify({ plants: { 'c.ts': 'the clean half the planted file needs' } });
  assert.deepEqual(await checkPlanted(caseRepo('one-planted-file-silent.json', { [PLANTED_HELPERS]: helpers })), []);
});

test('canopi-f47t.52.224: a helper naming no planted file is a stray', async () => {
  const helpers = JSON.stringify({ plants: { 'c.ts': 'helper', 'gone.ts': 'renamed away' } });
  const refusals = await checkPlanted(caseRepo('one-planted-file-silent.json', { [PLANTED_HELPERS]: helpers }));
  assert.deepEqual(refusals.map((r) => [r.code, r.where]), [['stray-planted', PLANTED_HELPERS]]);
  assert.match(refusals[0].message, /plants\/gone\.ts/);
});
