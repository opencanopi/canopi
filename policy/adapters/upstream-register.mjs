#!/usr/bin/env node
// policy/adapters/upstream-register.mjs: the upstream register, checked both ways (ADR 0028 Upstream and Checks;
// 2.1-M1, 2.1-M202, 2.1-M237).
//
// policy/upstream.json lists every local workaround of a third-party library as a row `{id: W<n>, library, pin, what,
// sites, pin_test, report, status, exit}`; it is no rule table, so it has no top-level `rules` key (2.1-M222). A site
// is a repository path, tagged there by a `// upstream: W<n>` line comment (TypeScript, JavaScript, Rust) or a
// `# upstream: W<n>` comment (TOML), or `{file, pointer}`, a JSON pointer (RFC 6901) into a JSON file, which needs no
// tag. `pin_test` is `{path, title}`, the test that pins the upstream behaviour, or `{planned: {phase, bead}}`.
// `report` is a bead id, `declined <date>: <reason>`, `none: <why>` (tracked only), or, on an open row whose draft
// the main agent has not filed yet, empty. Ids are never reused or renumbered.
//
// collect({ root, paths }) gives one site { rule: 'upstream-register', name: '<kind> W<n> <path>', path } per fault,
// and the family (keys name, entries {}) fails every one as unlisted:
//   no-row      a tag in one of `paths` naming no row
//   stray       a tag naming an open row in a file that is neither one of its row's path sites nor its pin test's file:
//               a tag counts only where its row lists it, so naming an open row exempts no marker elsewhere
//   closed      a tag naming a closed row: a pin turning green fails its expected-fail marker, the row closes, and a
//               tag or marker left behind fails (plan's failure row)
//   no-tag      an open row's path site among `paths` without a tag carrying its id, or an open row's pin test that
//               is an expected-fail marker not tagged with its id
//   no-file     a site path or a pointer's file that does not exist
//   no-pointer  a pointer that resolves to nothing, or to a W id other than its row's
//   no-pin      an open row's pin test file missing, or holding no test declaration whose first argument is its title
//   advisory    a W id string in policy/advisories.json with no open row (2.1-M204)
// Rows are judged only when the register is among `paths` (the default check over the tracked tree), and the
// advisories only when that file is: a planted run over policy/fixtures/rules/<rule>/ judges its tags alone against
// the register's rows. A site under policy/fixtures/ is never a real one. The register vouches for itself: a missing
// or unreadable register, or a row its shape refuses, fails the run (`tool-failed`), never an empty list.
//
// An expected-fail marker (Vitest `it.fails`, Playwright `test.fail`, and the `describe` and `.fails?` spellings
// quiet-gates counts) is tagged when a tag sits on its line or in the comment lines right above it. A pin test is
// the first declaration whose first argument is its title, on the call line or the line a wrapped call opens onto
// (the same text in a comment or another test's body is not it). Its marker is on that call or in its body, up to
// the first line indented no deeper than that call (Playwright's in-body `test.fail(condition)`). markers() lists the
// markers tagged with an open row in a file where that tag counts (no stray), which the pre-push marker rule exempts
// (2.1-M237):
//   node policy/adapters/upstream-register.mjs markers   prints `<path>:<line> W<n>` per exempt marker
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexRust } from './clippy.mjs';
import { jsComments } from './suppressions.mjs';

// check.mjs's own constants, restated: importing check.mjs here would deadlock its CLI, whose top-level await is
// still pending when it loads this adapter.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES_DIR = 'policy/fixtures';
const RULES_TABLE = 'policy/rules.json';
export const REGISTER = 'policy/upstream.json';
export const ADVISORIES = 'policy/advisories.json';
const RULE = 'upstream-register';
const W_ID = /^W[1-9][0-9]*$/u;
const TAG = /^ upstream: (W[1-9][0-9]*)(?![0-9])/u;
const JS = /\.(?:[cm]?[jt]sx?)$/u;
const RUST = /\.rs$/u;
const TOML = /\.toml$/u;
const MARKER = /\b(?:it|test|describe)\.fails?\(/u;
const DECLARATION = /\b(?:it|test|describe)(?:\.[A-Za-z]+)*\(/u;
const BEAD = /^canopi-[a-z0-9]+(?:\.[0-9]+)*$/u;
const REPORT = [BEAD, /^declined \d{4}-\d{2}-\d{2}: \S/u, /^none: \S/u];
const ROW_FIELDS = ['id', 'library', 'pin', 'what', 'sites', 'pin_test', 'report', 'status', 'exit'];

const fail = (message) => { throw Object.assign(new Error(`upstream-register: ${message}`), { code: 'tool-failed' }); };
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isRepoPath = (p) => isText(p) && !p.startsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..');

/** TOML comments ([{ line, text }], text after the `#`): a `#` inside a basic, literal or multi-line string is none. */
function tomlComments(src) {
  const comments = [];
  let line = 1;
  let quote = null; // '"', "'", '"""' or "'''" while inside a string
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') { line++; if (quote?.length === 1) quote = null; continue; }
    if (quote) {
      if (quote[0] === '"' && c === '\\') i++;
      else if (src.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
    } else if (c === '"' || c === '\'') {
      quote = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length - 1;
    } else if (c === '#') {
      const end = src.indexOf('\n', i);
      comments.push({ line, text: src.slice(i + 1, end === -1 ? src.length : end) });
      i = (end === -1 ? src.length : end) - 1;
    }
  }
  return comments;
}

/** The line comments of a file in a tag language, [{ line, text }]; none for any other file. */
function lineComments(rel, src) {
  if (JS.test(rel)) return jsComments(src).filter((c) => !c.block);
  if (RUST.test(rel)) {
    const lines = src.split('\n');
    return lexRust(src).comments.filter((c) => lines[c.line - 1]?.includes(`//${c.text}`));
  }
  if (TOML.test(rel)) return tomlComments(src);
  return [];
}

/** The tags in a file: [{ line, id }]. */
export function tagsIn(rel, src) {
  return lineComments(rel, src).flatMap((c) => {
    const match = TAG.exec(c.text);
    return match ? [{ line: c.line, id: match[1] }] : [];
  });
}

const commentLine = (text) => /^\s*(?:\/\/|\/\*|\*)/u.test(text) || /\*\/\s*$/u.test(text);

/** The W ids tagging the code on 1-based `line`: tags on it and in the comment lines right above it. */
function tagsAt(lines, tags, line) {
  const ids = new Set(tags.filter((t) => t.line === line).map((t) => t.id));
  for (let at = line - 1; at >= 1 && commentLine(lines[at - 1]); at--) {
    for (const t of tags) if (t.line === at) ids.add(t.id);
  }
  return ids;
}

/** The expected-fail markers of a JavaScript or TypeScript file: [{ line, ids }], ids the W ids tagging each. */
function markersIn(rel, src, tags = tagsIn(rel, src)) {
  if (!JS.test(rel)) return [];
  const lines = src.split('\n');
  return lines.flatMap((text, i) => (MARKER.test(text) && !commentLine(text) ? [{ line: i + 1, ids: tagsAt(lines, tags, i + 1) }] : []));
}

const indent = (text) => /^\s*/u.exec(text)[0].length;

/**
 * The pin test titled `title` in a source: { call, at }, the 1-based lines of its declaring call and of its title, or
 * undefined. The title is the call's first argument, on the call line or the line a wrapped call (`it.fails(` alone)
 * opens onto; the same text in a comment or another test's body is not the pin.
 */
function pinAt(src, title) {
  const lines = src.split('\n');
  const isTitle = (arg) => /^['"`]/u.test(arg) && arg.replace(/\\(['"`])/gu, '$1').startsWith(`${arg[0]}${title}${arg[0]}`);
  let open;
  for (const [i, text] of lines.entries()) {
    if (text.trim() === '') continue;
    const declared = commentLine(text) ? null : DECLARATION.exec(text);
    if (declared) {
      const arg = text.slice(declared.index + declared[0].length).trim();
      if (arg === '') { open = i + 1; continue; }
      if (isTitle(arg)) return { call: i + 1, at: i + 1 };
    } else if (open && !commentLine(text) && isTitle(text.trim())) return { call: open, at: i + 1 };
    open = undefined;
  }
  return undefined;
}

/**
 * The marker of the pin declared on 1-based line `call`, or undefined: on that call or in its body, up to the first
 * non-blank line indented no deeper than the call.
 */
function pinMarker(rel, src, call) {
  const lines = src.split('\n');
  let end = call;
  while (end < lines.length && (lines[end].trim() === '' || indent(lines[end]) > indent(lines[call - 1]))) end++;
  return markersIn(rel, src).find((m) => m.line >= call && m.line <= end);
}

/** Whether a tag for `row` counts in `rel`: one of its path sites or its pin test's file. */
const counts = (row, rel) => row.sites.includes(rel) || row.pin_test.path === rel;

function readJson(root, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    fail(`${rel} is not JSON: ${error.message}`);
  }
}

/** Why a row's shape is refused, or undefined. */
function rowFault(row, phases) {
  if (!isObject(row)) return 'is not an object';
  const extra = Object.keys(row).filter((k) => !ROW_FIELDS.includes(k));
  if (extra.length) return `has unknown field(s) ${extra.join(', ')}`;
  if (!W_ID.test(row.id ?? '')) return 'needs an id W<n>';
  for (const field of ['library', 'pin', 'what', 'exit']) if (!isText(row[field])) return `needs ${field}`;
  if (row.status !== 'open' && row.status !== 'closed') return 'needs a status, open or closed';
  if (!Array.isArray(row.sites) || row.sites.length === 0) return 'needs at least one site';
  for (const site of row.sites) {
    const pointer = isObject(site) && Object.keys(site).length === 2 && isRepoPath(site.file)
      && typeof site.pointer === 'string' && site.pointer.startsWith('/');
    if (!isRepoPath(site) && !pointer) return `has a site that is neither a repository path nor {file, pointer}: ${JSON.stringify(site)}`;
  }
  const pin = row.pin_test;
  const planned = isObject(pin) && Object.keys(pin).length === 1 && isObject(pin.planned);
  if (planned) {
    if (!phases.includes(pin.planned.phase)) return `plans its pin test in ${JSON.stringify(pin.planned.phase)}, not one of ${RULES_TABLE}'s phases`;
    if (!BEAD.test(pin.planned.bead ?? '')) return 'plans its pin test with no bead';
  } else if (!(isObject(pin) && Object.keys(pin).length === 2 && isRepoPath(pin.path) && isText(pin.title))) {
    return 'needs pin_test {path, title} or {planned: {phase, bead}}';
  }
  const report = row.report;
  if (!(typeof report === 'string' && (REPORT.some((r) => r.test(report)) || (report === '' && row.status === 'open')))) {
    return 'needs a report: a bead id, "declined <date>: <reason>", "none: <why>" or, while open, empty';
  }
  return undefined;
}

/** The register's rows, by id; fails closed on a missing or refused register. */
export function readRegister(root) {
  const doc = readJson(root, REGISTER);
  if (doc === undefined) fail(`no ${REGISTER}`);
  if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.workarounds)) fail(`${REGISTER} is {version: 1, workarounds: [row]}`);
  if ('rules' in doc) fail(`${REGISTER} is no rule table; drop its top-level rules key (2.1-M222)`);
  const phases = readJson(root, RULES_TABLE)?.phases ?? [];
  const rows = new Map();
  doc.workarounds.forEach((row, i) => {
    const fault = rowFault(row, phases);
    if (fault) fail(`${REGISTER} /workarounds/${i} ${fault}`);
    if (rows.has(row.id)) fail(`${REGISTER} lists ${row.id} twice; ids are never reused`);
    rows.set(row.id, row);
  });
  return rows;
}

/** The value at an RFC 6901 pointer, or undefined. */
function resolvePointer(doc, pointer) {
  let at = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(at) ? !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= at.length : !isObject(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/** Every string anywhere in a JSON value. */
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) || isObject(v) ? Object.values(v).flatMap(strings) : []);

/** One site per fault (see the header). */
export function collect({ root, paths }) {
  const rows = readRegister(root);
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const sites = [];
  const site = (kind, id, rel, line) => sites.push({ rule: RULE, name: `${kind} ${id} ${rel}`, path: rel, ...(line ? { line } : {}) });
  const tagged = new Map();
  for (const rel of paths) {
    if (!(JS.test(rel) || RUST.test(rel) || TOML.test(rel)) || !exists(rel)) continue;
    const tags = tagsIn(rel, read(rel));
    tagged.set(rel, tags);
    for (const { id, line } of tags) {
      const row = rows.get(id);
      if (!row) site('no-row', id, rel, line);
      else if (row.status === 'closed') site('closed', id, rel, line);
      else if (!counts(row, rel)) site('stray', id, rel, line);
    }
  }
  const given = new Set(paths);
  if (given.has(REGISTER)) {
    for (const row of rows.values()) {
      if (row.status !== 'open') continue;
      for (const s of row.sites) {
        const rel = typeof s === 'string' ? s : s.file;
        if (rel.startsWith(`${FIXTURES_DIR}/`)) continue;
        if (!exists(rel)) { site('no-file', row.id, rel); continue; }
        if (typeof s === 'string') {
          if (given.has(rel) && !(tagged.get(rel) ?? tagsIn(rel, read(rel))).some((t) => t.id === row.id)) site('no-tag', row.id, rel);
          continue;
        }
        let value;
        try {
          value = resolvePointer(JSON.parse(read(rel)), s.pointer);
        } catch {
          value = undefined;
        }
        if (value === undefined || (typeof value === 'string' && W_ID.test(value) && value !== row.id)) site('no-pointer', row.id, rel);
      }
      const pin = row.pin_test;
      if (pin.planned) continue;
      if (!exists(pin.path)) { site('no-pin', row.id, pin.path); continue; }
      const src = read(pin.path);
      const found = pinAt(src, pin.title);
      if (!found) { site('no-pin', row.id, pin.path); continue; }
      const marker = pinMarker(pin.path, src, found.call);
      if (marker && !marker.ids.has(row.id)) site('no-tag', row.id, pin.path, found.at);
    }
  }
  if (given.has(ADVISORIES)) {
    for (const id of new Set(strings(readJson(root, ADVISORIES)).filter((v) => W_ID.test(v)))) {
      if (rows.get(id)?.status !== 'open') site('advisory', id, ADVISORIES);
    }
  }
  return sites;
}

/**
 * The expected-fail markers tagged with an open row where its tag counts, exempt from the pre-push marker rule:
 * [{ path, line, id }].
 */
export function markers({ root, paths }) {
  const rows = readRegister(root);
  return paths.filter((rel) => JS.test(rel) && !rel.startsWith(`${FIXTURES_DIR}/`) && fs.existsSync(path.join(root, rel)))
    .flatMap((rel) => markersIn(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
      .flatMap(({ line, ids }) => [...ids].filter((id) => rows.get(id)?.status === 'open' && counts(rows.get(id), rel)).map((id) => ({ path: rel, line, id }))));
}

/** Tracked and unignored files under `root`, as the checker's default check lists them; GIT_* dropped as a hook sets them. */
function trackedFiles(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const ls = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const deleted = new Set(ls('--deleted'));
  return ls('--cached', '--others', '--exclude-standard').filter((f) => !deleted.has(f));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'markers') {
    console.error('usage: node policy/adapters/upstream-register.mjs markers');
    process.exitCode = 2;
  } else {
    try {
      for (const m of markers({ root: REPO_ROOT, paths: trackedFiles(REPO_ROOT) })) console.log(`${m.path}:${m.line} ${m.id}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
