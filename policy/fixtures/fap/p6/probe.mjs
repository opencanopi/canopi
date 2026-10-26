// Probe (brief F1a-c3): P6's edge cases, plus the mixed, inline-type, export-type and side-effect forms, through
// FAP's source-facts.ts and dependency-cruiser (tsPreCompilationDeps, the generated config's options). For every
// import edge it prints the type-only classification each side gives; a mismatch is that rule's type-only semantics in
// classification.json. Run from the repository root: node policy/fixtures/fap/p6/probe.mjs (compare expected.txt).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseTypeScriptSource } from '../../../../desktop/web/src/__tests__/support/architecture/source-facts.ts';

const HERE = 'policy/fixtures/fap/p6';
const SRC = `${HERE}/src`;
const files = fs.readdirSync(SRC, { recursive: true }).map((f) => `${SRC}/${f}`).filter((f) => /\.tsx?$/u.test(f)).sort();

const old = new Map();
for (const file of files) {
  const fact = parseTypeScriptSource(file, fs.readFileSync(file, 'utf8'));
  for (const edge of fact.imports) {
    old.set(`${file.slice(SRC.length + 1)} ${edge.specifier}`, { kind: edge.kind, typeOnly: edge.typeOnly });
  }
}

const out = execFileSync('node_modules/.bin/depcruise', ['--config', `../../${HERE}/depcruise.cjs`, '--output-type', 'json', `../../${SRC}`], { cwd: 'desktop/web', encoding: 'utf8', maxBuffer: 1 << 28 });
const neu = new Map();
for (const mod of JSON.parse(out).modules) {
  if (!mod.source.startsWith(`../../${SRC}/`)) continue;
  for (const dep of mod.dependencies) {
    const typeOnly = dep.dependencyTypes.some((t) => t === 'type-only' || t === 'type-import');
    neu.set(`${mod.source.slice(`../../${SRC}/`.length)} ${dep.module}`, { types: dep.dependencyTypes.join(','), typeOnly });
  }
}

for (const key of [...new Set([...old.keys(), ...neu.keys()])].sort()) {
  const o = old.get(key);
  const n = neu.get(key);
  const verdict = !o || !n ? 'ONE-SIDED' : o.typeOnly === n.typeOnly ? 'match' : 'MISMATCH';
  console.log(`${verdict} ${key} | source-facts ${o ? `${o.kind}${o.typeOnly ? ' type-only' : ' value'}` : 'none'} | depcruise ${n ? `${n.types}${n.typeOnly ? ' type-only' : ' value'}` : 'none'}`);
}
