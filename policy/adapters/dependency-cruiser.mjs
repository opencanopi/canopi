// policy/adapters/dependency-cruiser.mjs: dependency-cruiser's violations and graph families as sites (contracts §12;
// 2.1-M58, 2.1-M186, 2.1-M224).
//
// Runs desktop/web's depcruise with both generated configs (policy/generate.mjs): the Desktop graph
// (.dependency-cruiser.cjs) and the Web graph (.dependency-cruiser.web.cjs, only the Web-only rules, AF27). A real
// cruise covers src/ and ui-gallery/ whatever paths it is given and keeps the rule sites leaving those paths; a planted
// one (every path under policy/fixtures/) cruises exactly its paths. Each violation is a site { rule, path, name,
// target }: `rule` the rule id (a generated `<id>:<sub>` reports as `<id>`, the sub kept in `target` so the bead reads
// sub-counts), `path` the repository file the edge leaves, `name` `<from> -> <to>` in the layer table's module
// coordinates (relative to desktop/web/src, the planted mirror policy/fixtures/rules/<id>/src/ stripped), so an entry
// moves with the layer table. Sites identical in rule, from and to are one, whichever graph or sub reports them. Its
// `--output-type baseline` list (the known-violations file) reads the same way, and a violation `--ignore-known`
// reports at severity `ignore` is still a site: the ratchet family is the only baseline, never a second rule home.
//
// Three families are computed from the Desktop graph's modules, production files only (tests excluded), path undefined
// for the two SCC families:
//   l3-feature-scc  the L3 features of policy/layers.json (each row's area), runtime edges (type-only excluded): for each
//                   pair of features in one strongly connected component joined by a direct runtime edge, one site per
//                   file-level runtime edge between them, both ways, named `<a> <-> <b>` (sorted)
//   unit-scc        the same over units (app/<feature>, components/<group>, web/ files, canvas/runtime/<sub>, root
//                   files, other two-segment directories; the reference run's unit()), shrink-only until Phase 2's
//                   "below 53"
//   reachable rows  each active policy table row whose `graph` spec is `reachable` (FAP's forbid-transitive-imports):
//                   from each module its `from` names (tests left out unless `tests`), a walk over the src edges that
//                   stops at a forbidden target, one site per (module, target) named `<from> -> <target>`; with
//                   `runtime` type-only edges are not walked; an aliased edge (#platform and its kin) is never resolved
//                   or walked, its specifier matched against `aliases`, as FAP's runtime graph left aliases; a package
//                   is matched by its specifier against `packages` (a Node built-in as `node:<name>`, a subpath by its
//                   built-in too)
//   deep-imports    an import from outside a folder that has an index.ts into a file of that folder other than its
//                   index.ts, the folders read from the tree at cruise time; type-only edges count; `<from> -> <to>`
//
// depcruise exits 0 whatever it finds with `--output-type json`, so the report vouches for itself instead: an
// environment issue (a missing TypeScript compiler cruises almost nothing), nothing cruised, an error count that
// disagrees with the error violations, or, in a real cruise, a cruised module under policy/fixtures/ (a planted
// violation leaking into the repository's graph) fails the run. Each (root, config, arguments) is cruised once per
// process and runner. Recorded output: policy/fixtures/recorded/dependency-cruiser/.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CWD = 'desktop/web';
const BIN = 'node_modules/.bin/depcruise';
const CONFIGS = ['.dependency-cruiser.cjs', '.dependency-cruiser.web.cjs'];
const REAL_ROOTS = ['src', 'ui-gallery'];
const FIXTURES = 'policy/fixtures/';
const MIRROR = /^(?:\.\.\/\.\.\/policy\/fixtures\/rules\/[^/]+\/)?src\//u;
const TYPE_ONLY = ['type-only', 'type-import'];

/** The layer-table row covering `file`, the longest path winning (policy/generate.mjs's rowFor; importing it here
 * would cycle through policy/check.mjs, which loads this adapter during its top-level await). */
function rowFor(rows, file) {
  let best;
  for (const row of rows) {
    const p = row.path.replace(/\/$/u, '');
    const covers = row.path.endsWith('/') ? file.startsWith(`${p}/`) : file === p;
    if (covers && (!best || p.length > best.path.replace(/\/$/u, '').length)) best = row;
  }
  return best;
}

const fail = (code, message) => { throw Object.assign(new Error(`dependency-cruiser: ${message}`), { code }); };

/** A depcruise module path (relative to desktop/web) in the layer table's coordinates, or itself outside src/. */
const modulePath = (p) => p.replace(MIRROR, '');
/** The src root a depcruise module path sits in (src/ or a planted mirror's), or undefined. */
const srcRoot = (p) => MIRROR.exec(p)?.[0];

/** The report's violations as sites and its modules, from depcruise's JSON report or its baseline list. */
export function parse(stdout, { cwd = CWD, status = 0 } = {}) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('tool-failed', `no JSON report (exit ${status}): ${stdout.trim().split('\n')[0] ?? ''}`);
  }
  let violations;
  if (Array.isArray(report)) {
    violations = report;
  } else {
    const summary = report?.summary;
    if (!summary || !Array.isArray(summary.violations)) fail('tool-failed', 'the report has no summary.violations');
    const issues = summary.environment?.issues ?? [];
    if (issues.length) fail('tool-failed', `environment issue ${issues.map((i) => i.name).join(', ')}`);
    if (!(summary.totalCruised > 0)) fail('tool-failed', 'nothing was cruised');
    const errors = summary.violations.filter((v) => v.rule?.severity === 'error').length;
    if (summary.error !== errors) fail('reporter-exit', `the summary counts ${summary.error} error(s) and lists ${errors}`);
    violations = summary.violations;
  }
  const sites = violations.map((v) => {
    if (typeof v?.from !== 'string' || typeof v?.to !== 'string' || typeof v?.rule?.name !== 'string') {
      fail('tool-failed', `a violation without from, to and rule: ${JSON.stringify(v)}`);
    }
    const [rule, sub] = v.rule.name.split(/:(.*)/su);
    return { rule, ...(sub ? { target: sub } : {}), path: path.posix.normalize(`${cwd}/${v.from}`), name: `${modulePath(v.from)} -> ${modulePath(v.to)}` };
  });
  return { sites, modules: Array.isArray(report?.modules) ? report.modules : [] };
}

/** Sites identical in rule, path and name made one, their subs joined in `target`. */
function dedupe(sites) {
  const seen = new Map();
  for (const s of sites) {
    const key = `${s.rule}\0${s.path}\0${s.name}`;
    const held = seen.get(key);
    if (!held) seen.set(key, { ...s });
    else if (s.target && !(held.target ?? '').split(',').includes(s.target)) held.target = [held.target, s.target].filter(Boolean).sort().join(',');
  }
  return [...seen.values()];
}

/** Strongly connected components (Tarjan) of `adj` (node -> Set of nodes), each with more than one node. */
export function tarjan(adj) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const out = [];
  const visit = (v) => {
    index.set(v, next); low.set(v, next); next++; stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); component.push(w); } while (w !== v);
      if (component.length > 1) out.push(component);
    }
  };
  for (const v of [...adj.keys()].sort()) if (!index.has(v)) visit(v);
  return out;
}

/** The reference run's unit of a module path (analyse.cjs unit(), without its stale feature aliases). */
export function unitOf(rel) {
  const seg = rel.split('/');
  if (seg.length === 1) return rel;
  if (seg[0] === 'app' || seg[0] === 'components') return seg.length > 2 ? `${seg[0]}/${seg[1]}` : rel;
  if (seg[0] === 'web') return rel;
  if (seg[0] === 'canvas' && seg[1] === 'runtime' && seg.length > 3) return `canvas/runtime/${seg[2]}`;
  if (seg[0] === 'canvas' && seg.length === 2) return 'canvas (top)';
  return seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0];
}

/** The production module edges of a Desktop report between src modules of one src root, tests excluded. */
function productEdges(root, modules) {
  const table = JSON.parse(fs.readFileSync(path.join(root, 'policy/layers.json'), 'utf8'));
  const testRows = table.layers.filter((r) => r.layer === 'test');
  const isTest = (rel) => /\.test\.tsx?$/u.test(rel) || rowFor(testRows, rel) !== undefined;
  const edges = [];
  for (const m of modules) {
    const at = srcRoot(m.source);
    if (!at || isTest(modulePath(m.source))) continue;
    for (const d of m.dependencies ?? []) {
      if (typeof d.resolved !== 'string' || srcRoot(d.resolved) !== at || isTest(modulePath(d.resolved))) continue;
      edges.push({ from: modulePath(m.source), to: modulePath(d.resolved), root: at, source: m.source, runtime: !(d.dependencyTypes ?? []).some((t) => TYPE_ONLY.includes(t)) });
    }
  }
  return { table, edges };
}

/** One site per file-level runtime edge between two groups in one SCC that a direct runtime edge joins. */
function sccSites(rule, edges, groupOf) {
  const adj = new Map();
  const between = new Map();
  for (const e of edges) {
    if (!e.runtime) continue;
    const a = groupOf(e.from);
    const b = groupOf(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    const key = [a, b].sort().join(' <-> ');
    between.set(key, (between.get(key) ?? 0) + 1);
  }
  const component = new Map();
  tarjan(adj).forEach((c, i) => c.forEach((n) => component.set(n, i)));
  const sites = [];
  for (const [key, count] of [...between].sort()) {
    const [a, b] = key.split(' <-> ');
    if (component.has(a) && component.get(a) === component.get(b)) for (let i = 0; i < count; i++) sites.push({ rule, name: key });
  }
  return sites;
}

/** Deep imports: an edge into a folder that has an index.ts, from outside it, to a file other than that index.ts. */
function deepImportSites(root, edges) {
  const folders = new Map();
  const walk = (dir, rel) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : e.name === 'index.ts' && rel ? [rel] : []));
  const foldersOf = (at) => {
    if (!folders.has(at)) folders.set(at, walk(path.join(root, CWD, at), ''));
    return folders.get(at);
  };
  return edges.filter((e) => foldersOf(e.root).some((f) => e.to.startsWith(f) && e.to !== `${f}index.ts` && !e.from.startsWith(f)))
    .map((e) => ({ rule: 'deep-imports', path: path.posix.normalize(`${CWD}/${e.source}`), name: `${e.from} -> ${e.to}` }));
}

/** The graph families' sites from the Desktop report's modules, each src root (src/, a planted mirror) its own graph. */
export function graphSites(root, modules) {
  const { table, edges } = productEdges(root, modules);
  const featureOf = (rel) => {
    const row = rowFor(table.layers, rel);
    return row?.layer === 'L3' ? row.area ?? row.path.replace(/\/$/u, '') : undefined;
  };
  const roots = [...new Set(edges.map((e) => e.root))].sort().map((at) => edges.filter((e) => e.root === at));
  return [...roots.flatMap((own) => [...sccSites('l3-feature-scc', own, featureOf), ...sccSites('unit-scc', own, unitOf)]), ...deepImportSites(root, edges)];
}

/** picomatch, the one glob engine (policy/check.mjs matchesGlob), from desktop/web beside this adapter. */
const picomatch = (() => {
  try {
    return createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop/web/package.json'))('picomatch');
  } catch {
    return undefined;
  }
})();
const globMatcher = (globs = []) => {
  if (!picomatch) fail('tool-failed', 'the glob engine picomatch is not installed (run npm ci in desktop/web)');
  const tests = globs.map((g) => picomatch(g, { dot: true, posix: true }));
  return (p) => tests.some((t) => t(p));
};

/** The active rows with a reachable graph spec in every policy table under `root` (policy/*.json with `rules`). */
function reachRows(root) {
  const dir = path.join(root, 'policy');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().flatMap((n) => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      return Array.isArray(doc?.rules) ? doc.rules : [];
    } catch {
      return [];
    }
  }).filter((r) => r.status !== 'planned' && r.tool === 'dependency-cruiser')
    .flatMap((r) => (Array.isArray(r.graph) ? r.graph : r.graph ? [r.graph] : []).filter((g) => g?.reachable === true).map((graph) => ({ id: r.id, graph })));
}

/** The reachable rows' sites over the Desktop report's modules (FAP's forbid-transitive-imports walk). */
export function reachSites(root, modules) {
  const rows = reachRows(root);
  if (!rows.length) return [];
  const table = JSON.parse(fs.readFileSync(path.join(root, 'policy/layers.json'), 'utf8'));
  const testRows = table.layers.filter((r) => r.layer === 'test');
  const isTest = (rel) => /\.test\.tsx?$/u.test(rel) || rowFor(testRows, rel) !== undefined;
  const bySource = new Map(modules.map((m) => [m.source, m]));
  const sites = [];
  for (const row of rows) {
    const g = row.graph;
    const from = globMatcher(g.from ?? ['**']);
    const fromNot = globMatcher(g.fromNot);
    const to = globMatcher(g.to);
    const toNot = globMatcher(g.toNot);
    const packages = globMatcher(g.packages);
    const packagesNot = globMatcher(g.packagesNot);
    const aliases = globMatcher(g.aliases);
    for (const start of modules) {
      const at = srcRoot(start.source);
      const rel = modulePath(start.source);
      if (!at || !from(rel) || fromNot(rel) || (!g.tests && isTest(rel))) continue;
      const visited = new Set([start.source]);
      const reported = new Set();
      const queue = [start];
      for (let i = 0; i < queue.length; i++) {
        for (const d of queue[i].dependencies ?? []) {
          const types = d.dependencyTypes ?? [];
          if (g.runtime && types.some((t) => TYPE_ONLY.includes(t))) continue;
          const aliased = types.some((t) => t.startsWith('aliased'));
          const local = !aliased && typeof d.resolved === 'string' && srcRoot(d.resolved) === at;
          // dependency-cruiser names a Node built-in bare (`node:fs` as `fs`); a row's packages name it `node:fs`, and a
          // subpath (`node:fs/promises`) by its built-in too
          const core = types.includes('core');
          const target = local ? modulePath(d.resolved) : core ? `node:${d.module.replace(/^node:/u, '')}` : d.module;
          const named = (match) => match(target) || (core && match(target.replace(/\/.*$/u, '')));
          const forbidden = aliased ? aliases(target) : local ? to(target) && !toNot(target) : !srcRoot(d.resolved ?? '') && named(packages) && !named(packagesNot);
          if (forbidden) {
            if (!reported.has(target)) {
              reported.add(target);
              sites.push({ rule: row.id, path: path.posix.normalize(`${CWD}/${start.source}`), name: `${rel} -> ${target}` });
            }
            continue;
          }
          const next = local ? bySource.get(d.resolved) : undefined;
          if (next && !visited.has(next.source)) {
            visited.add(next.source);
            queue.push(next);
          }
        }
      }
    }
  }
  return sites;
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

export function collect({ root, paths, exec }) {
  if (paths.length === 0) return [];
  const cwd = path.join(root, CWD);
  const planted = paths.every((p) => p.startsWith(FIXTURES));
  const args = planted
    ? paths.map((p) => path.relative(cwd, path.join(root, p)).split(path.sep).join('/'))
    : REAL_ROOTS.filter((r) => fs.existsSync(path.join(cwd, r)));
  const [desktop, web] = CONFIGS.map((config) => cruise(exec, root, config, args));
  if (!planted) {
    const leaked = [...desktop.modules, ...web.modules].find((m) => path.posix.normalize(`${CWD}/${m.source}`).startsWith(FIXTURES));
    if (leaked) fail('tool-failed', `the repository cruise reached ${leaked.source}: a planted violation leaks into the real graph`);
  }
  const covered = (p) => planted || paths.some((q) => p === q || p.startsWith(`${q}/`));
  return [...dedupe([...desktop.sites, ...web.sites]), ...graphSites(root, desktop.modules), ...reachSites(root, desktop.modules)]
    .filter((s) => s.path === undefined || covered(s.path));
}
