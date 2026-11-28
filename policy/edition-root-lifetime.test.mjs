// policy/edition-root-lifetime.test.mjs: Desktop and Web roots install shared app lifetime only through
// installAppLifetime (2.1-Q45). Lives in policy/ so Vitest tests never read src/ files directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './core/base.mjs';

const OWNED_INSTALLERS = [
  'installFailureHooks',
  'installConsortiumSync',
  'installEditionPorts',
  'installSpeciesCatalogWorkbench',
  'installCanvasHostRuntime',
  'installLiveSessionCore',
  'registerCloseGuard',
  'registerDesignOpenFailurePresenter',
  'installPlaceSearchSession',
  'installToolRailLearning',
];

test('Desktop and Web roots install shared app lifetime only through installAppLifetime (2.1-Q45)', () => {
  for (const rel of ['desktop/web/src/editions/desktop/boot.ts', 'desktop/web/src/editions/web/boot.ts']) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(source.includes('installAppLifetime'), `${rel} must call installAppLifetime`);
    for (const installer of OWNED_INSTALLERS) {
      assert.ok(!source.includes(installer), `${rel} must not import ${installer} directly`);
    }
  }
  for (const rel of ['desktop/web/src/editions/desktop/main.tsx', 'desktop/web/src/editions/web/main.tsx']) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const installer of OWNED_INSTALLERS) {
      assert.ok(!source.includes(installer), `${rel} must not import ${installer} directly`);
    }
  }
});
