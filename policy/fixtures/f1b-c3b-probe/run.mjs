#!/usr/bin/env node
// policy/fixtures/f1b-c3b-probe/run.mjs: the probe of F1b c3b's riskiest assumption (Phase 0 F1b, canopi-f47t.52.228.8).
//
// Each question runs F1a's real ast-grep adapter (policy/adapters/ast-grep.mjs collect) and the installed ast-grep
// binary over a temporary root holding the repository's own sgconfig.yml, byte for byte, with this directory's rules
// in its ruleDirs:
//   (1) the signal-write pattern (a `.value` `=`, `op=`, `++` or `--` whose root binding is imported, named or through
//       a namespace) over the real production desktop/web/src reproduces the design check's 77 sites in 20 files;
//       over FAP P44's planted cases (written with the imports real code has) every P44 violation fires, a read, a
//       write to a locally declared signal and a test file do not;
//   (2) the compat-alias pattern (onFocus and onBlur on a lowercase JSX element; onChange on textarea and
//       on an input whose type is absent, dynamic or a literal other than checkbox, radio or file) lists every
//       production site with its element and type, and fires on the planted aliases only.
// The jsdom half (a renamed handler fires on the same DOM event with preact/compat loaded) is
// desktop/web/src/__tests__/compat-event-names-probe.test.tsx. Prints one line per answer and exits 1 when an answer
// differs from the expectation below. c3b lands the real rules; this directory is deleted with the probe's answers
// recorded in the commit that adds them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../../adapters/ast-grep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const BIN = path.join(REPO, 'desktop/web/node_modules/.bin/ast-grep');
const exec = (bin, args, options) => {
  const r = spawnSync(bin, args, { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A temporary root: the repository's sgconfig.yml, this probe's rules in its ruleDirs, and `src` at desktop/web/src. */
function rootWith(src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-f1b-c3b-probe-'));
  const config = fs.readFileSync(path.join(REPO, 'sgconfig.yml'), 'utf8');
  fs.writeFileSync(path.join(root, 'sgconfig.yml'), config);
  const dir = /ruleDirs:\s*\n\s+-\s+(\S+)/u.exec(config)[1];
  fs.cpSync(path.join(HERE, 'rules'), path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(root, 'desktop/web'), { recursive: true });
  fs.cpSync(src, path.join(root, 'desktop/web/src'), { recursive: true });
  return root;
}

/** The raw findings of one probe rule id prefix: `path:line text` (the first line of the match). */
function findings(root, prefix) {
  const raw = exec(BIN, ['scan', '--config', 'sgconfig.yml', '--json=stream', 'desktop/web/src'], { cwd: root });
  return raw.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.ruleId.startsWith(prefix))
    .map((f) => {
      // The JSX element that holds the match and its `type` attribute, read back from the match's start.
      const before = fs.readFileSync(path.join(root, f.file), 'utf8').slice(0, f.range.byteOffset.start);
      const open = before.lastIndexOf('<');
      const tag = before.slice(open);
      return {
        path: f.file, line: f.range.start.line + 1, text: f.text.split('\n')[0],
        element: /^<\s*([\w.]+)/u.exec(tag)?.[1] ?? '?', type: /\btype=("[^"]*"|\{[^}]*\})/u.exec(tag)?.[1] ?? 'none',
      };
    });
}

const results = [];
const answer = (name, ok, detail) => results.push({ name, ok, detail });
const files = (sites) => new Set(sites.map((s) => s.path)).size;

// (1) and (2) over a copy of the real source tree (a copy, not a link: ast-grep's walker does not follow a linked root).
{
  const root = rootWith(path.join(REPO, 'desktop/web/src'));
  try {
    const adapter = collect({ root, paths: ['desktop/web/src'], exec, tools: REPO });
    const signal = adapter.filter((s) => s.rule === 'probe-signal-write');
    answer('(1) signal writes at the base', signal.length === 77 && files(signal) === 20, `${signal.length} sites in ${files(signal)} files`);
    const compat = findings(root, 'probe-compat-alias');
    const dynamic = compat.filter((s) => s.type.startsWith('{'));
    for (const s of compat) console.log(`  ${s.path}:${s.line} ${s.text.split('=')[0]} on <${s.element}> type ${s.type}`);
    answer('(2) compat aliases at the base', compat.length === 27 && files(compat) === 18 && dynamic.length === 0,
      `${compat.length} sites in ${files(compat)} files (${compat.filter((s) => s.text.startsWith('onChange')).length} onChange), ${dynamic.length} with a dynamic type`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// (1) and (2) over the planted tree.
{
  const root = rootWith(path.join(HERE, 'planted/desktop/web/src'));
  try {
    const signal = findings(root, 'probe-signal-write').map((s) => `${s.path.replace('desktop/web/', '')}:${s.line} ${s.text}`).sort();
    const want = [
      "src/app/planted.ts:10 sidePanelWidth.value += 10",
      'src/app/planted.ts:11 settings.googleMapsApiKey.value = null',
      'src/app/planted.ts:12 mapLayers.value = next',
      'src/app/planted.ts:13 scrollWheel.value++',
      'src/app/planted.ts:9 snapToGridEnabled.value = true',
      "src/app/settings/projection.ts:4 locale.value = 'fr'",
      'src/app/settings/projection.ts:5 mapLayers.value = next',
      "src/web/BrowserAppShell.tsx:2 locale.value = 'fr'",
      "src/web/BrowserAppShell.tsx:3 theme.value = 'dark'",
    ];
    answer('(1) P44 planted cases', signal.join('\n') === want.join('\n'),
      `fires on ${signal.join('; ')} (P44 exempted the projection; here it writes signals settings/state.ts declares)`);
    const compat = findings(root, 'probe-compat-alias').map((s) => `${s.line} ${s.text.split('=')[0]}`).sort();
    const wantCompat = ['12 onChange', '16 onChange', '5 onBlur', '5 onFocus', '6 onChange', '7 onChange', '8 onChange'];
    answer('(2) compat planted cases', compat.join() === wantCompat.join(), `fires on lines ${compat.join(', ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
