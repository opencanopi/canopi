// policy/adapters/dependency-cruiser.test.mjs: one dependency-cruiser cruise per graph per run (canopi-f47t.52.240):
// the dependency-cruiser and cross-area-edges families read the same Desktop and Web reports, so a run spawns depcruise
// once per (root, config, arguments) whichever family asks first. Failure state: retried, a second family's run in
// the same process spawns nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collect as crossAreaEdges } from './cross-area-edges.mjs';
import { collect as dependencyCruiser } from './dependency-cruiser.mjs';

const report = JSON.stringify({
  summary: { violations: [], error: 0, totalCruised: 2, environment: { issues: [] } },
  modules: [{ source: 'src/app/a.ts', dependencies: [{ resolved: 'src/app/b.ts', module: './b', dependencyTypes: ['local'] }] },
    { source: 'src/app/b.ts', dependencies: [] }],
});

test('retried: the dependency-cruiser and cross-area-edges families share one cruise per graph', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-cruise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'desktop/web/src/app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'policy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'desktop/web/src/app/a.ts'), "import './b'\n");
  fs.writeFileSync(path.join(root, 'policy/layers.json'), JSON.stringify({ layers: [{ path: 'app/', layer: 'L3', area: 'app' }] }));
  const calls = [];
  const exec = (command, args) => {
    calls.push(args[1]);
    return { status: 0, stdout: report, stderr: '' };
  };
  const paths = ['desktop/web/src/app/a.ts'];
  assert.deepEqual(dependencyCruiser({ root, paths, exec }), []);
  assert.deepEqual(crossAreaEdges({ root, paths, exec }), []);
  assert.deepEqual(calls, ['.dependency-cruiser.cjs', '.dependency-cruiser.web.cjs']);
});
