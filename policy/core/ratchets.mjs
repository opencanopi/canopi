// policy/core/ratchets.mjs: the ratchet family files (2.1-M348): every refusal the checker can give, the key kinds,
// the loader with its family checks, the layer table's moves and compare(), which holds a family to what its tool
// observes.
import fs from 'node:fs';
import path from 'node:path';
import { isObject, isRepoPath, LAYER_TABLE, RATCHETS_DIR, adapterFile, refusal, REPO_ROOT, RefusalError, SCHEMA_FILE } from './base.mjs';
import { listFiles } from './exec.mjs';
import { matchesGlob } from './globs.mjs';
import { SchemaKeywordError, validate } from './schema.mjs';

/** Every refusal the checker can give; `--self-test` fails a code with no planted case. */
export const REFUSALS = {
  schema: 'a family file the ratchet schema refuses',
  'schema-keyword': 'the schema uses a keyword the validator does not implement',
  'missing-source': 'the ratchet directory, its schema or policy/rules.json is missing',
  unreadable: 'a family file that is not JSON, or a tracker export line that is not a JSON record',
  'family-name': 'a family named unlike its file',
  key: 'an entry key that does not read as its family\'s key kind',
  'path-drift': 'an entry path or a scope glob that matches no file',
  'path-filter-matches-a-file': 'a workflow paths or paths-ignore glob, a vitest coverage glob or a cargo-llvm-cov exclude alternative that matches no file (core/path-filters.mjs)',
  'out-of-scope': 'an entry path outside its family\'s scope',
  'no-adapter': 'a family whose tool has no adapter at policy/adapters/<tool>.mjs',
  unlisted: 'a site in a file or under a name the family does not list',
  rising: 'more sites than the entry or count allows',
  falling: 'fewer sites than the entry or count, which was not lowered',
  stale: 'a listed entry that no longer occurs (an unused exemption)',
  'observed-shape': 'a reporter result that is not the family\'s shape',
  'over-budget': 'a budget family\'s value above its ceiling times one plus its tolerance',
  'below-floor': 'a floor family\'s value below its floor',
  'floor-globs': 'a floor family\'s tool measured over include or exclusion patterns the family does not hold',
  'layer-table': 'a layer table whose moves cannot be read (no layers array, or a path or destination not a module path)',
  'rules-table': 'a policy table whose top-level rules is not an array of rows, each with an id',
  'refused-site': 'a site its adapter refuses whatever the baseline (a suppression naming no rule, a #![expect] for a ratcheted lint)',
  'adapter-contract': 'an adapter without the collect() a ratchet family needs or the measure() a budget or floor family needs',
  'tool-failed': 'a tool that could not run or report (not installed, no config, unreadable output)',
  'reporter-exit': 'a reporter that exits 0 while reporting errors',
  'duplicate-rule': 'one rule id in two policy tables',
  'missing-rule': 'a policy table row naming a family whose file policy/ratchets/<family>.json is missing',
  'owner-path': 'a policy table row whose owner_today (a path or none) or example names no file or directory',
  'phase-label': 'an owner_target phase or a --phase-close phase that rules.json\'s phases does not list',
  'phase-close': 'at --phase-close, a row whose owner_target phase has come while owner_today is not its target path or it is still planned, or a family whose row says phase_close: empty still holding entries',
  'phase-marker': 'at --phase-close, a "to be created by Phase N" marker in tracked Markdown whose phase is the closing one or earlier (policy/phase-markers.mjs)',
  'no-planted': 'a rule with no planted violation under policy/fixtures/rules/<rule>/',
  'stray-planted': 'a planted directory under policy/fixtures/rules/ that names no rule',
  'planted-silent': 'a planted violation its rule does not fail on, run through its tool with the real config',
  'glob-engine': 'the glob engine (picomatch) is not installed in desktop/web/node_modules',
  'lane-unrun': 'a lane a family or a planted case\'s toolLane uses that no check an area of the gate table (policy/gate/table.ts) runs runs as both the check and the self-test',
  'mode-conflict': '--closed-beads named with --lane or --family: the closed-bead check reads no lane or family, so the run would check less than it says',
  'unlocked-cli': 'a package.json script, or a workflow, composite action or scripts-directory script line, that fetches or pins a locked CLI (@tauri-apps/cli) itself instead of running desktop/web\'s devDependency',
  'closed-bead': 'a family entry, policy table row, planned inventory row or suite, or open upstream row\'s planned pin citing a bead that .beads/issues.jsonl records as closed',
  'absent-bead': 'a bead cited by a family file or a policy table that .beads/issues.jsonl does not hold (skipped with no export; a ledger cell or test title is the commit gate\'s gate-absent-bead)',
};

// ---------------------------------------------------------------------------------------------------------------
// Keys: `path` (a repository-relative file), `path-rule` (`<path>: <tool>:<rule>`, the suppressions shape) or `name`
// (a named edge or symbol, never a path: no drift check; the layer table's module moves rename its module paths).

const PATH_RULE = /^(.+): ([a-z][a-z0-9-]*):(\S+)$/;

/** The file a key names, or null for a name key; undefined when the key does not read as its kind. */
export function keyPath(kind, key) {
  if (kind === 'name') return null;
  if (kind === 'path') return isRepoPath(key) ? key : undefined;
  const match = PATH_RULE.exec(key);
  return match && isRepoPath(match[1]) ? match[1] : undefined;
}

/** Replaces the path in a path or path-rule key. */
export function withKeyPath(kind, key, newPath) {
  return kind === 'path' ? newPath : key.replace(PATH_RULE, (_, _old, tool, rule) => `${newPath}: ${tool}:${rule}`);
}

/** Refusals for a schema-valid family: its file name, tool adapter, key grammar, path drift and scope. */
function checkFamily(file, doc, files) {
  const refusals = [];
  const stem = path.basename(file, '.json');
  if (doc.family !== stem) {
    refusals.push(refusal('family-name', file, `family "${doc.family}" lives in ${stem}.json; name the file ${doc.family}.json`));
  }
  const present = new Set(files);
  if (!present.has(adapterFile(doc.tool))) {
    refusals.push(refusal('no-adapter', file, `tool ${doc.tool} has no adapter; add ${adapterFile(doc.tool)} with the family`));
  }
  for (const glob of doc.scope) {
    if (!files.some((f) => matchesGlob(f, glob))) {
      refusals.push(refusal('path-drift', file, `scope glob ${glob} matches no file`));
    }
  }
  for (const key of Object.keys(doc.entries ?? {})) {
    const p = keyPath(doc.keys, key);
    if (p === undefined) {
      refusals.push(refusal('key', file, `"${key}" is not a ${doc.keys} key${doc.keys === 'path-rule' ? ' (<path>: <tool>:<rule>)' : ''}`));
    } else if (p !== null && !present.has(p)) {
      refusals.push(refusal('path-drift', file, `"${key}" names ${p}, which no longer exists; rename or remove the entry`));
    } else if (p !== null && !doc.scope.some((glob) => matchesGlob(p, glob))) {
      refusals.push(refusal('out-of-scope', file, `"${key}" is outside the scope ${doc.scope.join(', ')}`));
    }
  }
  return refusals;
}

// ---------------------------------------------------------------------------------------------------------------
// Layer table moves

/** A module path without its one optional trailing slash, or undefined when it is not a relative path. */
function modulePath(p) {
  if (typeof p !== 'string') return undefined;
  const bare = p.endsWith('/') ? p.slice(0, -1) : p;
  return isRepoPath(bare) ? bare : undefined;
}

/** Old module path -> destination from the layer table's text; throws a `layer-table` RefusalError it cannot read. */
export function layerMoves(text, where) {
  let table;
  try {
    table = JSON.parse(text);
  } catch (error) {
    throw new RefusalError('layer-table', where, error.message);
  }
  if (!isObject(table) || !Array.isArray(table.layers)) throw new RefusalError('layer-table', where, 'no layers array');
  const moves = new Map();
  table.layers.forEach((row, i) => {
    const from = modulePath(isObject(row) ? row.path : undefined);
    if (from === undefined) throw new RefusalError('layer-table', where, `/layers/${i}/path: not a module path`);
    if (row.destination === undefined || row.destination === null) return;
    const to = modulePath(row.destination);
    if (to === undefined) throw new RefusalError('layer-table', where, `/layers/${i}/destination: not a module path`);
    moves.set(from, to);
  });
  return moves;
}

/** `p` moved by `renames`: its exact rename (a file, git -M), else the longest renamed directory holding it. */
export function movePath(p, renames) {
  if (renames.has(p)) return renames.get(p);
  let dir;
  for (const from of renames.keys()) if (p.startsWith(`${from}/`) && (dir === undefined || from.length > dir.length)) dir = from;
  return dir === undefined ? p : `${renames.get(dir)}${p.slice(dir.length)}`;
}

/** The layer table's moves in the working tree under `root`; none when there is no table (a revision's: core/diff). */
export function layerMovesAt(root) {
  const file = path.join(root, LAYER_TABLE);
  return fs.existsSync(file) ? layerMoves(fs.readFileSync(file, 'utf8'), LAYER_TABLE) : new Map();
}

// ---------------------------------------------------------------------------------------------------------------
// Loader

/** Loads every family file under `root`/policy/ratchets/; returns { families: Map(family -> doc), refusals }. */
export function loadRatchets(root = REPO_ROOT) {
  const refusals = [];
  const families = new Map();
  const dir = path.join(root, RATCHETS_DIR);
  if (!fs.existsSync(dir)) return { families, refusals: [refusal('missing-source', RATCHETS_DIR, 'no ratchet directory')] };
  if (!fs.existsSync(path.join(root, SCHEMA_FILE))) {
    return { families, refusals: [refusal('missing-source', SCHEMA_FILE, 'no ratchet schema')] };
  }
  const schema = JSON.parse(fs.readFileSync(path.join(root, SCHEMA_FILE), 'utf8'));
  try {
    layerMovesAt(root);
  } catch (error) {
    if (!(error instanceof RefusalError)) throw error;
    refusals.push(refusal(error.code, error.where, error.message));
  }
  const files = listFiles(root);
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json')).sort();
  for (const name of names) {
    const file = `${RATCHETS_DIR}/${name}`;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (error) {
      refusals.push(refusal('unreadable', file, error.message));
      continue;
    }
    let errors;
    try {
      errors = validate(schema, doc);
    } catch (error) {
      if (!(error instanceof SchemaKeywordError)) throw error;
      refusals.push(refusal('schema-keyword', SCHEMA_FILE, error.message));
      break;
    }
    if (errors.length) {
      for (const e of errors) refusals.push(refusal('schema', file, e));
      continue;
    }
    const familyRefusals = checkFamily(file, doc, files);
    refusals.push(...familyRefusals);
    if (familyRefusals.length === 0) families.set(doc.family, { file, doc });
  }
  return { families, refusals };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison

const isCount = (n) => Number.isInteger(n) && n >= 0;
const isMeasure = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const listedCount = (entry) => entry.count ?? 1;

/** A family's kind and shape: named entries, one count, budgets or floors (2.1-M222). */
export function shapeOf(doc) {
  return ['entries', 'count', 'budgets', 'floors'].find((field) => field in doc);
}

export const sameSet = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** A budget family: only a value above its ceiling times one plus its tolerance fails; a fall never does. */
function compareBudgets(doc, observed, where) {
  if (!isObject(observed) || !Object.values(observed).every(isMeasure)) {
    return [refusal('observed-shape', where, 'the reporter gave no {key: number} map for a budget family')];
  }
  const refusals = [];
  for (const [key, value] of Object.entries(observed)) {
    const budget = doc.budgets[key];
    if (!budget) {
      refusals.push(refusal('unlisted', where, `"${key}" measures ${value} and has no budget; add one with a bead and a Q row`));
    } else if (value > budget.ceiling * (1 + budget.tolerance)) {
      refusals.push(refusal('over-budget', where, `"${key}" measures ${value}, above its ceiling ${budget.ceiling} with tolerance ${budget.tolerance}`));
    }
  }
  for (const key of Object.keys(doc.budgets)) {
    if (!(key in observed)) refusals.push(refusal('stale', where, `"${key}" is no longer measured; remove its budget`));
  }
  return refusals;
}

/**
 * A floor family: `observed` is {tool: {values: {metric: number}, include?, exclude?}}. A value below its floor fails
 * and a raise is free; patterns the reporter gives must equal the family's, so a planted exclusion fails; a tool the
 * family holds floors for and the reporter did not measure is stale, so a narrowed scope cannot drop its floors.
 */
function compareFloors(doc, observed, where) {
  const shaped = isObject(observed) && Object.values(observed).every((o) => isObject(o) && isObject(o.values)
    && Object.values(o.values).every(isMeasure)
    && ['include', 'exclude'].every((f) => o[f] === undefined || (Array.isArray(o[f]) && o[f].every((g) => typeof g === 'string'))));
  if (!shaped) return [refusal('observed-shape', where, 'the reporter gave no {tool: {values}} map for a floor family')];
  const refusals = [];
  for (const [tool, got] of Object.entries(observed)) {
    const held = doc.floors[tool];
    if (!held) {
      refusals.push(refusal('unlisted', where, `${tool} reports coverage and the family holds no floors for it`));
      continue;
    }
    for (const [metric, floor] of Object.entries(held.floors)) {
      const value = got.values[metric];
      if (value === undefined) refusals.push(refusal('observed-shape', where, `${tool} gave no ${metric}`));
      else if (value < floor) refusals.push(refusal('below-floor', where, `${tool} ${metric} ${value} is below its floor ${floor}`));
    }
    for (const field of ['include', 'exclude']) {
      if (got[field] !== undefined && !sameSet(got[field], held[field])) {
        refusals.push(refusal('floor-globs', where, `${tool} ${field} is ${JSON.stringify(got[field])}; the family holds ${JSON.stringify(held[field] ?? [])}`));
      }
    }
  }
  for (const tool of Object.keys(doc.floors)) {
    if (!(tool in observed)) refusals.push(refusal('stale', where, `${tool} is no longer measured; measure its config or remove its floors`));
  }
  return refusals;
}

/**
 * Observed sites against a loaded family: the file must equal what the tool sees, so it only shrinks and is never
 * stale. `observed` is a count for a count family, else `{key: count}` from the family's adapter.
 */
export function compare(doc, observed) {
  const where = `${RATCHETS_DIR}/${doc.family}.json`;
  if (shapeOf(doc) === 'budgets') return compareBudgets(doc, observed, where);
  if (shapeOf(doc) === 'floors') return compareFloors(doc, observed, where);
  if (!('entries' in doc)) {
    if (!isCount(observed)) return [refusal('observed-shape', where, 'the reporter gave no count for a count family')];
    if (observed > doc.count) return [refusal('rising', where, `${observed} sites, above the count ${doc.count}`)];
    if (observed < doc.count) {
      return [refusal('falling', where, `${observed} sites, below the count ${doc.count}; lower the count to ${observed}`)];
    }
    return [];
  }
  if (!isObject(observed) || !Object.values(observed).every(isCount)) {
    return [refusal('observed-shape', where, 'the reporter gave no {key: whole count} map for a named family')];
  }
  const refusals = [];
  for (const [key, n] of Object.entries(observed)) {
    if (n === 0) continue;
    const entry = doc.entries[key];
    if (!entry) {
      refusals.push(refusal('unlisted', where, `"${key}" has ${n} site(s) and no entry; remove them, or add the entry with a bead and a Q row`));
    } else if (n > listedCount(entry)) {
      refusals.push(refusal('rising', where, `"${key}" has ${n} site(s), above its ${listedCount(entry)}`));
    } else if (n < listedCount(entry)) {
      refusals.push(refusal('falling', where, `"${key}" has ${n} site(s), below its ${listedCount(entry)}; lower the entry to ${n}`));
    }
  }
  for (const key of Object.keys(doc.entries)) {
    if (!observed[key]) refusals.push(refusal('stale', where, `"${key}" no longer occurs; remove the entry`));
  }
  return refusals;
}
