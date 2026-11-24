// Behavioural tests for policy/core/lower.mjs (canopi-hlewq, 2.1-M530):
// `check.mjs --update` lowers falling counts and removes stale entries, deletes emptied derived family files,
// never raises a baseline or adds an unlisted entry, and skips budgets, floors (coverage floors never fall) and ceilings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commandLane } from '../selection.mjs';
import { REPO_ROOT, SCHEMA_FILE } from './base.mjs';
import { lowerRepo } from './lower.mjs';
import { writtenRepo } from './test-repo.mjs';

test('canopi-hlewq: lowerRepo lowers counts and entries, deletes emptied derived files, never raises, and skips ceilings/budgets/floors', async () => {
  const adapter = `
    export function collect({ select }) {
      const rule = select?.[0] ?? 'scan';
      if (rule === 'derived-empty') return [];
      if (rule === 'derived-lower') return [{ rule: 'derived-lower', path: 'desktop/web/src/a.ts' }];
      if (rule === 'count-lower') return [{ rule: 'count-lower', path: 'desktop/web/src/a.ts' }];
      if (rule === 'count-rising') return [{ rule: 'count-rising', path: 'desktop/web/src/a.ts' }, { rule: 'count-rising', path: 'desktop/web/src/b.ts' }];
      if (rule === 'ceilings-family') return [];
      return [];
    }
    export function measure() {
      return { vitest: { values: { lines: 50 } } };
    }
  `;
  const schema = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8');
  const root = writtenRepo({
    [SCHEMA_FILE]: schema,
    'desktop/web/src/a.ts': 'export const a = 1;\n',
    'desktop/web/src/b.ts': 'export const b = 2;\n',
    'policy/adapters/ast-grep.mjs': adapter,
    'policy/adapters/scan.mjs': adapter,
    'policy/rules.json': JSON.stringify({
      version: 1,
      phases: ['2'],
      rules: [
        { id: 'derived-empty', tool: 'ast-grep', ledger: '2.1-M530', family: 'derived-empty' },
        { id: 'derived-lower', tool: 'ast-grep', ledger: '2.1-M530', family: 'derived-lower' },
        { id: 'count-lower', tool: 'scan', ledger: '2.1-M530', family: 'count-lower' },
        { id: 'count-rising', tool: 'scan', ledger: '2.1-M530', family: 'count-rising' },
        { id: 'ceilings-family', tool: 'scan', ledger: '2.1-M530', family: 'ceilings-family' },
        { id: 'floor-family', tool: 'scan', ledger: '2.1-M530', family: 'floor-family' },
      ],
    }, null, 2),
    'policy/ratchets/derived-empty.json': JSON.stringify({
      $schema: './ratchet.schema.json',
      family: 'derived-empty',
      entries: { 'desktop/web/src/a.ts': { count: 1 } },
    }, null, 2),
    'policy/ratchets/derived-lower.json': JSON.stringify({
      $schema: './ratchet.schema.json',
      family: 'derived-lower',
      entries: {
        'desktop/web/src/a.ts': { count: 3, bead: 'canopi-1' },
        'desktop/web/src/b.ts': { count: 1 },
      },
    }, null, 2),
    'policy/ratchets/count-lower.json': JSON.stringify({
      version: 1,
      family: 'count-lower',
      ledger: '2.1-M530',
      tool: 'scan',
      scope: ['desktop/web/src/**'],
      lane: 'commit',
      select: ['count-lower'],
      count: 5,
    }, null, 2),
    'policy/ratchets/count-rising.json': JSON.stringify({
      version: 1,
      family: 'count-rising',
      ledger: '2.1-M530',
      tool: 'scan',
      scope: ['desktop/web/src/**'],
      lane: 'commit',
      select: ['count-rising'],
      count: 1,
    }, null, 2),
    'policy/ratchets/ceilings-family.json': JSON.stringify({
      version: 1,
      family: 'ceilings-family',
      ledger: '2.1-M530',
      tool: 'scan',
      scope: ['desktop/web/src/**'],
      lane: 'commit',
      keys: 'path',
      ceilings: true,
      select: ['ceilings-family'],
      entries: { 'desktop/web/src/a.ts': { count: 2 } },
    }, null, 2),
    'policy/ratchets/floor-family.json': JSON.stringify({
      version: 1,
      family: 'floor-family',
      ledger: '2.1-M530',
      tool: 'scan',
      scope: ['desktop/web/src/**'],
      lane: 'commit',
      floors: { vitest: { floors: { lines: 80 } } },
    }, null, 2),
  });

  const result = await lowerRepo(root, 'commit', {});
  assert.deepEqual(result.removed, ['policy/ratchets/derived-empty.json']);
  assert.deepEqual(result.updated.sort(), ['policy/ratchets/count-lower.json', 'policy/ratchets/derived-lower.json']);
  assert.equal(fs.existsSync(path.join(root, 'policy/ratchets/derived-empty.json')), false);

  const afterLower = JSON.parse(fs.readFileSync(path.join(root, 'policy/ratchets/derived-lower.json'), 'utf8'));
  assert.deepEqual(afterLower, {
    $schema: './ratchet.schema.json',
    family: 'derived-lower',
    entries: { 'desktop/web/src/a.ts': { count: 1, bead: 'canopi-1' } },
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'policy/ratchets/count-lower.json'), 'utf8')).count, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'policy/ratchets/count-rising.json'), 'utf8')).count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'policy/ratchets/ceilings-family.json'), 'utf8')).entries, { 'desktop/web/src/a.ts': { count: 2 } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'policy/ratchets/floor-family.json'), 'utf8')).floors.vitest.floors.lines, 80);
  assert.equal(result.refusals.some((r) => r.code === 'rising' && r.where === 'policy/ratchets/count-rising.json'), true);

  assert.equal(commandLane(['--update', '--family', 'derived-lower']), 'commit');
  assert.equal(commandLane(['--update', '--lane', 'push']), 'push');
  const second = await lowerRepo(root, 'commit', { families: ['derived-lower', 'count-lower'] });
  assert.deepEqual(second, { updated: [], removed: [], refusals: [] });
});
