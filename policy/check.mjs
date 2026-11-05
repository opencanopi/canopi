#!/usr/bin/env node
// policy/check.mjs: the fail-closed policy checker (contracts §12; 2.1-M186, 2.1-M191; ADR 0028 Generated rules).
//
// It reads the ratchet family files in policy/ratchets/ (one JSON file per family, shaped by ratchet.schema.json)
// and refuses anything it cannot vouch for: a missing or unreadable table, a file the schema refuses, a schema
// keyword its validator does not implement, a misnamed family, a tool with no adapter, a bad key, path drift (a
// workflow path filter or a coverage glob or exclude alternative matching no file too: core/path-filters.mjs) and an
// entry out of scope, a lane in use that no gate table check runs (policy/gate/table.ts), a missing policy/rules.json or one without rows and a row there naming a family whose file is
// gone (the required rules live there, never here: 2.1-M223), a planned row naming no phase, an entry or a row citing a
// bead .beads/issues.jsonl records as closed or does not hold (CI reads the export, never bd: 2.1-M197), a rule with no planted
// violation under policy/fixtures/rules/<rule>/ or a planted directory naming no rule, and a package script or workflow
// that pins or fetches a locked CLI (@tauri-apps/cli) beside desktop/web's devDependency (2.1-M216). Scope globs are picomatch's with `dot: true` and `posix: true` (the one glob engine, installed
// in desktop/web: every mode needs its npm ci), so they match dot paths too. Family kinds share the schema: ratchet (entries or a count), budget
// (ceilings) and floor (2.1-M222).
// compare() holds a family to what its tool observes (the file only shrinks and is never stale); diffRatchets()
// names each change between two revisions for the gate. Every refusal and change has a planted case under
// policy/fixtures/check/, and `--self-test` fails one without, so neither can exist untested.
//
//   node policy/check.mjs [--lane push|ci | --family <id>...]
//                                      load and validate every family file and policy table, then hold each observed
//                                      family (policy/selection.mjs: the commit lane, the one lane named and no other,
//                                      or the named families) to what its adapter observes; exit 1 on any refusal
//                                      It prints the slowest observed families' wall times, and CANOPI_POLICY_TIMINGS
//                                      names a file it appends one JSON line to: {lane, setup, families, total} in seconds
//   node policy/check.mjs --self-test [--lane push|ci | --family <id>...]
//                                      run the lane's planted cases in policy/fixtures/check/ (none with --family), then
//                                      each observed rule's planted violation through its real tool and config, failing
//                                      one its rule does not fail; a case whose real tools need another lane
//                                      (`toolLane`, push for a Rust toolchain) is skipped and still covers its codes
//   node policy/check.mjs --phase-close <phase>
//                                      the default check, also refusing a table row whose owner_target phase is <phase>
//                                      or earlier in rules.json's `phases` while its owner is not in place or it is
//                                      planned, a label that list lacks (2.1-M223), an entry in a `phase_close: empty`
//                                      family (flake-quarantine, 2.1-M229) and a "to be created by Phase N" marker of
//                                      such a phase in tracked Markdown (policy/phase-markers.mjs)
//   node policy/check.mjs --closed-beads
//                                      only the closed-bead and absent-bead refusals (policy/beads.mjs), running
//                                      no tool: what a change touching only .beads/ runs (closedBeadCheck)
//   node policy/check.mjs --list-rules one rule id per line, the registry check_docs.py queries (never committed): the
//                                      checker's id, each family and each policy table's `rules` row (2.1-M222); a
//                                      planned row prints as `<id> planned` (2.1-M223)
//
// Policy tables (policy/*.json with a top-level `rules` array) register rules by rows, never by editing this file:
// policy/rules.json holds the required rows, each naming its family, and the plan's phase order (`phases`); F1a adds
// its rows there and F1b's primitives.json holds the primitive rows (loadTableRules).
//
// The layer table (policy/layers.json, ADR 0022) is read here for its moves only: rows under `layers`, each with a
// module `path` relative to desktop/web/src (a trailing slash allowed) and an optional `destination` in the same
// coordinates; other columns and sections are its owner's. A table this reading refuses fails the load and the diff.
//
// The lanes, --family and the gate checks that must run them (`lane-unrun`) live in policy/selection.mjs. The gate
// table runs the commit lane in the Frontend row and the commit hook, the push lane (clippy and cargo families: the Rust
// toolchain and, without the catalog DB, CANOPI_SKIP_BUNDLED_DB=1) in the Rust row, and the ci-lane bundle-size family
// once both editions are built.
//
// This file is the entry only: argv and main. Its library is policy/core/ (2.1-M348).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closedBeadCheck } from './beads.mjs';
import { CASES_DIR, REPO_ROOT, RefusalError } from './core/base.mjs';
import { checkRepo } from './core/observe.mjs';
import { selfTest } from './core/self-test.mjs';
import { listRules } from './core/tables.mjs';
import { commandLane, familyArgs, modeConflicts } from './selection.mjs';

async function main(argv) {
  const lane = commandLane(argv);
  if (argv.includes('--self-test')) {
    const { failures, missing } = await selfTest(undefined, (line) => console.log(line), lane, familyArgs(argv));
    for (const code of missing) console.error(`${code} has no planted case under ${CASES_DIR}/`);
    console.log(failures.length || missing.length ? 'policy self-test: RED' : 'policy self-test: OK');
    return failures.length || missing.length ? 1 : 0;
  }
  if (argv.includes('--list-rules')) {
    const { rules, refusals } = listRules();
    for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
    for (const id of rules) console.log(id);
    return refusals.length ? 1 : 0;
  }
  if (argv.includes('--closed-beads')) {
    const explicitLane = argv.some((a) => a === '--lane' || a.startsWith('--lane=')) ? lane : undefined;
    const conflicts = modeConflicts({ closedBeads: true, lane: explicitLane, families: familyArgs(argv) });
    const refusals = conflicts.length ? conflicts : closedBeadCheck();
    for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
    console.log(`policy closed-bead check: ${refusals.length ? 'RED' : 'OK'}`);
    return refusals.length ? 1 : 0;
  }
  const closeAt = argv.indexOf('--phase-close');
  const phaseClose = closeAt === -1 ? undefined : argv[closeAt + 1];
  if (closeAt !== -1 && (!phaseClose || phaseClose.startsWith('--'))) throw new Error('--phase-close needs a phase label');
  const { families, refusals, timings } = await checkRepo(REPO_ROOT, lane, { phaseClose, families: familyArgs(argv) });
  for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
  const slowest = Object.entries(timings.families).sort(([, a], [, b]) => b - a).slice(0, 10);
  console.log(`policy check timings: ${[...slowest, ['(setup)', timings.setup]].map(([id, s]) => `${id} ${s.toFixed(1)} s`).join(', ')}; total ${timings.total.toFixed(1)} s`);
  const record = process.env.CANOPI_POLICY_TIMINGS;
  if (record) fs.appendFileSync(record, `${JSON.stringify({ lane, ...timings })}\n`);
  console.log(`policy check: ${families.size} families, ${refusals.length ? 'RED' : 'OK'}`);
  return refusals.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // A refusal no mode returns as a list (a missing glob engine) is one line, never a stack trace.
    if (!(error instanceof RefusalError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
