#!/usr/bin/env node
// policy/adapters/scenario-owners.mjs: the scenario owner fixtures and their re-walk diff (ADR 0028 stopping rule;
// 2.1-Q3, 2.1-M92, 2.1-M170).
//
// policy/scenarios/s01.json .. s12.json each hold one change scenario of the plan's table: `{id, title, path, owners,
// ideal, unnamed?, unnamed_note?, bound, checked_at, walks}`. `path` is the user path or roadmap item behind it.
// `owners` lists the modules the ideal change touches, each a path in the layer table's coordinates (relative to
// desktop/web/src for a frontend module, the repository path otherwise; a trailing slash for a directory), or
// `{module, status: 'new', phase, note?}` for one not built yet. `ideal` is the plan's count: the owners plus
// `unnamed`, the owners its walk counted without naming (`unnamed_note` says which). `bound` is floor(ideal * 1.25),
// held from `checked_at` (a phase of policy/rules.json) on. `walks` is the history, oldest first, the first one
// `baseline`: `{phase, commit, touched, count}`, `count` the touched modules counted the way the plan counts them
// (2.1-M170): tests and generated files are no modules, a path under an owner directory counts as that owner, the
// locale family (`i18n/`) is one module and a format bump one module, the core (`canopi-format/`, ADR 0023, 0026); an
// owner that is a member of such a family counts as the family, so two members listed as owners are one owner twice.
// Every path is first moved through the layer table's destinations (longest row prefix wins), so a walk recorded
// before a move reads in today's coordinates.
//
// collect({ root, paths }) gives one site { rule: 'scenario-owners', name: '<kind> <id> <detail>', path } per fault,
// and the family (keys name, entries {}) fails every one as unlisted:
//   shape        a scenario file that is not JSON or not of the shape above, or whose id is not its file name
//   no-owner     an owner that exists nowhere: a built one with no file or directory, a new one no layer row covers
//                (frontend) or whose parent directory does not exist (elsewhere)
//   built        an owner marked new that exists
//   no-phase     a new owner's phase, `checked_at` or a walk's phase that policy/rules.json does not list
//   test-owner, generated-owner   an owner that is a test or a generated file
//   ideal        ideal other than the owners plus unnamed
//   bound        bound other than floor(ideal * 1.25)
//   walk-count   a walk whose count is not its touched modules counted
//   over-bound   a walk at or after checked_at counting more than bound
//   missing      a scenario of s01..s12 without its file, when policy/scenarios/ is among `paths`
// Scenario files are the paths under policy/scenarios/ and, for a planted run, under policy/fixtures/.
//
//   node policy/adapters/scenario-owners.mjs rewalk <walk.json>
// reads `{scenario, phase, commit, touched}`, prints the counted modules outside the owners, the count against ideal
// and bound, and the modules added and removed against the scenario's last walk; it exits 1 over the bound at or after
// checked_at and never writes a fixture (record a walk by adding it to `walks`). ownerOf(), counted() and rewalk() are
// exported for the trial scorer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// check.mjs's constants and its layer-move reading, restated: importing check.mjs here would deadlock its CLI, whose
// top-level await is still pending when it loads this adapter.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RULES_TABLE = 'policy/rules.json';
const LAYER_TABLE = 'policy/layers.json';
const SRC = 'desktop/web/src';
export const SCENARIOS_DIR = 'policy/scenarios';
const FIXTURES_DIR = 'policy/fixtures';
const RULE = 'scenario-owners';
export const SCENARIO_IDS = Array.from({ length: 12 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
const FIELDS = ['id', 'title', 'path', 'owners', 'ideal', 'unnamed', 'unnamed_note', 'bound', 'checked_at', 'walks'];
const WALK_FIELDS = ['phase', 'commit', 'touched', 'count'];
/** Module families that count as one module (2.1-M170): every path under a key's prefixes counts as the key. */
const FOLDS = [
  { as: 'i18n/', under: ['i18n/'] },
  { as: 'canopi-format/', under: ['canopi-format/', 'desktop/src/design/format.rs'] },
];
const REPO_TEST = /(?:^|\/)(?:__tests__|tests|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/|_)tests?\.rs$|(?:^|\/)e2e\.rs$|(?:^|\/)test_[^/]*\.py$/u;
const REPO_GENERATED = /_generated\.rs$|(?:^|\/)(?:package-lock\.json|Cargo\.lock)$/u;

const fail = (message) => { throw Object.assign(new Error(`scenario-owners: ${message}`), { code: 'tool-failed' }); };
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isModule = (p) => isText(p) && !p.startsWith('/') && p.replace(/\/$/u, '').split('/').every((s) => s && s !== '.' && s !== '..');
const under = (p, prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix);
/** A module path as its family (FOLDS) when it is a member of one, else itself. */
const folded = (p) => FOLDS.find((f) => f.under.some((u) => under(p, u)))?.as ?? p;

function readJson(root, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The layer-table row covering `p`, the longest path winning (policy/generate.mjs's rowFor). */
function rowFor(rows, p) {
  let best;
  for (const row of rows) {
    if (typeof row?.path !== 'string') continue;
    const covers = under(p, row.path) || (row.path.endsWith('/') && p === row.path);
    if (covers && (!best || row.path.length > best.path.length)) best = row;
  }
  return best;
}

/**
 * What a scenario is judged against: the layer table's rows and its moves (old prefix -> destination, as check.mjs's
 * layerMoves reads them), the phases in order. A missing layer table or rules table fails the run.
 */
export function context(root) {
  const table = readJson(root, LAYER_TABLE);
  if (!isObject(table) || !Array.isArray(table.layers)) fail(`no readable ${LAYER_TABLE}`);
  const phases = readJson(root, RULES_TABLE)?.phases;
  if (!Array.isArray(phases)) fail(`no phases in ${RULES_TABLE}`);
  const moves = new Map(table.layers.filter((r) => isText(r?.destination)).map((r) => [r.path, r.destination]));
  return { rows: table.layers, moves, phases, root };
}

/** A module path moved through the layer table's destinations, the longest moved prefix winning. */
export function moved(p, moves) {
  let best;
  for (const from of moves.keys()) if ((under(p, from) || p === from) && (!best || from.length > best.length)) best = from;
  if (best === undefined) return p;
  const to = moves.get(best);
  return best.endsWith('/') ? `${to.endsWith('/') ? to : `${to}/`}${p.slice(best.length)}` : to;
}

/** Whether `p` is a frontend module (its first segment names a layer row's or a directory under src). */
function isSrc(ctx, p) {
  const first = p.split('/')[0];
  return ctx.rows.some((r) => typeof r?.path === 'string' && r.path.split('/')[0] === first)
    || (ctx.root !== undefined && fs.existsSync(path.join(ctx.root, SRC, first)));
}

const fileOf = (ctx, p) => path.join(ctx.root, isSrc(ctx, p) ? SRC : '', p.replace(/\/$/u, ''));
const exists = (ctx, p) => {
  const file = fileOf(ctx, p);
  return p.endsWith('/') ? fs.existsSync(file) && fs.statSync(file).isDirectory() : fs.existsSync(file) && fs.statSync(file).isFile();
};
const isTest = (ctx, p) => (isSrc(ctx, p) ? rowFor(ctx.rows, p)?.layer === 'test' || /\.(?:test|spec)\.tsx?$/u.test(p) : REPO_TEST.test(p));
const isGenerated = (ctx, p) => (isSrc(ctx, p) ? p.startsWith('generated/') || rowFor(ctx.rows, p)?.area === 'generated' : REPO_GENERATED.test(p));
const ownerModule = (o) => (typeof o === 'string' ? o : o?.module);

/**
 * The owner a touched module counts as, both moved through the layer table and folded into their family: the owner it
 * is or sits under, or undefined.
 */
export function ownerOf(p, owners, moves) {
  const at = folded(moved(p, moves));
  return owners.map((o) => folded(moved(ownerModule(o), moves))).find((m) => at === m || (m.endsWith('/') && at.startsWith(m)));
}

/** The modules a walk's touched paths count as (see the header), sorted. */
export function counted(touched, owners, ctx) {
  const out = new Set();
  for (const raw of touched) {
    const p = moved(raw, ctx.moves);
    if (isTest(ctx, p) || isGenerated(ctx, p)) continue;
    out.add(ownerOf(p, owners, ctx.moves) ?? folded(p));
  }
  return [...out].sort();
}

const phaseAt = (phases, phase) => (phase === 'baseline' ? -1 : phases.indexOf(phase));

/**
 * A walk read against its scenario: { modules, count, outside, added, removed, over } where `outside` are the counted
 * modules no owner covers, `added` and `removed` against `previous` (a walk, or none), `over` whether the walk is at or
 * after checked_at and counts more than the bound.
 */
export function rewalk(scenario, walk, ctx, previous) {
  const modules = counted(walk.touched, scenario.owners, ctx);
  const before = previous ? new Set(counted(previous.touched, scenario.owners, ctx)) : new Set();
  const now = new Set(modules);
  const at = phaseAt(ctx.phases, walk.phase);
  return {
    modules,
    count: modules.length,
    outside: modules.filter((m) => !ownerOf(m, scenario.owners, ctx.moves)),
    added: previous ? modules.filter((m) => !before.has(m)) : [],
    removed: [...before].filter((m) => !now.has(m)),
    over: at >= 0 && at >= ctx.phases.indexOf(scenario.checked_at) && modules.length > scenario.bound,
  };
}

/** Why a scenario document is refused, or undefined. */
function shapeFault(doc, id) {
  if (!isObject(doc)) return 'is not a JSON object';
  const extra = Object.keys(doc).find((k) => !FIELDS.includes(k));
  if (extra) return `has an unknown field ${extra}`;
  if (doc.id !== id) return `has id ${JSON.stringify(doc.id)}, not its file name ${id}`;
  if (!isText(doc.title) || !isText(doc.path)) return 'needs a title and a path (the user path or roadmap item)';
  if (!Array.isArray(doc.owners) || !doc.owners.length) return 'needs owners';
  for (const o of doc.owners) {
    const ok = typeof o === 'string' ? isModule(o)
      : isObject(o) && isModule(o.module) && o.status === 'new' && isText(o.phase) && Object.keys(o).every((k) => ['module', 'status', 'phase', 'note'].includes(k));
    if (!ok) return `has an owner ${JSON.stringify(o)} that is neither a module path nor {module, status: "new", phase, note?}`;
  }
  if (new Set(doc.owners.map((o) => folded(ownerModule(o)))).size !== doc.owners.length) return 'lists an owner twice (a module family counts as one owner)';
  if (![doc.ideal, doc.bound].every((n) => Number.isInteger(n) && n > 0)) return 'needs a positive integer ideal and bound';
  if ('unnamed' in doc && !(Number.isInteger(doc.unnamed) && doc.unnamed > 0 && isText(doc.unnamed_note))) return 'needs unnamed (a positive integer) with its unnamed_note';
  if ('unnamed_note' in doc && !('unnamed' in doc)) return 'has an unnamed_note without unnamed';
  if (!isText(doc.checked_at)) return 'needs checked_at';
  if (!Array.isArray(doc.walks) || !doc.walks.length || doc.walks[0]?.phase !== 'baseline') return 'needs walks, the first one the baseline';
  for (const w of doc.walks) {
    const ok = isObject(w) && Object.keys(w).every((k) => WALK_FIELDS.includes(k)) && isText(w.phase) && /^[0-9a-f]{40}$/u.test(w.commit ?? '')
      && Array.isArray(w.touched) && w.touched.length && w.touched.every(isModule) && Number.isInteger(w.count);
    if (!ok) return `has a walk ${JSON.stringify(w?.phase)} that is not {phase, commit (full hash), touched, count}`;
  }
  return undefined;
}

/** The faults of one scenario document read from `rel` (see the header). */
export function scenarioFaults(doc, rel, ctx) {
  const id = path.basename(rel, '.json');
  const faults = [];
  const fault = (kind, detail) => faults.push({ rule: RULE, name: `${kind} ${id} ${detail}`, path: rel });
  const refused = shapeFault(doc, id);
  if (refused) { fault('shape', refused); return faults; }
  const known = (phase) => ctx.phases.includes(phase);
  for (const o of doc.owners) {
    const m = ownerModule(o);
    if (isTest(ctx, m)) fault('test-owner', m);
    else if (isGenerated(ctx, m)) fault('generated-owner', m);
    if (typeof o === 'string') {
      if (!exists(ctx, m)) fault('no-owner', m);
      continue;
    }
    if (!known(o.phase)) fault('no-phase', `${m} ${o.phase}`);
    if (exists(ctx, m)) fault('built', m);
    else if (isSrc(ctx, m) ? !rowFor(ctx.rows, m) : !fs.existsSync(path.dirname(fileOf(ctx, m)))) fault('no-owner', m);
  }
  const ideal = doc.owners.length + (doc.unnamed ?? 0);
  if (doc.ideal !== ideal) fault('ideal', `${doc.ideal} is not the ${doc.owners.length} owners plus ${doc.unnamed ?? 0} unnamed`);
  if (doc.bound !== Math.floor(doc.ideal * 1.25)) fault('bound', `${doc.bound} is not floor(${doc.ideal} * 1.25)`);
  if (!known(doc.checked_at)) fault('no-phase', `checked_at ${doc.checked_at}`);
  doc.walks.forEach((w, i) => {
    if (w.phase !== 'baseline' && !known(w.phase)) { fault('no-phase', `walk ${w.phase}`); return; }
    const read = rewalk(doc, w, ctx, doc.walks[i - 1]);
    if (w.count !== read.count) fault('walk-count', `${w.phase} counts ${w.count}, its touched modules count ${read.count}`);
    if (known(doc.checked_at) && read.over) fault('over-bound', `${w.phase} counts ${read.count} over the bound ${doc.bound}`);
  });
  return faults;
}

const isScenarioFile = (rel) => rel.endsWith('.json') && (rel.startsWith(`${SCENARIOS_DIR}/`) || rel.startsWith(`${FIXTURES_DIR}/`));

/** One site per fault (see the header). */
export function collect({ root, paths }) {
  const files = paths.filter(isScenarioFile);
  const real = paths.some((p) => p.startsWith(`${SCENARIOS_DIR}/`));
  if (!files.length && !real) return [];
  const ctx = context(root);
  const sites = files.flatMap((rel) => scenarioFaults(readJson(root, rel), rel, ctx));
  if (real) {
    for (const id of SCENARIO_IDS) {
      const rel = `${SCENARIOS_DIR}/${id}.json`;
      if (!fs.existsSync(path.join(root, rel))) sites.push({ rule: RULE, name: `missing ${id} ${rel}`, path: rel });
    }
  }
  return sites;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, file] = process.argv.slice(2);
  if (mode !== 'rewalk' || !file) {
    console.error('usage: node policy/adapters/scenario-owners.mjs rewalk <walk.json>');
    process.exitCode = 2;
  } else {
    try {
      const walk = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObject(walk) || !SCENARIO_IDS.includes(walk.scenario) || !isText(walk.phase) || !Array.isArray(walk.touched)) {
        fail('a walk is {scenario: s01..s12, phase, commit, touched: [module]}');
      }
      const ctx = context(REPO_ROOT);
      if (!ctx.phases.includes(walk.phase)) fail(`phase ${walk.phase} is not in ${RULES_TABLE}`);
      const rel = `${SCENARIOS_DIR}/${walk.scenario}.json`;
      const scenario = readJson(REPO_ROOT, rel);
      const refused = shapeFault(scenario, walk.scenario);
      if (refused) fail(`${rel} ${refused}`);
      const read = rewalk(scenario, walk, ctx, scenario.walks.at(-1));
      const list = (xs) => (xs.length ? xs.join(', ') : 'none');
      console.log(`${walk.scenario} at ${walk.phase}${walk.commit ? ` (${walk.commit})` : ''}: ${read.count} modules, ideal ${scenario.ideal}, bound ${scenario.bound} from ${scenario.checked_at}`);
      console.log(`outside the owners: ${list(read.outside)}`);
      console.log(`added since ${scenario.walks.at(-1).phase}: ${list(read.added)}`);
      console.log(`removed since ${scenario.walks.at(-1).phase}: ${list(read.removed)}`);
      if (read.over) {
        console.log(`over the bound: ${read.count} > ${scenario.bound}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
