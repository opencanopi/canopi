// policy/adapters/object-capability-gaps.test.mjs: unit tests for the §21 object-capability gap ratchet adapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { writtenRepo } from '../core/test-repo.mjs';
import { collect } from './object-capability-gaps.mjs';

const repo = (files) => writtenRepo(files, 'object-capability-gaps-');

test('object-capability-gaps collects every kind:capability key from GAP_CELLS_BY_BEAD', () => {
  const file = 'desktop/web/src/app/command-table/object-capabilities.ts';
  const root = repo({
    [file]: [
      'const GAP_CELLS_BY_BEAD: Readonly<Record<string, readonly string[]>> = {',
      "  'canopi-qjuzy': ['species-appearance:delete', 'species-appearance:context-menu'],",
      "  'canopi-z1ie7': ['pdf-overview-page:delete'],",
      '}',
      '',
    ].join('\n'),
  });
  const sites = collect({ root, paths: [file] });
  assert.deepEqual(
    sites.map((s) => s.name),
    ['species-appearance:delete', 'species-appearance:context-menu', 'pdf-overview-page:delete'],
  );
});
