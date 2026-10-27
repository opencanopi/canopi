// policy/adapters/cross-area-edges.mjs: the cross-area edges, one presence site per area pair (2.1-Q3, 2.1-M200).
//
// An area is a policy/layers.json row's `area` (the longest row covering a module wins) or a workspace crate (its
// package name). An edge is a runtime import between production modules of two areas, in either edition's graph:
// desktop/web's depcruise with both generated configs (an aliased edition module resolves to its Desktop file in one
// graph and its Web file in the other); a type-only import is no edge, a re-export and a dynamic import are; tests (a
// `test` layer row, a .test or .spec file) are left out. A workspace member's `[dependencies]` or
// `[build-dependencies]` path dependency on another member is a crate edge, read from the Cargo.toml files (no cargo
// run), written inline, as a dotted key or as a table, or inherited (`workspace = true`) from the root's
// `[workspace.dependencies]`; a dev-dependency is a test edge and left out.
//
// collect({ root, paths, exec }) gives one site { rule: 'cross-area-edges', path, name: '<area> -> <area>' } per edge
// pair, `path` the first file (sorted) that makes it; the family (keys name) holds each pair as an entry of count 1,
// so a new pair fails unlisted and a pair gone fails stale. A module at either end of a runtime edge that no row gives
// an area is a refused site: the run cannot place the edge, so it fails the default check whatever the baseline. A real cruise covers src/ and ui-gallery/
// whatever paths it is given (only src/ modules have areas; the gallery is outside the table); a planted one (every
// path under policy/fixtures/) cruises exactly its paths, laid out as policy/fixtures/rules/<id>/src/<module path>.
// The crate edges are read when the root Cargo.toml is among the paths.
//
// A real run also refuses each pair with no bead in policy/ratchets/cross-area-edges.json all of whose module edges are
// layer-order or edition-roots entries, families Phase 2 takes to 0: such a pair is removed by the plan, so its entry
// carries the removing stream's bead and the target (the entries without one) leaves it out (2.1-M200, 2.1-M238).
//
// The report vouches for itself as dependency-cruiser's adapter's parse() does (an environment issue, nothing cruised,
// an error count that disagrees), and a real cruise reaching a planted module fails the run.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from './dependency-cruiser.mjs';

const RULE = 'cross-area-edges';
const CWD = 'desktop/web';
const BIN = 'node_modules/.bin/depcruise';
const CONFIGS = ['.dependency-cruiser.cjs', '.dependency-cruiser.web.cjs'];
const REAL_ROOTS = ['src', 'ui-gallery'];
const FIXTURES = 'policy/fixtures/';
const LAYER_TABLE = 'policy/layers.json';
const MIRROR = /^(?:\.\.\/\.\.\/policy\/fixtures\/rules\/[^/]+\/)?src\//u;
const TYPE_ONLY = ['type-only', 'type-import'];
const RUNTIME_SECTIONS = new Set(['dependencies', 'build-dependencies']);
const RATCHETS = 'policy/ratchets';
/** The families the plan's Phase 2 exit takes to 0 (docs/plans/2-1-foundations.md, Phase 2 exit). */
const PHASE_2_TO_ZERO = ['layer-order', 'edition-roots'];

const fail = (message) => { throw Object.assign(new Error(`cross-area-edges: ${message}`), { code: 'tool-failed' }); };
const modulePath = (p) => p.replace(MIRROR, '');
const srcRoot = (p) => MIRROR.exec(p)?.[0];

/** The layer-table row covering `file`, the longest path winning (policy/generate.mjs's rowFor). */
function rowFor(rows, file) {
  let best;
  for (const row of rows) {
    const p = row.path.replace(/\/$/u, '');
    const covers = row.path.endsWith('/') ? file.startsWith(`${p}/`) : file === p;
    if (covers && (!best || p.length > best.path.replace(/\/$/u, '').length)) best = row;
  }
  return best;
}

const memo = new WeakMap();

/** One cruise's parsed report, memoised per runner (`exec`), root, config and arguments within this process. */
function cruise(exec, root, config, args) {
  if (!memo.has(exec)) memo.set(exec, new Map());
  const held = memo.get(exec);
  const key = JSON.stringify([root, config, args]);
  if (!held.has(key)) {
    const cwd = path.join(root, CWD);
    const { status, stdout } = exec(path.join(cwd, BIN), ['--config', config, '--output-type', 'json', ...args], { cwd });
    held.set(key, parse(stdout, { cwd: CWD, status }));
  }
  return held.get(key);
}

/** The module edges' sites of both graphs' reports. */
function moduleSites(root, reports) {
  let table;
  try {
    table = JSON.parse(fs.readFileSync(path.join(root, LAYER_TABLE), 'utf8'));
  } catch {
    fail(`no readable ${LAYER_TABLE}`);
  }
  const rows = (table.layers ?? []).filter((r) => typeof r?.path === 'string');
  const isTest = (rel) => /\.(?:test|spec)\.tsx?$/u.test(rel) || rowFor(rows, rel)?.layer === 'test';
  const sites = [];
  const unplaced = new Map();
  const areaOf = (rel, source) => {
    const area = rowFor(rows, rel)?.area;
    if (typeof area !== 'string' && !unplaced.has(rel)) unplaced.set(rel, source);
    return area;
  };
  for (const { modules } of reports) {
    for (const m of modules) {
      const at = srcRoot(m.source);
      if (!at || isTest(modulePath(m.source))) continue;
      for (const d of m.dependencies ?? []) {
        if (typeof d.resolved !== 'string' || srcRoot(d.resolved) !== at || isTest(modulePath(d.resolved))) continue;
        if ((d.dependencyTypes ?? []).some((t) => TYPE_ONLY.includes(t))) continue;
        const from = areaOf(modulePath(m.source), m.source);
        const to = areaOf(modulePath(d.resolved), d.resolved);
        if (from && to && from !== to) {
          sites.push({ rule: RULE, path: path.posix.normalize(`${CWD}/${m.source}`), name: `${from} -> ${to}`, edge: `${modulePath(m.source)} -> ${modulePath(d.resolved)}` });
        }
      }
    }
  }
  for (const [rel, source] of unplaced) {
    sites.push({ rule: RULE, path: path.posix.normalize(`${CWD}/${source}`), name: `no-area ${rel}`, refused: `no row of ${LAYER_TABLE} gives ${rel} an area` });
  }
  return sites;
}

const DEP_SECTION = /^(?:dev-|build-)?dependencies$/u;
const SHARED = 'workspace.dependencies';

/**
 * A Cargo.toml's package name and its dependencies that may be path dependencies, [{ section, key, dir?, workspace? }]:
 * `dir` from `path = "..."` (inline, dotted `key.path` or a `[<section>.<key>]` table), `workspace` when the entry is
 * inherited (`workspace = true`) from the root's `[workspace.dependencies]`, whose own entries come under that section.
 */
export function cargoPaths(text) {
  let section = '';
  let table;
  let name;
  const deps = new Map();
  const entry = (key) => {
    const id = `${section}\0${key}`;
    if (!deps.has(id)) deps.set(id, { section, key });
    return deps.get(id);
  };
  const read = (key, field, value) => {
    if (field === 'path') entry(key).dir = /^"([^"]+)"$/u.exec(value)?.[1];
    if (field === 'workspace' && value === 'true') entry(key).workspace = true;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/u, '').trim();
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      const parts = header[1].split('.').map((s) => s.trim());
      // [dependencies], [target.'cfg(...)'.dependencies], [dependencies.<name>] and [workspace.dependencies(.<name>)]
      const at = parts.findIndex((p) => DEP_SECTION.test(p));
      section = at === -1 ? parts.join('.') : parts[0] === 'workspace' ? SHARED : parts[at];
      table = at !== -1 && parts.length > at + 1 ? parts[at + 1] : undefined;
      continue;
    }
    if (section === 'package') name ??= /^name\s*=\s*"([^"]+)"/u.exec(line)?.[1];
    if (!DEP_SECTION.test(section) && section !== SHARED) continue;
    if (table) {
      const field = /^(path|workspace)\s*=\s*("[^"]*"|true|false)/u.exec(line);
      if (field) read(table, field[1], field[2]);
      continue;
    }
    const dotted = /^([A-Za-z0-9_-]+)\.(path|workspace)\s*=\s*("[^"]*"|true|false)/u.exec(line);
    if (dotted) read(dotted[1], dotted[2], dotted[3]);
    const inline = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}/u.exec(line);
    if (inline) for (const [, field, value] of inline[2].matchAll(/\b(path|workspace)\s*=\s*("[^"]*"|true|false)/gu)) read(inline[1], field, value);
  }
  return { name, deps: [...deps.values()].filter((d) => d.dir || d.workspace) };
}

/** The crate edges of the workspace under `root`. */
function crateSites(root) {
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
  const workspace = read('Cargo.toml');
  if (workspace === undefined) fail('no readable Cargo.toml');
  const members = /\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/su.exec(workspace)?.[1];
  if (members === undefined) fail('Cargo.toml lists no workspace members');
  // A member's `workspace = true` entry takes the root's path, relative to the root; a registry entry has none.
  const shared = new Map(cargoPaths(workspace).deps.filter((d) => d.section === SHARED && d.dir).map((d) => [d.key, path.posix.normalize(d.dir)]));
  const dirs = [...members.matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  const crates = new Map();
  for (const dir of dirs) {
    const text = read(`${dir}/Cargo.toml`);
    if (text === undefined) fail(`workspace member ${dir} has no Cargo.toml`);
    const crate = cargoPaths(text);
    if (!crate.name) fail(`${dir}/Cargo.toml names no package`);
    crates.set(dir, crate);
  }
  const sites = [];
  for (const [dir, crate] of crates) {
    for (const dep of crate.deps) {
      if (!RUNTIME_SECTIONS.has(dep.section)) continue;
      const to = dep.dir ? path.posix.normalize(`${dir}/${dep.dir}`) : shared.get(dep.key);
      if (to === undefined) continue;
      const target = crates.get(to);
      if (target) sites.push({ rule: RULE, path: `${dir}/Cargo.toml`, name: `${crate.name} -> ${target.name}` });
      else sites.push({ rule: RULE, path: `${dir}/Cargo.toml`, name: `no-area ${to}`, refused: `${dir}/Cargo.toml depends on ${to}, which is no workspace member` });
    }
  }
  return sites;
}

/**
 * A refused site per pair every one of whose module edges is an entry of a family Phase 2 takes to 0 while the pair's
 * own entry carries no bead: the plan removes that pair, so it is no standing edge and the target leaves it out.
 */
function unbeadedSites(root, sites) {
  const entries = (family) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, RATCHETS, `${family}.json`), 'utf8')).entries ?? {};
    } catch {
      return {};
    }
  };
  const removed = new Set(PHASE_2_TO_ZERO.flatMap((family) => Object.keys(entries(family))));
  const own = entries(RULE);
  const edges = new Map();
  for (const s of sites) if (s.edge) edges.set(s.name, [...(edges.get(s.name) ?? []), s]);
  const refused = [];
  for (const [pair, held] of edges) {
    if (!own[pair] || own[pair].bead || !held.every((s) => removed.has(s.edge))) continue;
    refused.push({ rule: RULE, path: held[0].path, name: `unbeaded ${pair}`, refused: `every module edge of ${pair} is a ${PHASE_2_TO_ZERO.join(' or ')} entry, which Phase 2 takes to 0: its entry needs the bead of the stream that removes it` });
  }
  return refused;
}

/** One site per pair, the first path (sorted) that makes it; refused sites one per name. */
function onePerName(sites) {
  const held = new Map();
  for (const s of [...sites].sort((a, b) => a.path.localeCompare(b.path))) if (!held.has(s.name)) held.set(s.name, s);
  return [...held.values()];
}

export function collect({ root, paths, exec }) {
  if (paths.length === 0) return [];
  const planted = paths.every((p) => p.startsWith(FIXTURES));
  const sites = [];
  const cruised = paths.filter((p) => (planted ? /^policy\/fixtures\/rules\/[^/]+\/src\//u : /^desktop\/web\/src\//u).test(p));
  if (cruised.length) {
    const cwd = path.join(root, CWD);
    const args = planted
      ? cruised.map((p) => path.relative(cwd, path.join(root, p)).split(path.sep).join('/'))
      : REAL_ROOTS.filter((r) => fs.existsSync(path.join(cwd, r)));
    const reports = CONFIGS.map((config) => cruise(exec, root, config, args));
    if (!planted) {
      const leaked = reports.flatMap((r) => r.modules).find((m) => path.posix.normalize(`${CWD}/${m.source}`).startsWith(FIXTURES));
      if (leaked) fail(`the repository cruise reached ${leaked.source}: a planted violation leaks into the real graph`);
    }
    const modules = moduleSites(root, reports);
    sites.push(...modules, ...(planted ? [] : unbeadedSites(root, modules)));
  }
  if (!planted && paths.includes('Cargo.toml')) sites.push(...crateSites(root));
  return onePerName(sites).map(({ edge, ...site }) => site);
}
