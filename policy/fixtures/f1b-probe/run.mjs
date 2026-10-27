#!/usr/bin/env node
// policy/fixtures/f1b-probe/run.mjs: the probe of F1b c3's riskiest assumption (Phase 0 F1b, canopi-f47t.52.228.8).
//
// Each question runs F1a's real ast-grep adapter (policy/adapters/ast-grep.mjs collect) and the installed ast-grep
// binary over a temporary root holding the repository's own sgconfig.yml, byte for byte, with this directory's rules
// in its ruleDirs:
//   (1) tool-id-literal-only-in-rows' context pattern over the real desktop/web/src reproduces DR23's 47 sites in
//       16 files, 38 in 15 production files (tests and __fixtures__ out);
//   (2) one rule id written for TypeScript and for CSS (`<id>.typescript.yml`, `<id>.css.yml`) loads without a
//       duplicate-id error and the adapter reports both halves as `<id>` (2.1-M226);
//   (3) a rule's `ignores` holds when the adapter passes the ignored file explicitly;
//   (4) where an `ast-grep-ignore` comment silences a finding: at the comment start or after other comment text, bare,
//       naming the tool's `<rule-id>.<language>` or the table's `<rule-id>`.
// Prints one line per answer and exits 1 when an answer differs from the expectation below. c3 lands the real rules;
// this directory is deleted with the probe's answers recorded in the commit that adds them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../../adapters/ast-grep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const exec = (bin, args, options) => {
  const r = spawnSync(bin, args, { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A temporary root: the repository's sgconfig.yml, this probe's rules in its ruleDirs, and `src` at desktop/web/src. */
function rootWith(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-f1b-probe-'));
  const config = fs.readFileSync(path.join(REPO, 'sgconfig.yml'), 'utf8');
  fs.writeFileSync(path.join(root, 'sgconfig.yml'), config);
  const dir = /ruleDirs:\s*\n\s+-\s+(\S+)/u.exec(config)[1];
  fs.cpSync(path.join(HERE, 'rules'), path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(root, 'desktop/web'), { recursive: true });
  fs.cpSync(src, path.join(root, 'desktop/web/src'), { recursive: true });
  return root;
}

const results = [];
const answer = (name, ok, detail) => results.push({ name, ok, detail });

// (1) over a copy of the real source tree (a copy, not a link: ast-grep's walker does not follow a linked root).
{
  const root = rootWith(path.join(REPO, 'desktop/web/src'));
  const sites = collect({ root, paths: ['desktop/web/src'], exec, tools: REPO }).filter((s) => s.rule === 'tool-id-literal-only-in-rows');
  const lines = new Set();
  const raw = exec(path.join(REPO, 'desktop/web/node_modules/.bin/ast-grep'), ['scan', '--config', 'sgconfig.yml', '--json=stream', 'desktop/web/src'], { cwd: root });
  for (const f of raw.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
    if (f.ruleId.startsWith('tool-id-literal-only-in-rows.')) lines.add(`${f.file}:${f.range.start.line + 1}`);
  }
  const test = (p) => /(^|\/)__tests__\/|\.test\.tsx?$/u.test(p);
  const fixture = (p) => /(^|\/)__fixtures__\//u.test(p);
  const all = [...lines].filter((l) => !test(l.split(':')[0]));
  const prod = all.filter((l) => !fixture(l.split(':')[0]));
  const files = (ls) => new Set(ls.map((l) => l.split(':')[0])).size;
  const matches = sites.filter((s) => !test(s.path)).length;
  answer('(1) tool-id context pattern', all.length === 47 && files(all) === 16 && prod.length === 38 && files(prod) === 15,
    `${all.length} site lines in ${files(all)} files, ${prod.length} in ${files(prod)} production files (${matches} matches: five lines compare two ids)`);
  fs.rmSync(root, { recursive: true, force: true });
}

// (2)-(4) over the planted tree.
{
  const root = rootWith(path.join(HERE, 'planted/desktop/web/src'));
  try {
    const raw = exec(path.join(REPO, 'desktop/web/node_modules/.bin/ast-grep'), ['scan', '--config', 'sgconfig.yml', '--json=stream', 'desktop/web/src'], { cwd: root });
    const ids = [...new Set(raw.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).ruleId))].filter((id) => id.startsWith('probe-two-languages')).sort();
    const sites = collect({ root, paths: ['desktop/web/src'], exec, tools: REPO });
    const two = sites.filter((s) => s.rule === 'probe-two-languages').map((s) => s.path).sort();
    answer('(2) one id over TypeScript and CSS', !/duplicate/iu.test(raw.stderr) && ids.join() === 'probe-two-languages.css,probe-two-languages.typescript'
      && two.join() === 'desktop/web/src/app/two-languages.css,desktop/web/src/app/two-languages.ts',
      `tool ids ${ids.join(', ')}; adapter rule ids ${[...new Set(sites.filter((s) => s.rule.startsWith('probe-two')).map((s) => s.rule))].join(', ')} at ${two.join(', ')}`);

    const explicit = collect({ root, paths: ['desktop/web/src/maplibre/owner.ts', 'desktop/web/src/app/storage.ts'], exec, tools: REPO }).filter((s) => s.rule === 'probe-ignores');
    answer('(3) ignores hold for explicit paths', !explicit.some((s) => s.path.endsWith('maplibre/owner.ts')),
      `explicit paths report ${explicit.map((s) => s.path).join(', ') || 'nothing'}`);

    const storage = raw.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.ruleId === 'probe-ignores.typescript' && f.file.endsWith('storage.ts'));
    const reported = storage.map((f) => f.lines.trim().split(' = ')[0].replace('export const ', '')).sort();
    // Measured on ast-grep 0.50.0: a directive silences only at the comment start, bare or naming the tool's own id
    // (`<rule-id>.<language>`); naming the table's `<rule-id>` silences nothing (ast-grep reports it as an
    // unused-suppression hint), and a directive after other comment text silences nothing.
    const names = ['counted', 'bareStart', 'languageIdStart', 'baseIdStart', 'languageIdMid', 'bareMid', 'languageIdMidBlock'];
    const expected = ['bareMid', 'baseIdStart', 'counted', 'languageIdMid', 'languageIdMidBlock'];
    const unused = raw.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.ruleId === 'unused-suppression').map((f) => f.range.start.line + 1);
    answer('(4) ast-grep-ignore position and id', reported.join() === expected.join(),
      `reported ${reported.join(', ')}; silenced ${names.filter((n) => !reported.includes(n)).join(', ')}; unused-suppression hints at line ${unused.join(', ') || 'none'}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.detail}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
