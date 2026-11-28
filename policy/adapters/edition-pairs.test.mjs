// policy/adapters/edition-pairs.test.mjs: unit tests for the edition-pairs adapter (contracts §22, F3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writtenRepo } from '../core/test-repo.mjs';
import { collect } from './edition-pairs.mjs';

const repo = (files) => writtenRepo(files, 'edition-pairs-');

test('edition-pairs accepts adapters in platform/ beside a port with the same stem and rejects others', () => {
  const files = {
    'desktop/web/src/platform/problem-report.ts': 'export interface ProblemReportPort {}\n',
    'desktop/web/src/platform/problem-report.desktop.ts': 'export {};\n',
    'desktop/web/src/platform/problem-report.browser.ts': 'export {};\n',
    'desktop/web/src/platform/problem-report.browser.test.ts': 'export {};\n',
    'desktop/web/src/platform/orphan.desktop.ts': 'export {};\n',
    'desktop/web/src/platform/nested/sub.browser.ts': 'export {};\n',
    'desktop/web/src/app/budget/platform.desktop.ts': 'export {};\n',
    'desktop/web/src/app/budget/platform.browser.ts': 'export {};\n',
  };
  const root = repo(files);
  const sites = collect({ root, paths: Object.keys(files) });
  assert.deepEqual(
    sites.map((s) => s.path).sort(),
    [
      'desktop/web/src/app/budget/platform.browser.ts',
      'desktop/web/src/app/budget/platform.desktop.ts',
      'desktop/web/src/platform/nested/sub.browser.ts',
      'desktop/web/src/platform/orphan.desktop.ts',
    ],
  );
});
