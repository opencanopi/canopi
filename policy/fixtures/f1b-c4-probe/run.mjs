#!/usr/bin/env node
// F1b c4 probe (canopi-f47t.52.228.8): jscpd and the file-size count on the real tree, and whether a count family's
// planted clone fires through K's comparison. Run from the repository root after npm ci in desktop/web:
//   node policy/fixtures/f1b-c4-probe/run.mjs
// 1. jscpd 5 over the clone scope at min-tokens 50 and 100: wall time, clone count, and 20 evenly spaced clones to
//    judge by hand (the threshold is the lower value whose sample has at most 2 false positives).
// 2. The planted pair in planted/ through jscpd, then compare() of a count family at the tree's count with it.
// 3. Every tracked source file (ts, tsx, js, mjs, cjs, rs, py, sh, css) over 600 newline-terminated lines.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compare } from '../../check.mjs';

const root = process.cwd();
const bin = path.join(root, 'desktop/web/node_modules/.bin/jscpd');
const scope = ['desktop/web/src', 'desktop/web/e2e', 'desktop/web/scripts', 'desktop/src', 'common-types/src', 'bindings-gen/src', 'scripts'];
// Data fixtures by their directories in the scope; `**/fixtures/**` would also hide a planted pair under policy/fixtures/.
const ignore = '**/node_modules/**,**/generated/**,**/*_generated.rs,**/__tests__/fixtures/**,**/__fixtures__/**';

function jscpd(minTokens, paths) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-probe-'));
  const started = process.hrtime.bigint();
  execFileSync(bin, ['-k', String(minTokens), '-a', '-s', '--no-tips', '-f', 'typescript,tsx,javascript,rust,python',
    '-r', 'json', '-o', out, '-i', ignore, ...paths], { cwd: root, stdio: 'ignore' });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const report = JSON.parse(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8'));
  fs.rmSync(out, { recursive: true, force: true });
  return { seconds, duplicates: report.duplicates };
}

const rel = (p) => path.relative(root, p);
const counts = {};
for (const k of [50, 100]) {
  const { seconds, duplicates } = jscpd(k, scope);
  counts[k] = duplicates.length;
  console.log(`== jscpd min-tokens ${k}: ${duplicates.length} clones in ${seconds.toFixed(2)} s`);
  for (let i = 0; i < 20; i++) {
    const c = duplicates[Math.floor((i * duplicates.length) / 20)];
    console.log(`  #${i} ${c.format} ${c.tokens}t ${rel(c.firstFile.name)}:${c.firstFile.start}-${c.firstFile.end} <> ${rel(c.secondFile.name)}:${c.secondFile.start}-${c.secondFile.end}`);
  }
}

const planted = jscpd(100, ['policy/fixtures/f1b-c4-probe/planted']).duplicates.length;
const family = { family: 'jscpd-clones', count: counts[100] };
console.log(`== planted pair: ${planted} clone(s); compare(count ${counts[100]}, ${planted}) -> ${compare(family, planted).map((r) => r.code).join(', ') || 'no refusal'}; against 0 -> ${compare({ ...family, count: 0 }, planted).map((r) => r.code).join(', ')}`);

const SOURCE = /\.(?:ts|tsx|js|mjs|cjs|rs|py|sh|css)$/u;
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => SOURCE.test(f));
const over = files.map((f) => [f, (fs.readFileSync(path.join(root, f), 'utf8').match(/\n/gu) ?? []).length]).filter(([, n]) => n > 600);
console.log(`== files over 600 lines: ${over.length}`);
for (const [f, n] of over) console.log(`  ${n} ${f}`);
