#!/usr/bin/env node
// policy/check.mjs: the fail-closed policy checker (contracts §12; 2.1-M186, 2.1-M191; ADR 0028 Generated rules).
//
// It reads the ratchet family files in policy/ratchets/ (one JSON file per family, shaped by ratchet.schema.json)
// and refuses anything it cannot vouch for: a missing or unreadable table, a file the schema refuses, a schema
// keyword its validator does not implement, a misnamed family, a tool with no adapter, a bad key, path drift and an
// entry out of scope, a lane in use that no desktop/web/package.json script runs, a missing policy/rules.json or one without rows and a row there naming a family whose file is
// gone (the required rules live there, never here: 2.1-M223), a planned row naming no phase, a rule with no planted
// violation under policy/fixtures/rules/<rule>/ or a planted directory naming no rule. Scope globs match dot paths too. Family kinds share the schema: ratchet (entries or a count), budget
// (ceilings) and floor (2.1-M222).
// compare() holds a family to what its tool observes (the file only shrinks and is never stale); diffRatchets()
// names each change between two revisions for the gate. Every refusal and change has a planted case under
// policy/fixtures/check/, and `--self-test` fails one without, so neither can exist untested.
//
//   node policy/check.mjs [--lane push|ci | --family <id>...]
//                                      load and validate every family file and policy table, then hold each observed
//                                      family (policy/selection.mjs: commit-lane, every lane up to the one named, or
//                                      the named families) to what its adapter observes; exit 1 on any refusal
//   node policy/check.mjs --self-test [--lane push|ci | --family <id>...]
//                                      run the planted cases in policy/fixtures/check/ (none with --family), then each
//                                      observed rule's planted violation through its real tool and config, failing one
//                                      its rule does not fail; a case whose real tools need a later lane (`toolLane`,
//                                      push for a Rust toolchain) is skipped and still covers its codes
//   node policy/check.mjs --phase-close <phase>
//                                      the default check, also refusing each policy table row whose owner_target phase
//                                      is <phase> or earlier in rules.json's `phases` while owner_today is not its
//                                      target path or the row is still planned, and a phase label that list lacks
//                                      (2.1-M223)
//   node policy/check.mjs --list-rules one rule id per line, the registry check_docs.py queries (never committed): the
//                                      checker's id, each family and each policy table's `rules` row (2.1-M222); a
//                                      planned row prints as `<id> planned` (2.1-M223)
//   node policy/check.mjs --diff <base> [<head>]
//                                      one JSON line per change between the family files at <base> and at <head>
//                                      (the working tree when omitted), entries renamed by git -M or by a move in the
//                                      layer table at either revision; the gate (F3b) decides which need a bead and a Q row
//
// Policy tables (policy/*.json with a top-level `rules` array) register rules by rows, never by editing this file:
// policy/rules.json holds the required rows, each naming its family, and the plan's phase order (`phases`); F1a adds
// its rows there and F1b's primitives.json holds the primitive rows (loadTableRules).
//
// The layer table (policy/layers.json, ADR 0022) is read here for its moves only: rows under `layers`, each with a
// module `path` relative to desktop/web/src (a trailing slash allowed) and an optional `destination` in the same
// coordinates; other columns and sections are its owner's. A table this reading refuses fails the load and the diff.
//
// The lanes, --family and the package scripts that must run them (`lane-unrun`) live in policy/selection.mjs.
// `npm run test:policies` runs the commit lane (the Frontend gate and CI's source-policy step; no Rust toolchain);
// `npm run test:policies:push` the push lane, whose disallowed-methods family runs clippy (the Rust gate, with
// CANOPI_SKIP_BUNDLED_DB=1); `npm run test:policies:bundle` the ci-lane bundle-size family once both editions are built.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { familyArgs, laneArg, LANE_RUNNERS, LANES, lanesUpTo, observer, unrunLanes } from './selection.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RATCHETS_DIR = 'policy/ratchets';
export const SCHEMA_FILE = `${RATCHETS_DIR}/ratchet.schema.json`;
export const LAYER_TABLE = 'policy/layers.json';
/** A tool's adapter, the registry of tools: a family's tool is valid only with one. */
export const adapterFile = (tool) => `policy/adapters/${tool}.mjs`;
/** The directory the layer table's module paths are relative to. */
const MODULE_ROOT = 'desktop/web/src';
const CASES_DIR = 'policy/fixtures/check';
/** Planted violations and recorded tool output: never a family's site, whatever its scope. */
export const FIXTURES_DIR = 'policy/fixtures';

/** Every refusal the checker can give; `--self-test` fails a code with no planted case. */
export const REFUSALS = {
  schema: 'a family file the ratchet schema refuses',
  'schema-keyword': 'the schema uses a keyword the validator does not implement',
  'missing-source': 'the ratchet directory, its schema or policy/rules.json is missing',
  unreadable: 'a family file that is not JSON',
  'family-name': 'a family named unlike its file',
  key: 'an entry key that does not read as its family\'s key kind',
  'path-drift': 'an entry path or a scope glob that matches no file',
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
  'phase-close': 'at --phase-close, a row whose owner_target phase has come while owner_today is not its target path or it is still planned',
  'no-planted': 'a rule with no planted violation under policy/fixtures/rules/<rule>/',
  'stray-planted': 'a planted directory under policy/fixtures/rules/ that names no rule',
  'planted-silent': 'a planted violation its rule does not fail on, run through its tool with the real config',
  'lane-unrun': 'a lane a family or a planted case\'s toolLane uses that no desktop/web/package.json script runs as both the check and the self-test',
};

/**
 * Every change a base-to-head diff of the family files can name (`--diff`); the gate (F3b) decides which need a
 * bead and a Q row. `--self-test` fails a change with no planted case.
 */
export const CHANGES = {
  created: 'a family file new at head: its first baseline (2.1-M40)',
  deleted: 'a family file gone at head',
  header: 'a changed version, ledger, tool, scope, lane, key kind or shape; only a key kind or shape hides the entries',
  added: 'an entry new at head that is not a rename',
  raised: 'an entry or count above its base value',
  lowered: 'an entry or count below its base value',
  removed: 'an entry gone at head that was not renamed',
  renamed: 'an entry moved by git -M or the layer table at the same or a lower count (2.1-M74)',
  'floor-globs': 'a floor family\'s include or exclusion patterns changed',
};

/**
 * Runs git in `cwd` and nowhere else. A hook exports GIT_DIR and GIT_INDEX_FILE (a linked worktree's hook names the
 * real repository), so every GIT_* variable is dropped; signing is off so a developer's config cannot break or stall
 * the planted cases' commits and tags.
 */
const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
  cwd,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
});
const refusal = (code, where, message) => ({ code, where, message });

/** A refusal thrown where no refusal list is returned (the diff). */
class RefusalError extends Error {
  constructor(code, where, message) {
    super(`${code}: ${where}: ${message}`);
    Object.assign(this, { code, where });
  }
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema subset. Unknown keywords throw, so the schema cannot ask for a check the validator silently skips.

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set([
  'type', 'const', 'enum', 'pattern', 'minimum', 'maximum', 'minLength', 'minItems', 'minProperties', 'uniqueItems', 'items',
  'required', 'properties', 'additionalProperties', 'propertyNames', 'oneOf',
]);

class SchemaKeywordError extends Error {}

const typeOk = {
  object: isObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
};

/** The errors `value` has against `schema`, each `<json pointer>: <reason>`; throws SchemaKeywordError. */
export function validate(schema, value, at = '') {
  if (schema === true) return [];
  if (schema === false) return [`${at || '/'}: not allowed`];
  const unknown = Object.keys(schema).filter((k) => !KEYWORDS.has(k) && !ANNOTATIONS.has(k));
  if (unknown.length) throw new SchemaKeywordError(`unsupported schema keyword ${unknown.join(', ')} at ${at || '/'}`);
  const where = at || '/';
  if (schema.type !== undefined) {
    if (!typeOk[schema.type]) throw new SchemaKeywordError(`unsupported type ${schema.type} at ${where}`);
    if (!typeOk[schema.type](value)) return [`${where}: must be ${schema.type}`];
  }
  const errors = [];
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${where}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${where}: must be one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${where}: must match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: too short`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${where}: must be at least ${schema.minimum}`);
  }
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${where}: must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${where}: needs at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${where}: items must be unique`);
    }
    if (schema.items !== undefined) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}/${i}`)));
  }
  if (isObject(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${where}: needs at least ${schema.minProperties} field(s)`);
    }
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${where}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      const child = `${at}/${key}`;
      if (schema.propertyNames !== undefined) errors.push(...validate(schema.propertyNames, key, `${child} (name)`));
      if (schema.properties && key in schema.properties) errors.push(...validate(schema.properties[key], v, child));
      else if (schema.additionalProperties !== undefined) {
        errors.push(...(schema.additionalProperties === false
          ? [`${child}: unknown field`]
          : validate(schema.additionalProperties, v, child)));
      }
    }
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((branch) => validate(branch, value, at));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing !== 1) {
      const closest = results.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(passing === 0
        ? `${where}: matches no shape (${closest.join('; ')})`
        : `${where}: matches ${passing} shapes; give exactly one`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// Keys: `path` (a repository-relative file), `path-rule` (`<path>: <tool>:<rule>`, the suppressions shape) or `name`
// (a named edge or symbol, never a path: no drift check; the layer table's module moves rename its module paths).

const PATH_RULE = /^(.+): ([a-z][a-z0-9-]*):(\S+)$/;

function isRepoPath(p) {
  return p.trim() === p && !p.startsWith('/') && !p.endsWith('/') && !p.includes('\\') && !p.includes(': ')
    && p.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

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

/**
 * A scope glob as an anchored RegExp: `**` any number of whole segments, `*` and `?` within one segment, `{a,b}`
 * alternatives, `[...]` a class (`[!...]` negated). Unlike path.matchesGlob, a wildcard matches a segment that
 * starts with a dot, so `**` reaches .github/, .cargo/ and every dotfile a family must count.
 */
export function globRegExp(glob) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const segmentStart = i === 0 || glob[i - 1] === '/';
    if (c === '*' && glob[i + 1] === '*' && segmentStart && (glob[i + 2] === '/' || i + 2 === glob.length)) {
      if (glob[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') { out += '(?:'; depth++; } else if (c === '}' && depth) { out += ')'; depth--; } else if (c === ',' && depth) out += '|';
    else if (c === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, end);
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else out += c.replace(/[\\^$.|+()[\]{}]/, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

/** Whether the repository path `p` matches the scope glob `glob`, dot segments included. */
export const matchesGlob = (p, glob) => globRegExp(glob).test(p);

/**
 * The files under the git work tree `root` a scope glob can match: tracked and unignored files still on disk. A
 * tracked file deleted or moved without staging is gone, so its entry is path drift. Outside git this throws.
 */
function listFiles(root) {
  const ls = (...args) => git(root, ['ls-files', '-z', ...args]).split('\0').filter(Boolean);
  const deleted = new Set(ls('--deleted'));
  return ls('--cached', '--others', '--exclude-standard').filter((f) => !deleted.has(f));
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
function layerMoves(text, where) {
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

/** The layer table's moves at a revision or (rev omitted) in the working tree; none when there is no table. */
function layerMovesAt(root, rev) {
  if (rev) {
    if (!git(root, ['ls-tree', '--name-only', rev, '--', LAYER_TABLE]).trim()) return new Map();
    return layerMoves(git(root, ['show', `${rev}:${LAYER_TABLE}`]), `${rev}:${LAYER_TABLE}`);
  }
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
// Registry

/** This checker's own rule id, the name the ADRs and guides use for it. */
export const CHECKER_ID = 'policy-tables-check';

const POLICY_DIR = 'policy';
/** The table that holds the required rows and the plan's phase order. */
export const RULES_TABLE = `${POLICY_DIR}/rules.json`;
const RULE_ID = /^\S+$/u;
/** A row's `owner_today` when the primitive has no owner yet and 0 sites are allowed. */
const NO_OWNER = 'none';

/** A row path without its one optional trailing slash: a file or a directory relative to the repository. */
const rowPath = (p) => (typeof p === 'string' && p.endsWith('/') ? p.slice(0, -1) : p);

/** Refusals for a row's own fields: its status, family, owner and example paths and owner_target phase. */
function checkRow(row, i, table, { root, files, phases }) {
  const at = `/rules/${i}`;
  if ('status' in row && row.status !== 'planned') {
    return [refusal('rules-table', table, `${at}: status is "planned" or absent, not ${JSON.stringify(row.status)}`)];
  }
  if ('family' in row && (typeof row.family !== 'string' || !RULE_ID.test(row.family))) {
    return [refusal('rules-table', table, `${at}: family names one family file, ${RATCHETS_DIR}/<family>.json`)];
  }
  const target = row.owner_target;
  if (target !== undefined && !(isObject(target) && typeof target.path === 'string' && typeof target.phase === 'string')) {
    return [refusal('rules-table', table, `${at}: owner_target is {path, phase, bead?}`)];
  }
  if (row.status === 'planned' && target === undefined) {
    return [refusal('rules-table', table, `${at}: a planned row names the phase it becomes a rule in, owner_target {path, phase, bead?}`)];
  }
  const refusals = [];
  const exists = (p) => isRepoPath(p) && files.some((f) => f === p || f.startsWith(`${p}/`));
  for (const field of ['owner_today', 'example']) {
    if (!(field in row)) continue;
    const p = rowPath(row[field]);
    if (field === 'owner_today' && p === NO_OWNER) continue;
    if (!exists(p)) refusals.push(refusal('owner-path', table, `${row.id}: ${field} ${JSON.stringify(row[field])} names no file or directory${field === 'owner_today' ? ` (write "${NO_OWNER}" for a primitive with no owner yet)` : ''}`));
  }
  if (target && !phases.includes(target.phase)) {
    refusals.push(refusal('phase-label', table, `${row.id}: owner_target phase ${target.phase} is not one of ${RULES_TABLE}'s phases`));
  }
  if (row.status !== 'planned' && row.family !== undefined && !fs.existsSync(path.join(root, RATCHETS_DIR, `${row.family}.json`))) {
    refusals.push(refusal('missing-rule', table, `rule ${row.id}${row.ledger ? ` (${row.ledger})` : ''} names family ${row.family}, and ${RATCHETS_DIR}/${row.family}.json is missing`));
  }
  return refusals;
}

/**
 * The rules the policy tables declare (2.1-M222, 2.1-M223): each `policy/*.json` table's top-level `rules` array of rows
 * with an `id` (rules.json, F1b's primitives.json); another table without `rules` declares none, but rules.json must
 * exist and hold rows, since the required rules are its rows.
 *   - `family` names the ratchet family that enforces the row, and that family's file must exist: the required rules
 *     are these rows, so deleting a family file, with or without its planted directory, fails every mode.
 *   - `"status": "planned"` marks a rule whose owner is not built yet: it generates no rule, needs no planted
 *     violation, adapter or family until its phase (its owner_target, which it must have; --phase-close refuses it
 *     once that phase closes), and --list-rules shows it as planned.
 *   - `owner_today` (an existing path, or `none`) and `example` must exist; `owner_target: {path, phase, bead}` names a
 *     phase from rules.json's `phases`, the plan's labels in the order the plan lists them, a phase after its streams.
 * Returns { rules: Map(id -> {table, row}) of active rows, planned: Map of planned rows, phases, refusals }.
 */
export function loadTableRules(root = REPO_ROOT) {
  const rules = new Map();
  const planned = new Map();
  const refusals = [];
  const dir = path.join(root, POLICY_DIR);
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort()
    : [];
  const docs = [];
  for (const name of names) {
    const table = `${POLICY_DIR}/${name}`;
    try {
      docs.push({ table, doc: JSON.parse(fs.readFileSync(path.join(root, table), 'utf8')) });
    } catch (error) {
      refusals.push(refusal('unreadable', table, error.message));
    }
  }
  // The required rules are rules.json's rows: a missing table, or one without rows, would drop them unrefused.
  const required = docs.find((d) => d.table === RULES_TABLE);
  const hasRows = (doc) => isObject(doc) && Array.isArray(doc.rules) && doc.rules.length > 0;
  if (!fs.existsSync(path.join(root, RULES_TABLE))) {
    refusals.push(refusal('missing-source', RULES_TABLE, 'no rules table: the required rules are its rows'));
  } else if (required && !hasRows(required.doc)) {
    refusals.push(refusal('rules-table', RULES_TABLE, 'rules is a non-empty array of rows: the required rules are its rows'));
  }
  let phases = [];
  const order = required?.doc?.phases;
  if (order !== undefined) {
    if (Array.isArray(order) && order.every((p) => typeof p === 'string' && RULE_ID.test(p)) && new Set(order).size === order.length) phases = order;
    else refusals.push(refusal('rules-table', RULES_TABLE, 'phases is an array of distinct phase labels, in the plan\'s order'));
  }
  const files = docs.length ? listFiles(root) : [];
  for (const { table, doc } of docs) {
    if (!isObject(doc) || !('rules' in doc) || (table === RULES_TABLE && !hasRows(doc))) continue;
    if (!Array.isArray(doc.rules)) {
      refusals.push(refusal('rules-table', table, 'rules is not an array'));
      continue;
    }
    doc.rules.forEach((row, i) => {
      if (!isObject(row) || typeof row.id !== 'string' || !RULE_ID.test(row.id)) {
        refusals.push(refusal('rules-table', table, `/rules/${i}: a row needs an id, one word`));
        return;
      }
      const seen = rules.get(row.id) ?? planned.get(row.id);
      if (seen) {
        refusals.push(refusal('duplicate-rule', table, `${row.id} is also a rule of ${seen.table}`));
        return;
      }
      const rowRefusals = checkRow(row, i, table, { root, files, phases });
      refusals.push(...rowRefusals);
      if (rowRefusals.some((r) => r.code === 'rules-table')) return;
      (row.status === 'planned' ? planned : rules).set(row.id, { table, row });
    });
  }
  return { rules, planned, phases, refusals };
}

/**
 * `--phase-close <phase>`: refuses each row, planned or not, whose owner_target phase is `phase` or earlier in
 * rules.json's order while its owner_today is not its owner_target path, or while it is still planned, so it would
 * never become a rule (2.1-M223); and a phase the order lacks.
 */
export function phaseCloseRefusals(tables, phase) {
  const at = tables.phases.indexOf(phase);
  if (at === -1) return [refusal('phase-label', RULES_TABLE, `--phase-close ${phase}: not one of the phases ${tables.phases.join(', ')}`)];
  const refusals = [];
  for (const { table, row } of [...tables.rules.values(), ...tables.planned.values()]) {
    const target = row.owner_target;
    if (!target || tables.phases.indexOf(target.phase) > at) continue;
    const bead = target.bead ? ` (${target.bead})` : '';
    if (rowPath(row.owner_today) !== rowPath(target.path)) {
      refusals.push(refusal('phase-close', table, `${row.id}: phase ${target.phase} closes with its owner at ${row.owner_today ?? '(no owner_today)'}, not ${target.path}${bead}`));
    } else if (row.status === 'planned') {
      refusals.push(refusal('phase-close', table, `${row.id}: phase ${target.phase} closes with the row still planned; drop its status so the rule runs${bead}`));
    }
  }
  return refusals;
}

/**
 * The rule registry `check_docs.py` queries (2.1-M186): this checker's id, every family id and every policy table's
 * rule ids, sorted, each once (a family ratcheting a table's rule shares its id); a planned row is listed as
 * `<id> planned`. It is computed from the tables on each call and never committed; a refused table gives refusals and
 * no partial list.
 */
export function listRules(root = REPO_ROOT) {
  const { families, refusals } = loadRatchets(root);
  const tables = loadTableRules(root);
  refusals.push(...tables.refusals);
  const rules = new Set([CHECKER_ID, ...families.keys(), ...tables.rules.keys()]);
  for (const id of tables.planned.keys()) if (!rules.has(id)) rules.add(`${id} planned`);
  if (refusals.length) return { rules: [], refusals };
  return { rules: [...rules].sort(), refusals };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison

const isCount = (n) => Number.isInteger(n) && n >= 0;
const isMeasure = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const listedCount = (entry) => entry.count ?? 1;

/** A family's kind and shape: named entries, one count, budgets or floors (2.1-M222). */
export function shapeOf(doc) {
  return ['entries', 'count', 'budgets', 'floors'].find((field) => field in doc);
}

const sameSet = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

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

// ---------------------------------------------------------------------------------------------------------------
// Observation: adapters
//
// policy/adapters/<tool>.mjs runs its tool with the real config and normalises what it reports (2.1-M188):
//   collect({ root, paths, exec }) -> Site[]    a ratchet family's tool: every site it reports over `paths`
//   measure({ root, paths, exec }) -> observed  a budget or floor family's tool: the values compare() takes
//   refuse(site, doc) -> string | undefined     optional: why the family refuses this site whatever its baseline
// A Site is { rule, path?, name?, target?, line?, refused? }: `rule` is the tool's rule id, `path` the repository
// file, `name` a named edge, `target` the `<tool>:<rule>` a suppression names (its path-rule key), `refused` why the
// adapter refuses it for every family. A tool that cannot run throws an error whose `code` is `tool-failed`, and one
// that exits 0 while reporting errors `reporter-exit`. `exec(command, args, { cwd })` -> { status, stdout, stderr }
// runs the tool; the self-test passes one that replays recorded output.

/** Runs a tool and returns its exit status and output, never throwing on a non-zero status. */
export function exec(command, args, { cwd }) {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    if (typeof error.status !== 'number') throw Object.assign(new Error(`${command}: ${error.message}`), { code: 'tool-failed' });
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** The key a site counts under in a family of key kind `kind`, or undefined when the site lacks it. */
function siteKey(kind, doc, site) {
  if (kind === 'name') return site.name;
  if (kind === 'path') return site.path;
  return site.path === undefined ? undefined : `${site.path}: ${site.target ?? `${doc.tool}:${site.rule}`}`;
}

/**
 * A ratchet family's observed sites: those of its selected rules, each refused one a `refused-site` refusal and never
 * counted. Returns { observed, refusals }: a count for a count family, else {key: count}.
 */
export function observe(doc, sites, refuse = () => undefined) {
  const where = `${RATCHETS_DIR}/${doc.family}.json`;
  const refusals = [];
  const counted = [];
  for (const site of sites) {
    if (doc.select && !doc.select.includes(site.rule)) continue;
    const reason = site.refused ?? refuse(site, doc);
    if (reason) refusals.push(refusal('refused-site', where, `${site.path ?? site.name}${site.line ? `:${site.line}` : ''}: ${reason}`));
    else counted.push(site);
  }
  if (!('entries' in doc)) return { observed: counted.length, refusals };
  const observed = {};
  for (const site of counted) {
    const key = siteKey(doc.keys, doc, site);
    if (typeof key !== 'string' || !key) {
      refusals.push(refusal('observed-shape', where, `a ${site.rule} site has no ${doc.keys} key`));
      continue;
    }
    observed[key] = (observed[key] ?? 0) + 1;
  }
  return { observed, refusals };
}

/** The adapter module for `tool` under `root`. */
export async function loadAdapter(root, tool) {
  return import(pathToFileURL(path.join(root, adapterFile(tool))).href);
}

/** An adapter's thrown error as a refusal, rethrowing anything that is not a tool failure. */
function toolRefusal(error, where) {
  if (error?.code === 'tool-failed' || error?.code === 'reporter-exit') return refusal(error.code, where, error.message);
  throw error;
}

/** Holds one loaded family to what its adapter observes over `paths`; returns its refusals. */
export async function observeFamily(root, file, doc, paths, adapter, inScope = () => true) {
  const measured = shapeOf(doc) === 'budgets' || shapeOf(doc) === 'floors';
  const needed = measured ? 'measure' : 'collect';
  if (typeof adapter[needed] !== 'function') {
    return [refusal('adapter-contract', file, `${adapterFile(doc.tool)} exports no ${needed}() for a ${shapeOf(doc)} family`)];
  }
  try {
    if (measured) return compare(doc, await adapter.measure({ root, paths, exec }));
    const sites = (await adapter.collect({ root, paths, exec })).filter((s) => s.path === undefined || inScope(s.path));
    const { observed, refusals } = observe(doc, sites, adapter.refuse);
    return [...refusals, ...compare(doc, observed)];
  } catch (error) {
    return [toolRefusal(error, file)];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Planted violations
//
// Every rule (each family, each policy table's row) has a planted violation under policy/fixtures/rules/<rule>/, and
// `--self-test` runs it through the rule's real tool and config: a family must refuse it by a site it counts against
// its baseline (unlisted or rising) or a value it measures (below a floor, over a budget or over other globs). A refused
// site is neither a failure nor a firing: a tool that sees nothing (a config listing no method) refuses every
// exemption too, so a refusal proves nothing about the rule's real config. A table row naming a family runs
// through that family the same way, and a table rule with no family must have its tool report the rule's id there. A rule whose planted violation passes is untested, so the checker fails it. This checker's own
// id is exempt: its planted violations are the cases under policy/fixtures/check/.

export const PLANTED_DIR = `${FIXTURES_DIR}/rules`;
const FIRES = new Set(['unlisted', 'rising', 'below-floor', 'over-budget', 'floor-globs']);
/** Refusals a planted violation may give besides firing: a listed entry it does not hold, a site refused outright. */
const PLANTED_NEUTRAL = new Set(['stale', 'refused-site']);

/**
 * Refuses each active policy table row that names a loaded family and a `tool` other than that family's: the family's
 * tool is the one that runs the row's planted violation and counts its sites.
 */
function rowFamilyRefusals(families, tables) {
  const refusals = [];
  for (const [id, { row, table }] of tables.rules) {
    const family = row.family === undefined ? undefined : families.get(row.family);
    if (family && row.tool !== undefined && row.tool !== family.doc.tool) {
      refusals.push(refusal('rules-table', table, `${id}: tool ${row.tool} is not its family ${row.family}'s tool ${family.doc.tool}; name the family's tool or none`));
    }
  }
  return refusals;
}

/**
 * The rules with a tool to plant against: { id -> { tool, family?, table? } }, with the load refusals. A table row
 * naming a family is run through that family, so rows sharing one family (and one tool lint) each fire by the sites
 * the family counts, never by a row id the tool cannot report (2.1-M222).
 */
function plantableRules(root) {
  const { families, refusals } = loadRatchets(root);
  const tables = loadTableRules(root);
  refusals.push(...tables.refusals, ...rowFamilyRefusals(families, tables));
  const rules = new Map();
  for (const [id, family] of families) rules.set(id, { tool: family.doc.tool, family });
  for (const [id, { row, table }] of tables.rules) {
    const family = row.family === undefined ? undefined : families.get(row.family);
    rules.set(id, family ? { tool: family.doc.tool, family, table } : { tool: row.tool, table });
  }
  return { rules, refusals, families };
}

/** Refusals for rules (a Set or Map of ids) without a planted directory and planted directories naming no rule. */
function plantedLayout(root, rules) {
  const dir = path.join(root, PLANTED_DIR);
  const planted = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const refusals = [];
  for (const id of [...rules.keys()].sort()) {
    if (!planted.includes(id)) refusals.push(refusal('no-planted', `${PLANTED_DIR}/${id}/`, `rule ${id} has no planted violation; plant one its tool fails on`));
  }
  for (const name of planted.sort()) {
    if (!rules.has(name)) refusals.push(refusal('stray-planted', `${PLANTED_DIR}/${name}/`, `no rule is named ${name}; remove the directory or name it after its rule`));
  }
  return refusals;
}

/**
 * Runs the planted violation of each observed rule (in the lanes up to `lane`, a rule with no family being commit-lane,
 * or of the named `only` families) through its tool; refuses each that does not fire, with every rule's layout refusals.
 */
export async function checkPlanted(root = REPO_ROOT, lane = 'commit', only = []) {
  const { rules, refusals, families } = plantableRules(root);
  if (refusals.length) return refusals;
  const observes = observer(lane, only, families);
  refusals.push(...plantedLayout(root, rules));
  const files = listFiles(root);
  for (const [id, { tool, family, table }] of [...rules].sort(([a], [b]) => a.localeCompare(b))) {
    const where = `${PLANTED_DIR}/${id}/`;
    const paths = files.filter((f) => f.startsWith(where));
    if (!paths.length || !observes(family?.doc)) continue;
    if (typeof tool !== 'string' || !fs.existsSync(path.join(root, adapterFile(tool)))) {
      refusals.push(refusal('no-adapter', table ?? family.file, `rule ${id}'s tool ${tool ?? '(none named)'} has no adapter to run its planted violation`));
      continue;
    }
    const adapter = await loadAdapter(root, tool);
    let fired;
    if (family) {
      const found = await observeFamily(root, family.file, family.doc, paths, adapter);
      const failed = found.filter((r) => !FIRES.has(r.code) && !PLANTED_NEUTRAL.has(r.code));
      if (failed.length) { refusals.push(...failed); continue; }
      fired = found.some((r) => FIRES.has(r.code));
    } else {
      try {
        if (typeof adapter.collect !== 'function') {
          refusals.push(refusal('adapter-contract', table, `${adapterFile(tool)} exports no collect() for rule ${id}`));
          continue;
        }
        fired = (await adapter.collect({ root, paths, exec })).some((s) => s.rule === id);
      } catch (error) {
        refusals.push(toolRefusal(error, table));
        continue;
      }
    }
    if (!fired) refusals.push(refusal('planted-silent', where, `${tool} does not fail rule ${id} on its planted violation`));
  }
  return refusals;
}

/**
 * The default check: load every family and policy table, then hold each observed family (in the lanes up to `lane`, or
 * the named `families`) to its adapter's sites over the scope's files, planted fixtures left out.
 */
export async function checkRepo(root = REPO_ROOT, lane = 'commit', { phaseClose, families: only = [] } = {}) {
  const { families, refusals } = loadRatchets(root);
  const tables = loadTableRules(root);
  refusals.push(...tables.refusals, ...rowFamilyRefusals(families, tables));
  if (phaseClose !== undefined) refusals.push(...phaseCloseRefusals(tables, phaseClose));
  const declared = new Set([...families.keys(), ...tables.rules.keys()]);
  if (!refusals.length) refusals.push(...plantedLayout(root, declared));
  refusals.push(...unrunLanes(root, families, path.join(root, CASES_DIR)));
  const observes = observer(lane, only, families);
  const files = listFiles(root).filter((f) => !f.startsWith(`${FIXTURES_DIR}/`));
  for (const { file, doc } of families.values()) {
    if (!observes(doc)) continue;
    const inScope = (p) => !p.startsWith(`${FIXTURES_DIR}/`) && doc.scope.some((glob) => matchesGlob(p, glob));
    const adapter = await loadAdapter(root, doc.tool);
    refusals.push(...await observeFamily(root, file, doc, files.filter(inScope), adapter, inScope));
  }
  return { families, refusals };
}

// ---------------------------------------------------------------------------------------------------------------
// Base-to-head diff

/** Old path -> new path for each rename git -M finds between `baseRev` and `headRev` (the working tree when omitted). */
export function gitRenames(root, baseRev, headRev) {
  const parts = git(root, ['diff', '-M', '--name-status', '-z', baseRev, ...(headRev ? [headRev] : [])]).split('\0');
  const renames = new Map();
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i];
    if (status.startsWith('R')) renames.set(parts[i + 1], parts[i + 2]);
    i += status.startsWith('R') || status.startsWith('C') ? 3 : 2;
  }
  return renames;
}

/** Family file stem -> parsed doc, at a revision or (rev omitted) in the working tree. */
function familiesAt(root, rev) {
  const families = new Map();
  const names = rev
    ? git(root, ['ls-tree', '-z', '--name-only', rev, '--', `${RATCHETS_DIR}/`]).split('\0').filter(Boolean).map((f) => path.posix.basename(f))
    : fs.existsSync(path.join(root, RATCHETS_DIR)) ? fs.readdirSync(path.join(root, RATCHETS_DIR)) : [];
  for (const name of names.filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'))) {
    const file = `${RATCHETS_DIR}/${name}`;
    const text = rev ? git(root, ['show', `${rev}:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8');
    families.set(path.basename(name, '.json'), JSON.parse(text));
  }
  return families;
}

const HEADER_FIELDS = ['version', 'family', 'ledger', 'tool', 'scope', 'lane', 'keys', 'select'];

/** `p` moved by `renames`: its exact rename (a file, git -M), else the longest renamed directory holding it. */
function movePath(p, renames) {
  if (renames.has(p)) return renames.get(p);
  let dir;
  for (const from of renames.keys()) if (p.startsWith(`${from}/`) && (dir === undefined || from.length > dir.length)) dir = from;
  return dir === undefined ? p : `${renames.get(dir)}${p.slice(dir.length)}`;
}

/**
 * A key moved in its own coordinates: a path or path-rule key by `moves.path` (repository paths), each module path
 * in a name key (`app/a <-> app/b`) by `moves.name` (module paths under desktop/web/src).
 */
function moveKey(kind, key, moves) {
  if (kind === 'name') return key.split(' ').map((token) => movePath(token, moves.name)).join(' ');
  const p = keyPath(kind, key);
  return p ? withKeyPath(kind, key, movePath(p, moves.path)) : key;
}

/**
 * The changes between two sets of family docs. `moves.path` maps an old repository file or directory to its new
 * path (git -M's renames and the layer table's moves under desktop/web/src); `moves.name` maps old module paths to
 * new (the layer table's moves) (2.1-M74).
 */
export function diffFamilies(base, head, moves) {
  const changes = [];
  for (const stem of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const was = base.get(stem);
    const now = head.get(stem);
    if (!was) { changes.push({ change: 'created', family: stem }); continue; }
    if (!now) { changes.push({ change: 'deleted', family: stem }); continue; }
    const fields = HEADER_FIELDS.filter((f) => JSON.stringify(was[f]) !== JSON.stringify(now[f]));
    if (shapeOf(was) !== shapeOf(now)) fields.push('shape');
    if (fields.length) changes.push({ change: 'header', family: stem, fields });
    // A header change hides nothing: only a new key kind or shape leaves no entries to compare.
    if (fields.includes('keys') || fields.includes('shape')) continue;
    if (shapeOf(now) === 'budgets' || shapeOf(now) === 'floors') {
      changes.push(...diffMeasures(stem, was, now));
      continue;
    }
    if (!('entries' in now)) {
      if (now.count !== was.count) changes.push({ change: now.count > was.count ? 'raised' : 'lowered', family: stem, from: was.count, to: now.count });
      continue;
    }
    const renamedFrom = new Set();
    const movedTo = new Map(Object.keys(was.entries).filter((k) => !(k in now.entries))
      .map((k) => [moveKey(now.keys, k, moves), k]));
    for (const [key, entry] of Object.entries(now.entries)) {
      const to = listedCount(entry);
      if (key in was.entries) {
        const from = listedCount(was.entries[key]);
        if (to !== from) changes.push({ change: to > from ? 'raised' : 'lowered', family: stem, key, from, to });
        continue;
      }
      const oldKey = movedTo.get(key);
      if (oldKey !== undefined && to <= listedCount(was.entries[oldKey])) {
        renamedFrom.add(oldKey);
        changes.push({ change: 'renamed', family: stem, key, from: oldKey, count: to });
      } else {
        changes.push({ change: 'added', family: stem, key, to });
      }
    }
    for (const key of Object.keys(was.entries)) {
      if (!(key in now.entries) && !renamedFrom.has(key)) changes.push({ change: 'removed', family: stem, key });
    }
  }
  return changes;
}

/** Numbers keyed `<key>/<field>`: a budget's ceiling and tolerance, a floor family's floors per tool and metric. */
function measures(doc) {
  const out = new Map();
  if (shapeOf(doc) === 'budgets') {
    for (const [key, b] of Object.entries(doc.budgets)) for (const f of ['ceiling', 'tolerance']) out.set(`${key}/${f}`, b[f]);
  } else {
    for (const [tool, t] of Object.entries(doc.floors)) for (const [m, v] of Object.entries(t.floors)) out.set(`${tool}/${m}`, v);
  }
  return out;
}

/**
 * A budget or floor family's changes: each number raised or lowered (for a floor, lowered is the loosening; for a
 * budget, raised), a key added or removed, and a floor tool's changed patterns.
 */
function diffMeasures(stem, was, now) {
  const changes = [];
  const before = measures(was);
  const after = measures(now);
  for (const [key, to] of after) {
    if (!before.has(key)) changes.push({ change: 'added', family: stem, key, to });
    else if (to !== before.get(key)) changes.push({ change: to > before.get(key) ? 'raised' : 'lowered', family: stem, key, from: before.get(key), to });
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push({ change: 'removed', family: stem, key });
  if (shapeOf(now) === 'floors') {
    for (const tool of Object.keys(now.floors)) {
      for (const field of ['include', 'exclude']) {
        const from = was.floors[tool]?.[field] ?? [];
        const to = now.floors[tool][field] ?? [];
        if (!sameSet(from, to)) changes.push({ change: 'floor-globs', family: stem, key: `${tool}/${field}`, from, to });
      }
    }
  }
  return changes;
}

/**
 * The changes between the family files at `baseRev` and at `headRev` (the working tree when omitted). An entry
 * moves with git -M's renames and with the layer table's moves at either revision (the base names a planned move,
 * the head one the commit plans); throws a `layer-table` RefusalError on a table it cannot read.
 */
export function diffRatchets(root, baseRev, headRev) {
  const name = new Map([...layerMovesAt(root, baseRev), ...layerMovesAt(root, headRev)]);
  const inRepo = [...name].map(([from, to]) => [`${MODULE_ROOT}/${from}`, `${MODULE_ROOT}/${to}`]);
  const moves = { path: new Map([...inRepo, ...gitRenames(root, baseRev, headRev)]), name };
  return diffFamilies(familiesAt(root, baseRev), familiesAt(root, headRev), moves);
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test: the planted cases

/** The rules table a case without one gets: one planned row, so it requires no family, planted violation or tool. */
const FIXTURE_RULES_TABLE = {
  version: 1,
  phases: ['later'],
  rules: [{ id: 'fixture-later', status: 'planned', owner_today: NO_OWNER, owner_target: { path: 'src/', phase: 'later' } }],
};

/** The lane runners a repo case without its own gets: the check and the self-test at every lane. */
const FIXTURE_LANE_RUNNERS = {
  name: 'fixture',
  scripts: Object.fromEntries(LANES.map((l) => [`policy:${l}`, `node policy/check.mjs --self-test --lane ${l} && node policy/check.mjs --lane ${l}`])),
};

/**
 * Writes a case's files into a new git work tree, every file staged as a checkout has them, then applies the
 * case's unstaged edits: `unstagedDeletes` (paths removed from disk only) and `unstagedMoves` ([from, to] on disk).
 * `copy` ({path: repository file}) adds real files, such as recorded source or the real adapters, beside `files`, and
 * `copyDirs` (repository directories) every file git tracks under each at the same path, so a case follows what a
 * real planted directory holds. A case without its own policy/rules.json gets FIXTURE_RULES_TABLE, and none with
 * `rulesTable: false`.
 */
function materialise(files, schemaOverride, kase = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-'));
  const all = { ...files };
  for (const dir of kase.copyDirs ?? []) {
    const tracked = git(REPO_ROOT, ['ls-files', '-z', '--', `${dir}/`]).split('\0').filter(Boolean);
    if (!tracked.length) throw new Error(`copyDirs: git tracks no file under ${dir}/`);
    for (const rel of tracked) all[rel] = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  }
  for (const [rel, from] of Object.entries(kase.copy ?? {})) all[rel] = fs.readFileSync(path.join(REPO_ROOT, from), 'utf8');
  if (schemaOverride === undefined) all[SCHEMA_FILE] = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8');
  else if (schemaOverride !== false) all[SCHEMA_FILE] = schemaOverride;
  if (!(RULES_TABLE in all) && kase.rulesTable !== false) all[RULES_TABLE] = FIXTURE_RULES_TABLE;
  for (const [rel, content] of Object.entries(all)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  for (const gone of kase.unstagedDeletes ?? []) fs.rmSync(path.join(root, gone));
  for (const [from, to] of kase.unstagedMoves ?? []) fs.renameSync(path.join(root, from), path.join(root, to));
  return root;
}

/**
 * Runs `run` with the real tools building into `root`/target, so a case's planted crate never lands in a shared
 * target directory (`real` cases: the tool itself runs, nothing is replayed).
 */
async function inOwnTarget(root, run) {
  const saved = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = path.join(root, 'target');
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = saved;
  }
}

/**
 * A budget adapter's observed values as `<key>=<value>` lines, a floor adapter's as `<key> <field>=<value>`; with
 * `familyFile`, that real family's refusals and whether it equals what was measured (`equal`, else `differs`): a
 * floor family's floors and patterns, a budget family's ceilings, as a reset writes them.
 */
async function measured(adapter, args, familyFile) {
  const observed = await adapter.measure(args);
  const lines = Object.entries(observed).flatMap(([key, got]) => (typeof got === 'number' ? [`${key}=${got}`] : [
    ...Object.entries(got.values ?? {}).map(([metric, v]) => `${key} ${metric}=${v}`),
    ...['include', 'exclude'].filter((f) => got[f] !== undefined).map((f) => `${key} ${f}=${JSON.stringify(got[f])}`),
  ]));
  if (!familyFile) return lines;
  const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, familyFile), 'utf8'));
  const held = doc.floors ?? doc.budgets;
  /** The values a held entry is compared with: a budget adapter measures one number, the ceiling a reset writes. */
  const values = (got) => (typeof got === 'number' ? { ceiling: got } : got.values ?? {});
  const same = Object.keys(held).length === Object.keys(observed).length && Object.entries(held).every(([key, h]) => key in observed
    && JSON.stringify(Object.entries(h.floors ?? { ceiling: h.ceiling }).sort()) === JSON.stringify(Object.entries(values(observed[key])).sort())
    && ['include', 'exclude'].every((f) => sameSet(h[f], observed[key][f])));
  return [...compare(doc, observed).map((r) => r.code), ...lines, same ? 'equal' : 'differs'];
}

const RUNNERS = {
  diff(kase) {
    const root = materialise(kase.base ?? {});
    try {
      git(root, ['-c', 'user.name=policy', '-c', 'user.email=policy@localhost', 'commit', '-q', '--no-verify', '-m', 'base']);
      git(root, ['tag', 'base']);
      for (const [from, to] of kase.moves ?? []) {
        fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
        git(root, ['mv', from, to]);
      }
      for (const gone of kase.delete ?? []) git(root, ['rm', '-q', gone]);
      for (const [rel, content] of Object.entries(kase.head ?? {})) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
      }
      git(root, ['add', '-A']);
      if (kase.commitHead) git(root, ['-c', 'user.name=policy', '-c', 'user.email=policy@localhost', 'commit', '-q', '--no-verify', '-m', 'head']);
      // `argv` reads the revisions as the CLI does; else base against HEAD when committed, the working tree when not.
      const { base, head } = kase.argv ? diffRevisions(kase.argv) : { base: 'base', head: kase.commitHead ? 'HEAD' : undefined };
      return diffRatchets(root, base, head).map((c) => c.change);
    } catch (error) {
      if (error instanceof RefusalError) return [error.code];
      throw error;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  rules(kase) {
    const root = materialise(kase.files ?? {}, kase.schema, kase);
    try {
      const { rules, refusals } = listRules(root);
      return refusals.length ? refusals.map((r) => r.code) : rules;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  compare(kase) {
    return compare(kase.doc, kase.observed).map((r) => r.code);
  },
  observe(kase) {
    const { observed, refusals } = observe(kase.doc, kase.sites);
    const counts = typeof observed === 'number' ? [`count=${observed}`] : Object.entries(observed).map(([k, n]) => `${k}=${n}`);
    return [...refusals.map((r) => r.code), ...counts];
  },
  /**
   * An adapter over recorded real output (`recorded`, or inline `stdout`, replayed with `status`), real recorded
   * source (`paths` under policy/fixtures/recorded/) or inline sources (`files`); with `family`, its refusals and
   * observed counts too.
   * Gives each distinct site as `<rule> @ <path> [<name>] -> <target> (refused) x<n>`, and with `showCommand` the
   * command run, relative to the repository. With `real`, the tool runs on the materialised files instead.
   */
  async adapters(kase) {
    const adapter = await loadAdapter(REPO_ROOT, kase.tool);
    const root = kase.files || kase.copy ? materialise(kase.files ?? {}, false, kase) : REPO_ROOT;
    const commands = [];
    const replay = (command, args) => {
      commands.push(`$ ${[path.isAbsolute(command) ? path.relative(root, command) : command, ...args].join(' ')}`);
      const stdout = kase.recorded ? fs.readFileSync(path.join(REPO_ROOT, kase.recorded), 'utf8') : kase.stdout ?? '';
      return { status: kase.status ?? 0, stdout, stderr: kase.stderr ?? '' };
    };
    try {
      const paths = kase.paths ?? Object.keys({ ...kase.files, ...kase.copy });
      const run = kase.real ? exec : replay;
      if (typeof adapter.measure === 'function') return await measured(adapter, { root, paths, exec: run }, kase.familyFile);
      const sites = kase.real
        ? await inOwnTarget(root, () => adapter.collect({ root, paths, exec: run }))
        : await adapter.collect({ root, paths, exec: run });
      const counts = new Map();
      for (const s of sites) {
        const label = `${s.rule} @ ${s.path ?? ''}${s.name ? ` [${s.name}]` : ''}${s.target ? ` -> ${s.target}` : ''}${s.refused ? ' (refused)' : ''}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const held = kase.family ? observe(kase.family, sites, adapter.refuse) : { refusals: [], observed: {} };
      const refused = [...held.refusals.map((r) => r.code), ...Object.entries(held.observed).map(([k, n]) => `${k}=${n}`)];
      return [...refused, ...[...counts].map(([label, n]) => `${label} x${n}`), ...(kase.showCommand ? commands : [])];
    } catch (error) {
      return [toolRefusal(error, kase.tool).code];
    } finally {
      if (root !== REPO_ROOT) fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /** A case without its own LANE_RUNNERS gets FIXTURE_LANE_RUNNERS, which runs every lane. */
  async repo(kase) {
    const files = { ...kase.files };
    if (!(LANE_RUNNERS in files)) files[LANE_RUNNERS] = FIXTURE_LANE_RUNNERS;
    const root = materialise(files, kase.schema, kase);
    try {
      const check = () => checkRepo(root, kase.lane, { phaseClose: kase.phaseClose, families: kase.families });
      return (await (kase.real ? inOwnTarget(root, check) : check())).refusals.map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /** With `real`, the planted violations' real tools build into the case's own target directory. */
  async planted(kase) {
    const root = materialise(kase.files ?? {}, kase.schema, kase);
    try {
      const run = () => checkPlanted(root, kase.lane, kase.families);
      return (await (kase.real ? inOwnTarget(root, run) : run())).map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /** The self-test itself over the cases in `cases` (`<kind>/<name>.json` -> case) at `lane`: `<status> <case>` per case. */
  async selftest(kase) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-cases-'));
    try {
      for (const [rel, inner] of Object.entries(kase.cases ?? {})) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), JSON.stringify(inner));
      }
      const lines = [];
      await runCases(dir, (line) => lines.push(line.split(/\s+/).slice(0, 2).join(' ').replace(/:$/, '')), kase.lane);
      return lines;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  load(kase) {
    const root = materialise(kase.files ?? {}, kase.schema, kase);
    try {
      return loadRatchets(root).refusals.map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

/**
 * Runs `run` as a git hook in a linked worktree would: GIT_DIR and GIT_INDEX_FILE name a decoy repository, and HOME
 * holds a git config that signs every commit and tag with a signer that always fails. Returns the failures: a
 * planted case that wrote into the caller's repository, or that a developer's signing config would break or stall.
 */
async function asGitHook(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-hook-'));
  const decoy = path.join(scratch, 'decoy');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n');
  git(scratch, ['init', '-q', decoy]);
  git(decoy, ['-c', 'user.name=decoy', '-c', 'user.email=decoy@localhost', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '--no-verify', '-m', 'decoy']);
  const state = () => `${git(decoy, ['for-each-ref'])}${git(decoy, ['ls-files', '-s'])}`;
  const before = state();
  const saved = Object.fromEntries(['GIT_DIR', 'GIT_INDEX_FILE', 'HOME', 'RUSTUP_HOME', 'CARGO_HOME'].map((k) => [k, process.env[k]]));
  // The real toolchain stays where the developer's home has it: only git's config moves.
  const realHome = os.homedir();
  Object.assign(process.env, {
    GIT_DIR: path.join(decoy, '.git'), GIT_INDEX_FILE: path.join(decoy, '.git', 'index'), HOME: home,
    RUSTUP_HOME: saved.RUSTUP_HOME ?? path.join(realHome, '.rustup'), CARGO_HOME: saved.CARGO_HOME ?? path.join(realHome, '.cargo'),
  });
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const failures = state() === before ? [] : ['the planted cases wrote into the calling repository'];
  fs.rmSync(scratch, { recursive: true, force: true });
  return failures;
}

/**
 * Runs every planted case (none for named `only` families) and the planted violations of the rules observed (in the
 * lanes up to `lane`, or the named families); returns { failures, missing }, missing the codes with no case in any lane.
 */
export async function selfTest(casesRoot = path.join(REPO_ROOT, CASES_DIR), log = () => {}, lane = 'commit', only = []) {
  let result = { failures: [], missing: [] };
  const leaks = only.length ? [] : await asGitHook(async () => { result = await runCases(casesRoot, log, lane); });
  for (const leak of leaks) log(`FAIL ${leak}`);
  const silent = (await checkPlanted(REPO_ROOT, lane, only)).map((r) => `${r.code}: ${r.where}: ${r.message}`);
  for (const line of silent) log(`FAIL planted ${line}`);
  if (!silent.length) log('ok   planted violations of this repository fire');
  return { failures: [...result.failures, ...leaks, ...silent], missing: result.missing };
}

/**
 * Runs the cases under `casesRoot`, skipping one whose `toolLane` (the lane whose environment its real tools need, such
 * as push for a Rust toolchain; commit when absent) is past `lane`; a skipped case still counts as its codes' case.
 */
async function runCases(casesRoot, log, lane = 'commit') {
  const failures = [];
  const covered = new Set();
  const strays = fs.existsSync(casesRoot) ? fs.readdirSync(casesRoot).filter((d) => !(d in RUNNERS)) : [];
  for (const stray of strays) {
    log(`FAIL ${stray}: not a case kind (${Object.keys(RUNNERS).join(', ')})`);
    failures.push(stray);
  }
  for (const kind of Object.keys(RUNNERS)) {
    const dir = path.join(casesRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) {
        log(`FAIL ${kind}/${name}: a case is a .json file`);
        failures.push(`${kind}/${name}`);
        continue;
      }
      const kase = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const expected = [...new Set(kase.expect)].sort();
      expected.forEach((code) => covered.add(code));
      if (!LANES.includes(kase.toolLane ?? 'commit')) {
        log(`FAIL ${kind}/${name}: toolLane takes ${LANES.join(', ')}`);
        failures.push(`${kind}/${name}`);
        continue;
      }
      if (!lanesUpTo(lane).includes(kase.toolLane ?? 'commit')) {
        log(`skip ${kind}/${name}: its tools need the ${kase.toolLane} lane (--self-test --lane ${kase.toolLane})`);
        continue;
      }
      let got;
      try {
        got = [...new Set(await RUNNERS[kind](kase))].sort();
      } catch (error) {
        got = [`threw: ${error.message}`];
      }
      const ok = JSON.stringify(got) === JSON.stringify(expected);
      log(`${ok ? 'ok  ' : 'FAIL'} ${kind}/${name}${ok ? '' : `: expected [${expected}], got [${got}]`}`);
      if (!ok) failures.push(`${kind}/${name}`);
    }
  }
  const missing = [...Object.keys(REFUSALS), ...Object.keys(CHANGES)].filter((code) => !covered.has(code));
  return { failures, missing };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

/**
 * `--diff <base> [<head>]`'s revisions: the base is the argument right after `--diff`, the head the one after it only
 * when it is no flag, so another flag's value (`--lane push`) never becomes a revision; head omitted is the working tree.
 */
function diffRevisions(argv) {
  const at = argv.indexOf('--diff');
  const positional = (a) => a !== undefined && !a.startsWith('-');
  const base = argv[at + 1];
  if (!positional(base)) throw new Error('--diff needs a base revision right after it: --diff <base> [<head>]');
  return { base, head: positional(argv[at + 2]) ? argv[at + 2] : undefined };
}

async function main(argv) {
  const lane = laneArg(argv);
  if (!LANES.includes(lane)) throw new Error(`--lane takes ${LANES.join(', ')}`);
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
  if (argv.includes('--diff')) {
    const { base, head } = diffRevisions(argv);
    let changes;
    try {
      changes = diffRatchets(REPO_ROOT, base, head);
    } catch (error) {
      if (!(error instanceof RefusalError)) throw error;
      console.error(error.message);
      return 1;
    }
    for (const change of changes) console.log(JSON.stringify(change));
    return 0;
  }
  const closeAt = argv.indexOf('--phase-close');
  const phaseClose = closeAt === -1 ? undefined : argv[closeAt + 1];
  if (closeAt !== -1 && (!phaseClose || phaseClose.startsWith('--'))) throw new Error('--phase-close needs a phase label');
  const { families, refusals } = await checkRepo(REPO_ROOT, lane, { phaseClose, families: familyArgs(argv) });
  for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
  console.log(`policy check: ${families.size} families, ${refusals.length ? 'RED' : 'OK'}`);
  return refusals.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
