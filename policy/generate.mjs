#!/usr/bin/env node
// policy/generate.mjs: the layer table's validator and, from it, the generated tool configs (ADR 0022; 2.1-M20,
// 2.1-M185, 2.1-M191; Phase 0 F1a).
//
// The layer table (policy/layers.json) gives every module path under desktop/web/src one layer, longest prefix wins.
// validateLayerTable() refuses, fail closed, anything the generated configs could not stand on:
//   table-missing     no policy/layers.json
//   table-unreadable  not JSON, not an object or no layers array
//   field             a top-level key other than $comment, version, layers, outside and packages (a `rules` key
//                     would register rows with check.mjs, 2.1-M222), or a row column outside its vocabulary
//                     (layer L0-L5 or test; rank only in L1 and L2; edition; status new; a phase rules.json lists,
//                     required with a destination or status new)
//   module-path       a path or destination that is not a relative module path (`..`, absolute, a backslash)
//   ambiguous         two rows for one path (a trailing slash aside)
//   unassigned        a file under desktop/web/src that no row's path covers
//   gone              a row or outside path that does not exist, unless the row is status new
//   new-exists        a status new row whose path exists (drop the status)
// Every code has a planted case under policy/fixtures/generate/, and `--self-test` fails a code without one.
//
//   node policy/generate.mjs              validate policy/layers.json; exit 1 on any refusal
//   node policy/generate.mjs --self-test  run the planted cases, then validate this repository's table
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyPath } from './check.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LAYER_TABLE = 'policy/layers.json';
export const SRC = 'desktop/web/src';
const WEB = 'desktop/web';
const CASES_DIR = 'policy/fixtures/generate';

export const REFUSALS = {
  'table-missing': 'no layer table',
  'table-unreadable': 'a layer table that is not JSON, not an object or has no layers array',
  field: 'a top-level key or row column outside the table vocabulary',
  'module-path': 'a path or destination that is not a relative module path',
  ambiguous: 'two rows for one path',
  unassigned: 'a source file no row covers',
  gone: 'a row or outside path that does not exist and is not marked new',
  'new-exists': 'a row marked new whose path exists',
};

const TOP_KEYS = new Set(['$comment', 'version', 'layers', 'outside', 'packages']);
const ROW_KEYS = new Set(['path', 'layer', 'rank', 'destination', 'phase', 'edition', 'status', 'entry', 'area', 'owner', 'note']);
const OUTSIDE_KEYS = new Set(['path', 'edition', 'entry', 'role']);
const LAYERS = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'test']);
const EDITIONS = new Set(['desktop', 'web', 'both', 'gallery']);
const PACKAGE_EDITIONS = new Set(['desktop', 'web']);
const PACKAGE_KEYS = new Set(['pattern', 'lowest_layer', 'owner', 'chunk', 'editions', 'rule', 'reason']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bare = (p) => (p.endsWith('/') ? p.slice(0, -1) : p);
/** A module path (one optional trailing slash) as check.mjs reads it, or undefined. */
const modulePath = (p) => (typeof p === 'string' && keyPath('path', bare(p)) !== undefined ? bare(p) : undefined);

/** The plan's phase labels (policy/rules.json `phases`); the phase column takes only these. */
function phases() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'policy/rules.json'), 'utf8')).phases);
  } catch {
    return new Set();
  }
}

function filesUnder(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
}

/** The row whose path covers `file` (longest prefix wins), or undefined. */
export function rowFor(rows, file) {
  let best;
  for (const row of rows) {
    const p = bare(row.path);
    const covers = row.path.endsWith('/') ? file.startsWith(`${p}/`) : file === p;
    if (covers && (!best || p.length > bare(best.path).length)) best = row;
  }
  return best;
}

/** Refusals ({code, where, message}) for the layer table under `root`. */
export function validateLayerTable(root = REPO_ROOT) {
  const where = LAYER_TABLE;
  const file = path.join(root, LAYER_TABLE);
  const refuse = (code, at, message) => ({ code, where: at, message });
  if (!fs.existsSync(file)) return [refuse('table-missing', where, 'the layer table is the one owner of the module layers (ADR 0022)')];
  let table;
  try {
    table = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return [refuse('table-unreadable', where, error.message)];
  }
  if (!isObject(table) || !Array.isArray(table.layers)) return [refuse('table-unreadable', where, 'no layers array')];

  const refusals = [];
  const known = phases();
  for (const key of Object.keys(table)) {
    if (!TOP_KEYS.has(key)) refusals.push(refuse('field', where, `top-level "${key}" is not a layer table key`));
  }
  const rows = [];
  const seen = new Map();
  table.layers.forEach((row, i) => {
    const at = `${where}#/layers/${i}`;
    if (!isObject(row)) return refusals.push(refuse('field', at, 'a row is an object'));
    const p = modulePath(row.path);
    if (p === undefined) return refusals.push(refuse('module-path', at, `path ${JSON.stringify(row.path)} is not a module path under ${SRC}`));
    for (const key of Object.keys(row)) if (!ROW_KEYS.has(key)) refusals.push(refuse('field', at, `"${key}" is not a row column`));
    if (!LAYERS.has(row.layer)) refusals.push(refuse('field', at, `layer ${JSON.stringify(row.layer)} is not one of ${[...LAYERS]}`));
    if (!EDITIONS.has(row.edition)) refusals.push(refuse('field', at, `edition ${JSON.stringify(row.edition)} is not one of ${[...EDITIONS]}`));
    if (row.rank !== undefined && !(['L1', 'L2'].includes(row.layer) && Number.isInteger(row.rank) && row.rank > 0)) {
      refusals.push(refuse('field', at, 'rank is a positive integer, in L1 and L2 only'));
    }
    if (row.status !== undefined && row.status !== 'new') refusals.push(refuse('field', at, 'status takes only "new"'));
    if (row.phase !== undefined && !known.has(row.phase)) refusals.push(refuse('field', at, `phase ${JSON.stringify(row.phase)} is not in policy/rules.json phases`));
    if ((row.destination !== undefined || row.status === 'new') && row.phase === undefined) {
      refusals.push(refuse('field', at, 'a destination or a new row names the phase that lands it'));
    }
    if (row.destination !== undefined && modulePath(row.destination) === undefined) {
      refusals.push(refuse('module-path', at, `destination ${JSON.stringify(row.destination)} is not a module path under ${SRC}`));
    }
    if (seen.has(p)) refusals.push(refuse('ambiguous', at, `${row.path} also has row ${seen.get(p)}`));
    else seen.set(p, i);
    const exists = fs.existsSync(path.join(root, SRC, p));
    if (row.status === 'new' && exists) refusals.push(refuse('new-exists', at, `${row.path} exists; drop status new`));
    if (row.status !== 'new' && !exists) refusals.push(refuse('gone', at, `${row.path} is not under ${SRC}; mark it new, give it a destination's row or delete the row`));
    rows.push(row);
  });
  (Array.isArray(table.outside) ? table.outside : []).forEach((row, i) => {
    const at = `${where}#/outside/${i}`;
    if (!isObject(row) || modulePath(row.path) === undefined) return refusals.push(refuse('module-path', at, `outside path is not a module path under ${WEB}`));
    for (const key of Object.keys(row)) if (!OUTSIDE_KEYS.has(key)) refusals.push(refuse('field', at, `"${key}" is not an outside column`));
    if (!EDITIONS.has(row.edition)) refusals.push(refuse('field', at, `edition ${JSON.stringify(row.edition)} is not one of ${[...EDITIONS]}`));
    if (!fs.existsSync(path.join(root, WEB, bare(row.path)))) refusals.push(refuse('gone', at, `${row.path} is not under ${WEB}`));
  });
  (Array.isArray(table.packages) ? table.packages : []).forEach((row, i) => {
    const at = `${where}#/packages/${i}`;
    if (!isObject(row) || typeof row.pattern !== 'string' || !row.pattern) return refusals.push(refuse('field', at, 'a package row has a pattern'));
    for (const key of Object.keys(row)) if (!PACKAGE_KEYS.has(key)) refusals.push(refuse('field', at, `"${key}" is not a package column`));
    if ((row.owner === undefined) === (row.lowest_layer === undefined)) refusals.push(refuse('field', at, 'a package row names an owner or a lowest_layer, not both'));
    if (row.lowest_layer !== undefined && !LAYERS.has(row.lowest_layer)) refusals.push(refuse('field', at, `lowest_layer ${JSON.stringify(row.lowest_layer)} is not a layer`));
    if (row.owner !== undefined && row.rule === undefined) refusals.push(refuse('field', at, 'an owner row names the rule that holds it'));
    if (!Array.isArray(row.editions) || !row.editions.length || !row.editions.every((e) => PACKAGE_EDITIONS.has(e))) {
      refusals.push(refuse('field', at, 'editions lists desktop, web or both'));
    }
  });
  for (const f of filesUnder(path.join(root, SRC))) {
    if (!rowFor(rows, f)) refusals.push(refuse('unassigned', `${SRC}/${f}`, 'no layer table row covers it; add a row (ADR 0022: every path has one layer)'));
  }
  return refusals;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test

/** Writes a case's files ({path: text or JSON value}) under a fresh temporary root. */
function plant(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-generate-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

/** Runs the planted cases, then this repository's table; returns {failures, missing}. */
export function selfTest(casesRoot = path.join(REPO_ROOT, CASES_DIR), log = () => {}) {
  const failures = [];
  const covered = new Set();
  for (const name of (fs.existsSync(casesRoot) ? fs.readdirSync(casesRoot) : []).sort()) {
    if (!name.endsWith('.json')) {
      log(`FAIL ${name}: a case is a .json file`);
      failures.push(name);
      continue;
    }
    const kase = JSON.parse(fs.readFileSync(path.join(casesRoot, name), 'utf8'));
    const expected = [...new Set(kase.expect)].sort();
    expected.forEach((code) => covered.add(code));
    const root = plant(kase.files ?? {});
    let got;
    try {
      got = [...new Set(validateLayerTable(root).map((r) => r.code))].sort();
    } catch (error) {
      got = [`threw: ${error.message}`];
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: expected [${expected}], got [${got}]`}`);
    if (!ok) failures.push(name);
  }
  const own = validateLayerTable(REPO_ROOT);
  for (const r of own) log(`FAIL repository ${r.code}: ${r.where}: ${r.message}`);
  if (!own.length) log(`ok   ${LAYER_TABLE} validates`);
  else failures.push(LAYER_TABLE);
  const missing = Object.keys(REFUSALS).filter((code) => !covered.has(code));
  return { failures, missing };
}

function main(argv) {
  if (argv.includes('--self-test')) {
    const { failures, missing } = selfTest(undefined, (line) => console.log(line));
    for (const code of missing) console.error(`${code} has no planted case under ${CASES_DIR}/`);
    console.log(failures.length || missing.length ? 'generate self-test: RED' : 'generate self-test: OK');
    return failures.length || missing.length ? 1 : 0;
  }
  const refusals = validateLayerTable();
  for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
  console.log(`layer table: ${refusals.length ? 'RED' : 'OK'}`);
  return refusals.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
