// policy/adapters/edition-root-parity.mjs: active policy adapter for `edition-root-parity`
// (ADR 0030, design check A33, 2.1-M211). Verifies the Desktop and Web edition roots keep their
// manifest and boot files without deleted edition path aliases; full TS manifest/capability diff
// runs in desktop/web/src/__tests__/edition-root-parity.test.ts.
import fs from 'node:fs';
import path from 'node:path';

const DELETED_ALIASES = [
  '#platform',
  '#species-catalog-live',
  '#canvas-pdf-platform',
  '#budget-export-platform',
  '#geocoding-transport',
];

const REQUIRED_ROOT_FILES = [
  'desktop/web/src/editions/desktop/boot.ts',
  'desktop/web/src/editions/desktop/manifest.ts',
  'desktop/web/src/editions/web/boot.ts',
  'desktop/web/src/editions/web/manifest.ts',
];

/** Collects edition-root parity violations in the repo or in planted fixture files. */
export function collect({ root, paths }) {
  const sites = [];
  const pathSet = new Set(paths);

  for (const file of paths) {
    if (!file.startsWith('policy/fixtures/rules/edition-root-parity/')) continue;
    const raw = fs.readFileSync(path.join(root, file), 'utf8');
    const doc = JSON.parse(raw);
    if (doc?.plantedDrift && !doc.plantedDrift.gatedBy && !doc.plantedDrift.insteadOf) {
      sites.push({ rule: 'edition-root-parity', path: file });
    }
  }

  // Real tree check only when scanning the desktop/web workspace (not planted-only runs).
  if (pathSet.has('desktop/web/tsconfig.json') || pathSet.has('desktop/web/vite.config.ts')) {
    for (const required of REQUIRED_ROOT_FILES) {
      if (!fs.existsSync(path.join(root, required))) {
        sites.push({ rule: 'edition-root-parity', path: required });
      }
    }
    for (const cfg of ['desktop/web/tsconfig.json', 'desktop/web/vite.config.ts']) {
      if (!fs.existsSync(path.join(root, cfg))) continue;
      const text = fs.readFileSync(path.join(root, cfg), 'utf8');
      if (DELETED_ALIASES.some((alias) => text.includes(`"${alias}"`) || text.includes(`'${alias}'`))) {
        sites.push({ rule: 'edition-root-parity', path: cfg });
      }
    }
  }

  return sites;
}
