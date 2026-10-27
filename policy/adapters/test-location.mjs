// policy/adapters/test-location.mjs: tests in a __tests__/ directory that belong beside one module, as sites
// (2.1-E3; ADR 0028:22: a unit test sits beside its module, src/__tests__/ holds cross-module suites only).
//
// Over the paths it is given, a test file (`*.test.ts`, `*.test.tsx`) in a `__tests__/` directory, never under its
// `support/` or `fixtures/`, is read for its relative module specifiers: static imports, re-exports and literal
// dynamic `import()`s, a bundler query (`?raw`, `?url`) dropped. A type-only import or re-export (`import type`,
// `export type`, or braces whose every binding is `type X`) is resolved but counts toward no directory: a type is no
// module under test. Each is resolved from the test's directory (the
// specifier as written, then with .ts, .tsx, .js, .mjs or .json, then a directory's index file); a file under a
// `__tests__/` directory is test support, never production. A test whose production files all sit in one directory
// is one site { rule: 'test-location', path } at its path; a test reaching two directories or none is a
// cross-module suite. Package specifiers are not read. Paths are taken relative to the test, so a planted mirror of
// the layout under policy/fixtures/ resolves the same way. A relative specifier that resolves to no file is
// tool-failed, never a test with one fewer module.
import fs from 'node:fs';
import path from 'node:path';

const IN_TESTS_DIR = /(?:^|\/)__tests__\/(?!(?:support|fixtures)\/)(?:[^/]+\/)*[^/]+\.test\.tsx?$/u;
const TEST_SUPPORT = /(?:^|\/)__tests__\//u;
const STATIC = /(?:^|\n)[ \t]*((?:import|export)\b[^;'"`]*?)\bfrom[ \t]*['"]([^'"\n]+)['"]/gu;
const BARE_IMPORT = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gu;
const DYNAMIC = /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/gu;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

const fail = (message) => { throw Object.assign(new Error(`test-location: ${message}`), { code: 'tool-failed' }); };

/** The repository file a relative `specifier` of `from` names, or undefined. */
function resolve(root, from, specifier) {
  const base = path.posix.join(path.posix.dirname(from), specifier);
  for (const candidate of [...EXTENSIONS.map((ext) => `${base}${ext}`), base.replace(/\.js$/u, '.ts'), base.replace(/\.js$/u, '.tsx')]) {
    if (fs.statSync(path.join(root, candidate), { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  return undefined;
}

/** Whether an import or export clause (the text before `from`) brings in types only. */
const typeOnly = (clause) => {
  const trimmed = clause.trim();
  if (/^(?:import|export)\s+type\b/u.test(trimmed)) return true;
  const braces = /^(?:import|export)\s*\{([^}]*)\}$/u.exec(trimmed);
  const bindings = braces?.[1].split(',').map((b) => b.trim()).filter(Boolean) ?? [];
  return bindings.length > 0 && bindings.every((b) => /^type\s/u.test(b));
};

export function collect({ root, paths }) {
  const sites = [];
  for (const test of paths.filter((p) => IN_TESTS_DIR.test(p))) {
    const text = fs.readFileSync(path.join(root, test), 'utf8');
    const found = [
      ...[...text.matchAll(STATIC)].map((m) => ({ specifier: m[2], typeOnly: typeOnly(m[1]) })),
      ...[BARE_IMPORT, DYNAMIC].flatMap((re) => [...text.matchAll(re)].map((m) => ({ specifier: m[1], typeOnly: false }))),
    ].filter(({ specifier }) => specifier.startsWith('.'));
    const directories = new Set();
    for (const { specifier, typeOnly: types } of found) {
      const file = resolve(root, test, specifier.replace(/\?.*$/u, ''));
      if (!file) fail(`${test} imports ${specifier}, which resolves to no file`);
      if (!types && !TEST_SUPPORT.test(file)) directories.add(path.posix.dirname(file));
    }
    if (directories.size === 1) sites.push({ rule: 'test-location', path: test });
  }
  return sites;
}
