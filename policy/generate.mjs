#!/usr/bin/env node
// policy/generate.mjs: command-line entry for the layer table validator and config generator (2.1-M352).
// Its library lives in policy/core/generate.mjs (canopi-f47t.52.267).
//
//   node policy/generate.mjs              validate, then write each drifted generated file (OUTPUTS)
//   node policy/generate.mjs --check      validate and exit 1 naming each drifted generated file; never writes
//   node policy/generate.mjs --self-test  run the planted cases, the write and check modes, and this repository's tables
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES_DIR, drifted, generate, REPO_ROOT, selfTest, write } from './core/generate.mjs';

function main(argv) {
  if (argv.includes('--self-test')) {
    const { failures, missing } = selfTest(undefined, (line) => console.log(line));
    for (const code of missing) console.error(`${code} has no planted case under ${CASES_DIR}/`);
    console.log(failures.length || missing.length ? 'generate self-test: RED' : 'generate self-test: OK');
    return failures.length || missing.length ? 1 : 0;
  }
  const { refusals, outputs } = generate();
  for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
  if (refusals.length) {
    console.log('generate: RED (nothing written)');
    return 1;
  }
  const stale = drifted(REPO_ROOT, outputs);
  if (argv.includes('--check')) {
    for (const rel of stale) console.error(`drifted: ${rel}; run node policy/generate.mjs`);
    console.log(`generate --check: ${stale.length ? 'RED' : 'OK'}`);
    return stale.length ? 1 : 0;
  }
  write(REPO_ROOT, outputs);
  console.log(`generate: ${stale.length ? `wrote ${stale.join(', ')}` : 'up to date'}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
