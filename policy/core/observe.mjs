// policy/core/observe.mjs: holding families to their tools (2.1-M348): the adapters' sites observed against a
// family, every rule's planted violation run through its real tool, and the default check over the repository.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beadStatuses, closedBeadRefusals } from '../beads.mjs';
import { unlockedCliRefusals } from '../locked-cli.mjs';
import { observer, unrunLanes } from '../selection.mjs';
import { adapterFile, CASES_DIR, FIXTURES_DIR, RATCHETS_DIR, refusal, REPO_ROOT } from './base.mjs';
import { exec, listFiles } from './exec.mjs';
import { matchesGlob } from './globs.mjs';
import { compare, loadRatchets, shapeOf } from './ratchets.mjs';
import { loadTableRules, phaseCloseRefusals, plannedPins, rowFamilyRefusals } from './tables.mjs';

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
// its baseline (unlisted or rising; a count family's planted sites against 0, 2.1-M231) or a value it measures (below a floor, over a budget or over other globs). A refused
// site is neither a failure nor a firing: a tool that sees nothing (a config listing no method) refuses every
// exemption too, so a refusal proves nothing about the rule's real config. A table row naming a family runs
// through that family the same way, and a table rule with no family (an agent-hooks or commit-gate row, enforced outside
// the checker) must have its tool report the rule's id there. A rule whose planted violation passes is untested, so the checker fails it. This checker's own
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
      // A count family's planted sites are its own, so they are compared with 0: against the whole tree's count a
      // planted clone reads falling, neither firing nor neutral (2.1-M231).
      const doc = shapeOf(family.doc) === 'count' ? { ...family.doc, count: 0 } : family.doc;
      const found = await observeFamily(root, family.file, doc, paths, adapter);
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
  if (phaseClose !== undefined) refusals.push(...phaseCloseRefusals(tables, phaseClose, families, plannedPins(root)));
  refusals.push(...closedBeadRefusals(families, tables, beadStatuses(root)));
  refusals.push(...unlockedCliRefusals(root));
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
