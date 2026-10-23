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
};

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
  const missing = Object.keys(REFUSALS).filter((code) => !covered.has(code));
  return { failures, missing };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

function main(argv) {
  if (argv.includes('--self-test')) {
    const { failures, missing } = selfTest(undefined, (line) => console.log(line));
    for (const code of missing) console.error(`refusal ${code} has no planted case under ${CASES_DIR}/`);
    console.log(failures.length || missing.length ? 'policy self-test: RED' : 'policy self-test: OK');
    return failures.length || missing.length ? 1 : 0;
  }
  const { families, refusals } = loadRatchets();
  for (const r of refusals) console.error(`${r.code}: ${r.where}: ${r.message}`);
  console.log(`policy check: ${families.size} families, ${refusals.length ? 'RED' : 'OK'}`);
  return refusals.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
