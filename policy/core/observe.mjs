// policy/core/observe.mjs: holding families to their tools (2.1-M348): the adapters' sites observed against a
// family, every rule's planted violation run through its real tool, and the default check over the repository.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { absentBeadRefusals, closedBeadRefusals, trackerExport } from '../beads.mjs';
import { unlockedCliRefusals } from '../locked-cli.mjs';
import { releaseVersionRefusals } from '../release-version.mjs';
import { phaseMarkerRefusals } from '../phase-markers.mjs';
import { observer, unrunLanes } from '../selection.mjs';
import { adapterFile, CASES_DIR, FIXTURES_DIR, RATCHETS_DIR, refusal, REPO_ROOT } from './base.mjs';
import { exec, listFiles } from './exec.mjs';
import { matchesGlob } from './globs.mjs';
import { pathFilterRefusals } from './path-filters.mjs';
import { compare, loadRatchets, shapeOf } from './ratchets.mjs';
import { loadTableRules, phaseCloseRefusals, plannedPins, rowFamilyRefusals } from './tables.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Observation: adapters
//
// policy/adapters/<tool>.mjs runs its tool with the real config and normalises what it reports (2.1-M188):
//   collect({ root, paths, exec, select }) -> Site[]
//                                               a ratchet family's tool: every site it reports over `paths` (an adapter
//                                               may skip the rules the family's `select` leaves out)
//   measure({ root, paths, exec }) -> observed  a budget or floor family's tool: the values compare() takes
//   refuse(site, doc) -> string | undefined     optional: why the family refuses this site whatever its baseline
// A Site is { rule, path?, name?, target?, line?, refused? }: `rule` is the tool's rule id, `path` the repository
// file, `name` a named edge, `target` the `<tool>:<rule>` a suppression names (its path-rule key), `refused` why the
// adapter refuses it for every family. A tool that cannot run throws an error whose `code` is `tool-failed`, and one
// that exits 0 while reporting errors `reporter-exit`. `exec(command, args, { cwd })` -> { status, stdout, stderr }
// runs the tool; the self-test passes one that replays recorded output. `tools` is the root whose
// desktop/web/node_modules holds the pinned tool binaries (default `root`; the self-test passes this repository's,
// and none with a case's `tools: false`); a binary missing there is `tool-failed`, never an npx or PATH fetch.

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
export function toolRefusal(error, where) {
  if (error?.code === 'tool-failed' || error?.code === 'reporter-exit') return refusal(error.code, where, error.message);
  throw error;
}

/** Holds one loaded family to what its adapter observes over `paths`; returns its refusals. */
export async function observeFamily(root, file, doc, paths, adapter, inScope = () => true, shared = undefined) {
  const measured = shapeOf(doc) === 'budgets' || shapeOf(doc) === 'floors';
  const needed = measured ? 'measure' : 'collect';
  if (typeof adapter[needed] !== 'function') {
    return [refusal('adapter-contract', file, `${adapterFile(doc.tool)} exports no ${needed}() for a ${shapeOf(doc)} family`)];
  }
  try {
    if (measured) return compare(doc, await adapter.measure({ root, paths, exec }));
    const sites = (await adapter.collect({ root, paths, exec, select: doc.select, shared })).filter((s) => s.path === undefined || inScope(s.path));
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
// its baseline (unlisted or rising; a count family's planted sites against 0, 2.1-M231) or a value it measures (below a floor, over a budget or over other globs). A refused
// site is neither a failure nor a firing: a tool that sees nothing (a config listing no method) refuses every
// exemption too, so a refusal proves nothing about the rule's real config. A table row naming a family runs
// through that family the same way, and a table rule with no family (an agent-hooks or commit-gate row, enforced outside
// the checker) must have its tool report the rule's id there. A family's planted directory fires file by file: each planted
// file must be touched by a firing site, so one firing file cannot hide a sibling guarding another glob; manifests and
// the helpers in policy/fixtures/rules/helpers.json (each with its reason) aside (canopi-f47t.52.224). A rule whose planted violation passes is untested, so the checker fails it. This checker's own
// id is exempt: its planted violations are the cases under policy/fixtures/check/.

export const PLANTED_DIR = `${FIXTURES_DIR}/rules`;
const FIRES = new Set(['unlisted', 'rising', 'below-floor', 'over-budget', 'floor-globs']);
/** Refusals a planted violation may give besides firing: a listed entry it does not hold, a site refused outright. */
const PLANTED_NEUTRAL = new Set(['stale', 'refused-site']);

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
 * Each observed rule with its planted paths, by id, and per tool the union of those paths: as in checkRepo, an adapter
 * exporting `shared` scans every planted path of its tool once (ast-grep).
 */
function plantedPaths(root, rules, observes) {
  const files = listFiles(root);
  const planted = [...rules].sort(([a], [b]) => a.localeCompare(b)).map(([id, rule]) => [id, rule,
    files.filter((f) => f.startsWith(`${PLANTED_DIR}/${id}/`))]).filter(([, { family }, paths]) => paths.length && observes(family?.doc));
  const sharing = new Map();
  for (const [, { tool }, paths] of planted) {
    if (typeof tool === 'string') sharing.set(tool, { union: [...sharing.get(tool)?.union ?? [], ...paths] });
  }
  return { planted, sharing };
}

/**
 * Whether `site` touches the planted file `file`: it is the site's file, or the site's name names it as one end of an
 * edge (a repository path, or a module path relative to its source root) or holds it in a folder group (an SCC's
 * `a <-> b`).
 */
function touches(site, file) {
  if (site.path === file) return true;
  return (site.name ?? '').split(/ -> | <-> /).some((end) => end && (end === file || file.endsWith(`/${end}`) || file.includes(`/${end}/`)));
}

/** A planted file a tool reads as a manifest or config, never as a site (a planted crate's Cargo.toml, knip's package.json). */
const MANIFESTS = new Set(['.gitignore', 'Cargo.toml', 'Cargo.lock', 'deny.toml', 'package.json', 'knip.json']);
/** Planted source files that only carry a violation (an import cycle's other half, a reach chain's middle): { rule -> { file -> why } }. */
const PLANTED_HELPERS = `${PLANTED_DIR}/helpers.json`;

/** The declared helpers ({ rule -> Set of repository paths }), with a refusal for each that names no planted file. */
function plantedHelpers(root, files) {
  const file = path.join(root, PLANTED_HELPERS);
  const declared = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const helpers = new Map();
  const refusals = [];
  for (const [id, entries] of Object.entries(declared)) {
    for (const rel of Object.keys(entries)) {
      const full = `${PLANTED_DIR}/${id}/${rel}`;
      if (!files.includes(full)) refusals.push(refusal('stray-planted', PLANTED_HELPERS, `helper ${id}/${rel} names no planted file; remove it`));
      else helpers.set(id, new Set([...helpers.get(id) ?? [], full]));
    }
  }
  return { helpers, refusals };
}

/**
 * A family's planted violation: { failed, fired, silent }. `failed` holds refusals that are neither firing nor
 * neutral; `fired` whether the directory fires as a whole; `silent` each planted file (manifests and `helpers` aside)
 * no firing site touches, so one firing file never hides a sibling that guards another glob (canopi-f47t.52.224). A
 * measured family (budgets, floors), or one whose sites name crates or modules rather than files, fires as one.
 */
async function plantedFamily(root, file, doc, paths, adapter, shared, helpers = new Set()) {
  const measured = shapeOf(doc) === 'budgets' || shapeOf(doc) === 'floors';
  if (measured || typeof adapter.collect !== 'function') {
    const found = await observeFamily(root, file, doc, paths, adapter, undefined, shared);
    const failed = found.filter((r) => !FIRES.has(r.code) && !PLANTED_NEUTRAL.has(r.code));
    return { failed, fired: found.some((r) => FIRES.has(r.code)), silent: [] };
  }
  let sites;
  try {
    sites = await adapter.collect({ root, paths, exec, select: doc.select, shared });
  } catch (error) {
    return { failed: [toolRefusal(error, file)], fired: false, silent: [] };
  }
  const judge = (subset) => {
    const { observed, refusals } = observe(doc, subset, adapter.refuse);
    return [...refusals, ...compare(doc, observed)];
  };
  const found = judge(sites);
  const failed = found.filter((r) => !FIRES.has(r.code) && !PLANTED_NEUTRAL.has(r.code));
  const fired = found.some((r) => FIRES.has(r.code));
  const selected = sites.filter((s) => !doc.select || doc.select.includes(s.rule));
  if (failed.length || !fired || !selected.some((s) => s.path !== undefined)) return { failed, fired, silent: [] };
  const held = paths.filter((p) => !MANIFESTS.has(path.posix.basename(p)) && !helpers.has(p));
  const silent = held.filter((p) => !judge(sites.filter((s) => touches(s, p))).some((r) => FIRES.has(r.code)));
  return { failed: [], fired, silent };
}

/**
 * Runs the planted violation of each observed rule (in `lane` alone, a rule with no family being commit-lane, or of the
 * named `only` families) through its tool; refuses each that does not fire, with every rule's layout refusals.
 */
export async function checkPlanted(root = REPO_ROOT, lane = 'commit', only = []) {
  const { rules, refusals, families } = plantableRules(root);
  if (refusals.length) return refusals;
  const observes = observer(lane, only, families);
  refusals.push(...plantedLayout(root, rules));
  const { planted, sharing } = plantedPaths(root, rules, observes);
  const { helpers, refusals: strayHelpers } = plantedHelpers(root, listFiles(root));
  refusals.push(...strayHelpers);
  for (const [id, { tool, family, table }, paths] of planted) {
    const where = `${PLANTED_DIR}/${id}/`;
    if (typeof tool !== 'string' || !fs.existsSync(path.join(root, adapterFile(tool)))) {
      refusals.push(refusal('no-adapter', table ?? family.file, `rule ${id}'s tool ${tool ?? '(none named)'} has no adapter to run its planted violation`));
      continue;
    }
    const adapter = await loadAdapter(root, tool);
    const shared = adapter.shared ? sharing.get(tool) : undefined;
    let fired;
    if (family) {
      // A count family's planted sites are its own, so they are compared with 0: against the whole tree's count a
      // planted clone reads falling, neither firing nor neutral (2.1-M231).
      const doc = shapeOf(family.doc) === 'count' ? { ...family.doc, count: 0 } : family.doc;
      const result = await plantedFamily(root, family.file, doc, paths, adapter, shared, helpers.get(id));
      if (result.failed.length) { refusals.push(...result.failed); continue; }
      for (const file of result.silent) {
        refusals.push(refusal('planted-silent', file, `${tool} does not fail rule ${id} on this planted file; every planted file must fire (a helper the rule needs fires through the site that names it)`));
      }
      fired = result.fired;
    } else {
      try {
        if (typeof adapter.collect !== 'function') {
          refusals.push(refusal('adapter-contract', table, `${adapterFile(tool)} exports no collect() for rule ${id}`));
          continue;
        }
        fired = (await adapter.collect({ root, paths, exec, shared })).some((s) => s.rule === id);
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
 * The default check: load every family and policy table, then hold each observed family (in `lane` alone, or the named
 * `families`) to its adapter's sites over the scope's files, planted fixtures left out.
 */
export async function checkRepo(root = REPO_ROOT, lane = 'commit', { phaseClose, families: only = [] } = {}) {
  const started = performance.now();
  const { families, refusals } = loadRatchets(root);
  const tables = loadTableRules(root);
  refusals.push(...tables.refusals, ...rowFamilyRefusals(families, tables));
  if (phaseClose !== undefined) {
    refusals.push(...phaseCloseRefusals(tables, phaseClose, families, plannedPins(root)), ...phaseMarkerRefusals(root, tables.phases, phaseClose));
  }
  const exported = trackerExport(root);
  refusals.push(...exported.refusals, ...closedBeadRefusals(families, tables, exported.statuses));
  refusals.push(...absentBeadRefusals(families, tables, exported));
  refusals.push(...unlockedCliRefusals(root), ...releaseVersionRefusals(root));
  refusals.push(...pathFilterRefusals(root, families, listFiles(root)));
  const declared = new Set([...families.keys(), ...tables.rules.keys()]);
  if (!refusals.length) refusals.push(...plantedLayout(root, declared));
  refusals.push(...await unrunLanes(root, families, path.join(root, CASES_DIR)));
  const observes = observer(lane, only, families);
  const files = listFiles(root).filter((f) => !f.startsWith(`${FIXTURES_DIR}/`));
  // Each observed family's wall time in seconds, and the load and table checks before them (`setup`).
  // An adapter exporting `shared` scans the union of its observed families' paths once per run (ast-grep).
  const observed = [...families.values()].filter(({ doc }) => observes(doc)).map(({ file, doc }) => {
    const inScope = (p) => !p.startsWith(`${FIXTURES_DIR}/`) && doc.scope.some((glob) => matchesGlob(p, glob));
    return { file, doc, inScope, paths: files.filter(inScope) };
  });
  const unions = new Map();
  for (const { doc, paths } of observed) unions.set(doc.tool, new Set([...unions.get(doc.tool) ?? [], ...paths]));
  const sharing = new Map();
  const timings = { setup: (performance.now() - started) / 1000, families: {} };
  for (const { file, doc, inScope, paths } of observed) {
    const begun = performance.now();
    const adapter = await loadAdapter(root, doc.tool);
    if (adapter.shared && !sharing.has(doc.tool)) sharing.set(doc.tool, { union: [...unions.get(doc.tool)].sort() });
    refusals.push(...await observeFamily(root, file, doc, paths, adapter, inScope, sharing.get(doc.tool)));
    timings.families[doc.family] = (performance.now() - begun) / 1000;
  }
  timings.total = (performance.now() - started) / 1000;
  return { families, refusals, timings };
}
