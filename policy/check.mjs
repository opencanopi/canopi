#!/usr/bin/env node
// policy/check.mjs: the fail-closed policy checker (contracts §12; 2.1-M186, 2.1-M191; ADR 0028 Generated rules).
//
// It reads the ratchet family files in policy/ratchets/ (one JSON file per family, shaped by ratchet.schema.json)
// and refuses anything it cannot vouch for: a missing or unreadable table, a file the schema refuses, and a schema
// keyword its validator does not implement. Every refusal code has a planted case under policy/fixtures/check/, and
// `--self-test` fails a code without one, so a refusal cannot exist untested.
//
//   node policy/check.mjs              load and validate every family file; exit 1 on any refusal
//   node policy/check.mjs --self-test  run the planted cases in policy/fixtures/check/
//   node policy/check.mjs --diff <base> [<head>]
//                                      one JSON line per change between the family files at <base> and at <head>
//                                      (the working tree when omitted), entries renamed with their files by git -M;
//                                      the gate (F3b) decides which changes need a bead and a Q row
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
  unlisted: 'a site in a file or under a name the family does not list',
  rising: 'more sites than the entry or count allows',
  falling: 'fewer sites than the entry or count, which was not lowered',
  stale: 'a listed entry that no longer occurs (an unused exemption)',
  'observed-shape': 'a reporter result that is not the family\'s shape',
};

/**
 * Every change a base-to-head diff of the family files can name (`--diff`); the gate (F3b) decides which need a
 * bead and a Q row. `--self-test` fails a change with no planted case.
 */
export const CHANGES = {
  created: 'a family file new at head: its first baseline (2.1-M40)',
  deleted: 'a family file gone at head',
  header: 'a changed version, ledger, tool, scope, lane, key kind or shape',
  added: 'an entry new at head that is not a rename',
  raised: 'an entry or count above its base value',
  lowered: 'an entry or count below its base value',
  removed: 'an entry gone at head that was not renamed',
  renamed: 'an entry moved with its file by git -M at the same or a lower count (2.1-M74)',
};

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const refusal = (code, where, message) => ({ code, where, message });
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
// (a named edge or symbol, never a path: no drift check and no git rename; the layer table renames those).

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

/** The files under `root` a scope glob can match: git's tracked and unignored files, or every file outside git. */
function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    if (path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim())
      === path.resolve(root)) {
      return out.split('\0').filter(Boolean);
    }
  } catch {
    // not a git work tree: walk it
  }
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join('/'));
}

/** Refusals for a schema-valid family: its file name, key grammar, path drift and scope. */
function checkFamily(file, doc, files) {
  const refusals = [];
  const stem = path.basename(file, '.json');
  if (doc.family !== stem) {
    refusals.push(refusal('family-name', file, `family "${doc.family}" lives in ${stem}.json; name the file ${doc.family}.json`));
  }
  for (const glob of doc.scope) {
    if (!files.some((f) => path.matchesGlob(f, glob))) {
      refusals.push(refusal('path-drift', file, `scope glob ${glob} matches no file`));
    }
  }
  const present = new Set(files);
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

/** The changes between two sets of family docs, entries renamed through `renames` (old path -> new path). */
export function diffFamilies(base, head, renames) {
  const changes = [];
  for (const stem of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const was = base.get(stem);
    const now = head.get(stem);
    if (!was) { changes.push({ change: 'created', family: stem }); continue; }
    if (!now) { changes.push({ change: 'deleted', family: stem }); continue; }
    const fields = HEADER_FIELDS.filter((f) => JSON.stringify(was[f]) !== JSON.stringify(now[f]));
    if (('entries' in was) !== ('entries' in now)) fields.push('shape');
    if (fields.length) { changes.push({ change: 'header', family: stem, fields }); continue; }
    if (!('entries' in now)) {
      if (now.count !== was.count) changes.push({ change: now.count > was.count ? 'raised' : 'lowered', family: stem, from: was.count, to: now.count });
      continue;
    }
    const renamedFrom = new Set();
    for (const [key, entry] of Object.entries(now.entries)) {
      const to = listedCount(entry);
      if (key in was.entries) {
        const from = listedCount(was.entries[key]);
        if (to !== from) changes.push({ change: to > from ? 'raised' : 'lowered', family: stem, key, from, to });
        continue;
      }
      const newPath = keyPath(now.keys, key);
      const oldPath = newPath ? [...renames].find(([, n]) => n === newPath)?.[0] : undefined;
      const oldKey = oldPath && withKeyPath(now.keys, key, oldPath);
      if (oldKey && oldKey in was.entries && !(oldKey in now.entries) && to <= listedCount(was.entries[oldKey])) {
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

/** The changes between the family files at `baseRev` and at `headRev` (the working tree when omitted). */
export function diffRatchets(root, baseRev, headRev) {
  return diffFamilies(familiesAt(root, baseRev), familiesAt(root, headRev), gitRenames(root, baseRev, headRev));
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test: the planted cases

function materialise(files, schemaOverride) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-'));
  const all = { ...files };
  if (schemaOverride === undefined) all[SCHEMA_FILE] = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8');
  else if (schemaOverride !== false) all[SCHEMA_FILE] = schemaOverride;
  for (const [rel, content] of Object.entries(all)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

const RUNNERS = {
  diff(kase) {
    const root = materialise(kase.base ?? {});
    try {
      git(root, ['init', '-q']);
      git(root, ['add', '-A']);
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  compare(kase) {
    return compare(kase.doc, kase.observed).map((r) => r.code);
  },
  load(kase) {
    const root = materialise(kase.files ?? {}, kase.schema);
    try {
      return loadRatchets(root).refusals.map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

/** Runs every planted case; returns { failures, missing } where missing lists refusal codes with no case. */
export function selfTest(casesRoot = path.join(REPO_ROOT, CASES_DIR), log = () => {}) {
  const failures = [];
  const covered = new Set();
  for (const kind of Object.keys(RUNNERS)) {
    const dir = path.join(casesRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
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
  const diffAt = argv.indexOf('--diff');
  if (diffAt !== -1) {
    const [baseRev, headRev] = argv.slice(diffAt + 1).filter((a) => !a.startsWith('--'));
    if (!baseRev) throw new Error('--diff needs a base revision');
    for (const change of diffRatchets(REPO_ROOT, baseRev, headRev)) console.log(JSON.stringify(change));
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
