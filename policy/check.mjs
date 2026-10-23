#!/usr/bin/env node
// policy/check.mjs: the fail-closed policy checker (contracts §12; 2.1-M186, 2.1-M191; ADR 0028 Generated rules).
//
// It reads the ratchet family files in policy/ratchets/ (one JSON file per family, shaped by ratchet.schema.json)
// and refuses anything it cannot vouch for: a missing or unreadable table, a file the schema refuses, a schema
// keyword its validator does not implement, a misnamed family, a tool with no adapter, a bad key, path drift and an
// entry out of scope.
// compare() holds a family to what its tool observes (the file only shrinks and is never stale); diffRatchets()
// names each change between two revisions for the gate. Every refusal and change has a planted case under
// policy/fixtures/check/, and `--self-test` fails one without, so neither can exist untested.
//
//   node policy/check.mjs              load and validate every family file; exit 1 on any refusal
//   node policy/check.mjs --self-test  run the planted cases in policy/fixtures/check/
//   node policy/check.mjs --list-rules one rule id per line, the registry check_docs.py queries (never committed)
//   node policy/check.mjs --diff <base> [<head>]
//                                      one JSON line per change between the family files at <base> and at <head>
//                                      (the working tree when omitted), entries renamed by git -M or by a move in the
//                                      layer table at either revision; the gate (F3b) decides which need a bead and a Q row
//
// The layer table (policy/layers.json, ADR 0022) is read here for its moves only: rows under `layers`, each with a
// module `path` relative to desktop/web/src (a trailing slash allowed) and an optional `destination` in the same
// coordinates; other columns and sections are its owner's. A table this reading refuses fails the load and the diff.
//
// Run by `npm run test:policies` in desktop/web (the Frontend gate and CI's source-policy step).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RATCHETS_DIR = 'policy/ratchets';
export const SCHEMA_FILE = `${RATCHETS_DIR}/ratchet.schema.json`;
export const LAYER_TABLE = 'policy/layers.json';
/** A tool's adapter, the registry of tools: a family's tool is valid only with one. */
export const adapterFile = (tool) => `policy/adapters/${tool}.mjs`;
/** The directory the layer table's module paths are relative to. */
const MODULE_ROOT = 'desktop/web/src';
const CASES_DIR = 'policy/fixtures/check';

/** Every refusal the checker can give; `--self-test` fails a code with no planted case. */
export const REFUSALS = {
  schema: 'a family file the ratchet schema refuses',
  'schema-keyword': 'the schema uses a keyword the validator does not implement',
  'missing-source': 'the ratchet directory or its schema is missing',
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
  'layer-table': 'a layer table whose moves cannot be read (no layers array, or a path or destination not a module path)',
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
  'type', 'const', 'enum', 'pattern', 'minimum', 'minLength', 'minItems', 'uniqueItems', 'items', 'required',
  'properties', 'additionalProperties', 'propertyNames', 'oneOf',
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
    if (!files.some((f) => path.matchesGlob(f, glob))) {
      refusals.push(refusal('path-drift', file, `scope glob ${glob} matches no file`));
    }
  }
  for (const key of Object.keys(doc.entries ?? {})) {
    const p = keyPath(doc.keys, key);
    if (p === undefined) {
      refusals.push(refusal('key', file, `"${key}" is not a ${doc.keys} key${doc.keys === 'path-rule' ? ' (<path>: <tool>:<rule>)' : ''}`));
    } else if (p !== null && !present.has(p)) {
      refusals.push(refusal('path-drift', file, `"${key}" names ${p}, which no longer exists; rename or remove the entry`));
    } else if (p !== null && !doc.scope.some((glob) => path.matchesGlob(p, glob))) {
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

/**
 * The rule registry `check_docs.py` queries (2.1-M186): this checker's id and every family id, sorted. It is
 * computed from the tables on each call and never committed; a refused table gives refusals and no partial list.
 * F1a and F1b add their tables' rule ids here.
 */
export function listRules(root = REPO_ROOT) {
  const { families, refusals } = loadRatchets(root);
  if (refusals.length) return { rules: [], refusals };
  return { rules: [CHECKER_ID, ...families.keys()].sort(), refusals };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison

const isCount = (n) => Number.isInteger(n) && n >= 0;
const listedCount = (entry) => entry.count ?? 1;

/**
 * Observed sites against a loaded family: the file must equal what the tool sees, so it only shrinks and is never
 * stale. `observed` is a count for a count family, else `{key: count}` from the family's adapter.
 */
export function compare(doc, observed) {
  const where = `${RATCHETS_DIR}/${doc.family}.json`;
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

const HEADER_FIELDS = ['version', 'family', 'ledger', 'tool', 'scope', 'lane', 'keys'];

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
    if (('entries' in was) !== ('entries' in now)) fields.push('shape');
    if (fields.length) changes.push({ change: 'header', family: stem, fields });
    // A header change hides nothing: only a new key kind or shape leaves no entries to compare.
    if (fields.includes('keys') || fields.includes('shape')) continue;
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

/**
 * Writes a case's files into a new git work tree, every file staged as a checkout has them, then applies the
 * case's unstaged edits: `unstagedDeletes` (paths removed from disk only) and `unstagedMoves` ([from, to] on disk).
 */
function materialise(files, schemaOverride, kase = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-'));
  const all = { ...files };
  if (schemaOverride === undefined) all[SCHEMA_FILE] = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8');
  else if (schemaOverride !== false) all[SCHEMA_FILE] = schemaOverride;
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
      if (kase.commitHead) {
        git(root, ['-c', 'user.name=policy', '-c', 'user.email=policy@localhost', 'commit', '-q', '--no-verify', '-m', 'head']);
        return diffRatchets(root, 'base', 'HEAD').map((c) => c.change);
      }
      return diffRatchets(root, 'base').map((c) => c.change);
    } catch (error) {
      if (error instanceof RefusalError) return [error.code];
      throw error;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  rules(kase) {
    const root = materialise(kase.files ?? {}, kase.schema);
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
function asGitHook(run) {
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
  const saved = Object.fromEntries(['GIT_DIR', 'GIT_INDEX_FILE', 'HOME'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { GIT_DIR: path.join(decoy, '.git'), GIT_INDEX_FILE: path.join(decoy, '.git', 'index'), HOME: home });
  try {
    run();
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

/** Runs every planted case; returns { failures, missing } where missing lists refusal codes with no case. */
export function selfTest(casesRoot = path.join(REPO_ROOT, CASES_DIR), log = () => {}) {
  let result;
  const leaks = asGitHook(() => { result = runCases(casesRoot, log); });
  for (const leak of leaks) log(`FAIL ${leak}`);
  return { failures: [...result.failures, ...leaks], missing: result.missing };
}

function runCases(casesRoot, log) {
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
      let got;
      try {
        got = [...new Set(RUNNERS[kind](kase))].sort();
      } catch (error) {
        got = [`threw: ${error.message}`];
      }
      expected.forEach((code) => covered.add(code));
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

function main(argv) {
  if (argv.includes('--self-test')) {
    const { failures, missing } = selfTest(undefined, (line) => console.log(line));
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
  const diffAt = argv.indexOf('--diff');
  if (diffAt !== -1) {
    const [baseRev, headRev] = argv.slice(diffAt + 1).filter((a) => !a.startsWith('--'));
    if (!baseRev) throw new Error('--diff needs a base revision');
    let changes;
    try {
      changes = diffRatchets(REPO_ROOT, baseRev, headRev);
    } catch (error) {
      if (!(error instanceof RefusalError)) throw error;
      console.error(error.message);
      return 1;
    }
    for (const change of changes) console.log(JSON.stringify(change));
    return 0;
  }
  const { families, refusals } = loadRatchets();
  for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
  console.log(`policy check: ${families.size} families, ${refusals.length ? 'RED' : 'OK'}`);
  return refusals.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
