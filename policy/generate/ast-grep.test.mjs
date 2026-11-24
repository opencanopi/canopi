// Behavioural tests for policy/generate/ast-grep.mjs TSX twin generation (canopi-ttg1, 2.1-M530):
// every TS ast-grep rule with a *.ts glob and its rule test are written once in .typescript.yml / .typescript-test.yml,
// with optional JSX overlays in policy/ast-grep/tsx-overlays/, and generate.mjs emits and drift-checks the .tsx twins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { tsxTwinOutputs } from './ast-grep.mjs';

const roots = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-grep-twins-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('canopi-ttg1: tsxTwinOutputs derives .tsx rules and tests from .typescript sources and merges JSX overlays', () => {
  const root = tempTree({
    'policy/ast-grep/rules/plain.typescript.yml': [
      'id: plain.typescript',
      'language: typescript',
      'severity: error',
      'message: "plain"',
      'files:',
      '  - "{desktop/web,policy/fixtures/rules/*}/src/**/*.ts"',
      'ignores:',
      '  - "{desktop/web,policy/fixtures/rules/*}/src/**/*.test.ts"',
      '  - "{desktop/web,policy/fixtures/rules/*}/src/**/*.test.tsx"',
      'rule:',
      '  kind: identifier',
      '',
    ].join('\n'),
    'policy/ast-grep/rule-tests/plain.typescript-test.yml': [
      'id: plain.typescript',
      'valid:',
      '  - |',
      '    export const ok = 1',
      'invalid:',
      '  - |',
      '    export const bad = 2',
      '',
    ].join('\n'),
    'policy/ast-grep/rules/single-file.typescript.yml': [
      'id: single-file.typescript',
      'language: typescript',
      'severity: error',
      'message: "single"',
      'files:',
      '  - "{desktop/web,policy/fixtures/rules/*}/src/app/only.ts"',
      'rule:',
      '  kind: identifier',
      '',
    ].join('\n'),
    'policy/ast-grep/rules/with-jsx.typescript.yml': [
      'id: with-jsx.typescript',
      'language: typescript',
      'severity: error',
      'message: "jsx"',
      'files:',
      '  - "{desktop/web,policy/fixtures/rules/*}/src/**/*.ts"',
      'rule:',
      '  kind: import_specifier',
      '',
    ].join('\n'),
    'policy/ast-grep/tsx-overlays/with-jsx.yml': [
      'rule-any:',
      '    - kind: jsx_opening_element',
      '      has:',
      '        field: name',
      '        regex: ^Toast$',
      '',
    ].join('\n'),
    'policy/ast-grep/rule-tests/with-jsx.typescript-test.yml': [
      'id: with-jsx.typescript',
      'valid:',
      '  - |',
      '    export const a = 1',
      'invalid:',
      '  - |',
      '    import { message } from "x"',
      '',
    ].join('\n'),
    'policy/ast-grep/tsx-overlays/with-jsx-test.yml': [
      'valid:',
      '  - |',
      '    export const V = () => <ToastSlot />',
      'invalid:',
      '  - |',
      '    export const V = () => <Toast />',
      '',
    ].join('\n'),
  });

  const out = tsxTwinOutputs(root, {});
  assert.equal('policy/ast-grep/rules/single-file.tsx.yml' in out, false);

  const plain = out['policy/ast-grep/rules/plain.tsx.yml'];
  assert.match(plain, /^id: plain\.tsx$/m);
  assert.match(plain, /^language: tsx$/m);
  assert.match(plain, /src\/\*\*\/\*\.tsx"/);
  assert.match(plain, /src\/\*\*\/\*\.test\.ts"/);

  const plainTest = out['policy/ast-grep/rule-tests/plain.tsx-test.yml'];
  assert.match(plainTest, /^id: plain\.tsx$/m);
  assert.match(plainTest, /export const bad = 2/);

  const withJsx = out['policy/ast-grep/rules/with-jsx.tsx.yml'];
  assert.match(withJsx, /^rule:\n  any:\n    - kind: import_specifier\n    - kind: jsx_opening_element/m);

  const withJsxTest = out['policy/ast-grep/rule-tests/with-jsx.tsx-test.yml'];
  assert.match(withJsxTest, /^id: with-jsx\.tsx$/m);
  assert.match(withJsxTest, /<ToastSlot \/>/);
  assert.match(withJsxTest, /<Toast \/>/);
});
