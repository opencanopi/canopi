// policy/generate/knip.test.mjs: the names a `@testonly` tag may carry are the ones test-only-exports-only-in-tests
// guards (canopi-f47t.52.242); the generator's planted cases (policy/fixtures/generate/testonly-tag*) cover the refusal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './boundary-facts.mjs';

test('a tagged value export carries a name the test-only-exports-only-in-tests rule files guard (canopi-f47t.52.242)', () => {
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const regexes = ['typescript', 'tsx'].map((lang) => /^\s*regex:\s*(\S+)\s*$/mu.exec(read(`policy/ast-grep/rules/test-only-exports-only-in-tests.${lang}.yml`))?.[1]);
  const held = /^const TEST_ONLY_VALUE = \/(.+)\/u;$/mu.exec(read('policy/generate/knip.mjs'))?.[1];
  assert.equal(typeof held, 'string');
  assert.deepEqual(regexes, [held, held]);
});
