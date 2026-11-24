// policy/generate/depcruise.test.mjs: verifies that all three dependency-cruiser configs load policy/layers.json and
// policy/rules.json dynamically at runtime (Ch5, ADR 0022) and match depcruiseConfigObjects().
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from '../core/base.mjs';
import { loadDepcruiseConfig } from './depcruise.mjs';

const require = createRequire(import.meta.url);

test('Ch5: all three .dependency-cruiser*.cjs configs load layers.json and rules.json dynamically at runtime', () => {
  const cases = [
    ['desktop', 'desktop/web/.dependency-cruiser.cjs', 'layer-order'],
    ['web', 'desktop/web/.dependency-cruiser.web.cjs', 'edition-roots:web-root-reaches-no-desktop'],
    ['policy', 'desktop/web/.dependency-cruiser.policy.cjs', 'policy-imports-no-cli:cli'],
  ];
  for (const [kind, rel, expectedRule] of cases) {
    const expected = loadDepcruiseConfig(kind, REPO_ROOT);
    const loaded = require(path.join(REPO_ROOT, rel));
    assert.deepEqual(loaded, expected, `${rel} must match loadDepcruiseConfig(${JSON.stringify(kind)})`);
    assert.ok(Array.isArray(loaded.forbidden) && loaded.forbidden.length > 0, `${rel} has forbidden rules`);
    assert.ok(loaded.forbidden.some((r) => r.name === expectedRule || r.name.startsWith(`${expectedRule}:`)),
      `${rel} includes rule ${expectedRule}`);
    assert.ok(loaded.options && typeof loaded.options === 'object', `${rel} has options`);
  }
});
