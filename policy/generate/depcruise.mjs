// policy/generate/depcruise.mjs: dependency-cruiser's Desktop and Web configs from the layer table and the policy
// tables' active rows (contracts §12, §18; ADR 0022 Checks; 2.1-M185, 2.1-M218; Phase 0 F1a, split from
// policy/generate.mjs by 2.1-Q243).
//
// The Desktop config (tsconfig.json) and the Web config (tsconfig.web-graph.json, holding only the Web-only rules so no
// id is reported from both graphs, AF27). A rule is generated only for an active row (a planned row generates none)
// and names its id, or `<id>:<sub>`, its ADR, owner and canonical example from that row. Every path regex also admits
// the planted mirror, policy/fixtures/rules/<id>/src/<module path>, so a planted violation runs through the real
// config; the mirror is an alternation, never an optional group, which dependency-cruiser refuses as an unsafe
// expression.
import path from 'node:path';
import { builtinModules } from 'node:module';
import { matchesGlob } from '../check.mjs';
import { HEADER, SRC, bare, escRe, filesUnder, isObject } from './boundary-facts.mjs';

const LAYER_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const MIRROR = '\\.\\./\\.\\./policy/fixtures/rules/[^/]+/';
/** A module root (src/, ui-gallery/) as a regex prefix that also admits its planted mirror. */
const under = (prefix) => `^(?:${escRe(prefix)}|${MIRROR}${escRe(prefix)})`;
/** A layer-table path or owner glob (`platform/*.desktop.ts`) as a regex body: a directory prefix or one file. */
const pathBody = (p) => (p.endsWith('/') ? escRe(p) : `${escRe(p).replaceAll('\\*', '[^/]*')}$`);
const srcRe = (paths) => (paths.length ? `${under('src/')}(?:${paths.map(pathBody).join('|')})` : undefined);
/** A package row's pattern as a resolved path, or as the bare specifier a planted fixture (outside desktop/web, so
 * unable to resolve packages) leaves unresolved. */
const pkgRe = (pattern) => (pattern === '*' ? '^node_modules/' : `^(?:node_modules/)?${escRe(pattern.replace(/\/$/u, ''))}(?:/|$)`);
const anyOf = (res) => res.filter(Boolean).join('|') || undefined;
/** A graph spec's glob (relative to desktop/web/src, or a package specifier) as a regex body dependency-cruiser takes as
 * safe: `**` any path, `** /` any leading directories, `*` within a segment, `{a,b}` alternatives; undefined for other
 * glob syntax (graphRefusals refuses it). */
export function globBody(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) { out += '(?:.*/|)'; i += 2; } else if (glob.startsWith('**', i)) { out += '.*'; i += 1; } else if (c === '*') out += '[^/]*';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) return undefined;
      out += `(?:${glob.slice(i + 1, end).split(',').map(escRe).join('|')})`;
      i = end;
    } else if ('?[]!}'.includes(c)) return undefined;
    else out += escRe(c);
  }
  return out;
}
/** Module globs (relative to desktop/web/src) as one regex over src/ and its planted mirror. */
const srcGlobsRe = (globs = []) => (globs.length ? `${under('src/')}(?:${globs.map((g) => `${globBody(g)}$`).join('|')})` : undefined);
/** The Node built-ins importable without the `node:` prefix, top-level names. Frozen by Node: every built-in added
 * since Node 18 (`node:sea`, `node:sqlite`, `node:test`) exists only with the prefix, so this set is the same on every
 * Node the policy runs on, and the generated configs never change with the Node version (`generate --self-test` holds
 * the running Node's prefix-free built-ins to it). */
export const NODE_BUILTINS = ['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'];
/** A package glob (`@tauri-apps/**`, `maplibre-gl`) as a resolved path or the bare specifier a planted fixture leaves
 * unresolved; a `node:` glob (`node:*`) as the built-ins it names with their subpaths (`fs/promises`), prefixed or as
 * dependency-cruiser resolves a prefix-free one (`node:fs/promises` to `fs/promises`). */
const pkgGlobRe = (glob) => {
  if (!glob.startsWith('node:')) return `^(?:node_modules/)?${globBody(glob.replace(/\/\*\*$/u, ''))}(?:[/.]|$)`;
  const body = globBody(glob.slice('node:'.length));
  const named = new RegExp(`^${body}$`, 'u');
  const bare = NODE_BUILTINS.filter((m) => named.test(m)).map(escRe);
  return `^(?:node:${body}${bare.length ? `|${bare.join('|')}` : ''})(?:/|$)`;
};
/** Every package a graph spec of the active rows names (`packages`, `packagesNot`), as the bare form includeOnly keeps. */
const rulePackages = (rows) => [...new Set([...rows.values()].flatMap(graphSpecs).flatMap((g) => [...(g.packages ?? []), ...(g.packagesNot ?? [])]))]
  .sort().map((p) => pkgGlobRe(p).replace('(?:node_modules/)?', ''));
/** A row's graph specs: `graph` is one spec or a list (one generated rule each, `<id>:<n>`). */
export const graphSpecs = (row) => (row.graph === undefined ? [] : Array.isArray(row.graph) ? row.graph : [row.graph]);
const GRAPH_KEYS = new Set(['from', 'fromNot', 'tests', 'to', 'toNot', 'typeOnlyTo', 'packages', 'packagesNot', 'aliases', 'reachable', 'runtime']);
/** The module globs that must match a file: a source or an exemption naming nothing holds nothing; a forbidden target
 * (`to`) may name a module not written yet. */
const GRAPH_HELD = ['from', 'fromNot', 'toNot', 'typeOnlyTo'];
const GRAPH_GLOBS = ['from', 'fromNot', 'to', 'toNot', 'typeOnlyTo'];

/** Refusals for the active rows' `graph` specs: a key outside the vocabulary, a glob globBody cannot write, a module
 * glob matching no file under desktop/web/src (rule-path, FAP's path drift), `aliases` outside a reachable spec. */
export function graphRefusals(root, rows) {
  const files = filesUnder(path.join(root, SRC));
  const refusals = [];
  for (const row of rows.values()) {
   if (row.graph === undefined) continue;
   const specs = Array.isArray(row.graph) ? row.graph : [row.graph];
   for (const g of specs) {
    const where = `${row.id} graph`;
    if (!isObject(g)) { refusals.push({ code: 'rule-graph', where, message: 'graph is an object or a list of objects' }); continue; }
    for (const key of Object.keys(g)) if (!GRAPH_KEYS.has(key)) refusals.push({ code: 'rule-graph', where, message: `"${key}" is not a graph key (${[...GRAPH_KEYS]})` });
    if (g.aliases && !g.reachable) refusals.push({ code: 'rule-graph', where, message: 'aliases name unresolved targets of a reachable walk only; dependency-cruiser resolves the others' });
    if (!g.to && !g.packages && !g.aliases) refusals.push({ code: 'rule-graph', where, message: 'a graph spec names its targets (to, packages or aliases)' });
    for (const key of [...GRAPH_GLOBS, 'packages', 'packagesNot', 'aliases']) {
      if (g[key] === undefined) continue;
      if (!Array.isArray(g[key]) || !g[key].every((x) => typeof x === 'string' && x)) { refusals.push({ code: 'rule-graph', where, message: `${key} is a list of globs` }); continue; }
      for (const glob of g[key]) {
        if (globBody(glob) === undefined) refusals.push({ code: 'rule-graph', where, message: `${key} glob ${glob} uses syntax other than **, * and {a,b}` });
        else if (GRAPH_HELD.includes(key) && glob !== '**' && !files.some((f) => matchesGlob(f, glob))) {
          refusals.push({ code: 'rule-path', where, message: `${key} glob ${glob} matches no file under ${SRC}` });
        }
      }
    }
  }
   }
  return refusals;
}
const DESKTOP_ADAPTER = '\\.desktop\\.tsx?$';
const BROWSER_ADAPTER = '\\.browser\\.tsx?$';
const RUNTIME_ONLY = ['type-only', 'type-import', 'dynamic-import'];
const asArray = (v) => (Array.isArray(v) ? v : [v]);
const level = (u) => LAYER_ORDER.indexOf(u.layer);

/** The layer table's built rows grouped by area (or path) and level: [{key, layer, rank, edition, paths}]. */
function unitsOf(table) {
  const units = new Map();
  for (const row of table.layers) {
    if (row.status === 'new' || row.layer === 'test') continue;
    const area = row.area ?? bare(row.path);
    const key = [...units.values()].some((u) => u.area === area && (u.layer !== row.layer || u.rank !== row.rank)) ? `${area}@${row.layer}` : area;
    const unit = units.get(key) ?? { key, area, layer: row.layer, rank: row.rank, paths: [] };
    unit.paths.push(row.path);
    units.set(key, unit);
  }
  return [...units.values()];
}

/** Paths of `others` nested under one of the directory paths `paths` (longest prefix wins, so they are not these). */
const nestedUnder = (paths, others) => others.flatMap((u) => u.paths).filter((q) => !paths.includes(q) && paths.some((p) => p.endsWith('/') && q.startsWith(p)));

/** Whether unit `a` may not import unit `b` (ADR 0022:11: lower layers only; in L1 and L2 earlier ranks only). */
const forbidden = (a, b) => a !== b && (level(b) > level(a) || (level(b) === level(a) && ['L1', 'L2'].includes(a.layer) && b.rank >= a.rank));

/** A rule's comment and message: its id, what it forbids, whether type-only edges count, ADR, owner and example. */
function describe(row, what, typeOnly = row.type_only ?? 'counts') {
  return `${row.id}: ${what}. ADR ${row.adr ?? 'none'}; owner ${row.owner_today}; example ${row.example}; type-only edges ${typeOnly}.`;
}

/** The generated Desktop and Web forbidden rules from the layer table and the active rows (`rows`: id -> row). */
function depcruiseRules(table, rows) {
  const units = unitsOf(table);
  const testRe = anyOf([srcRe(table.layers.filter((r) => r.layer === 'test').map((r) => r.path)), '\\.test\\.tsx?$']);
  const desktop = [];
  const web = [];
  const rule = (list, row, sub, what, from, to, typeOnly) => list.push({ name: sub ? `${row.id}:${sub}` : row.id, severity: 'error', comment: describe(row, what, typeOnly), from, to });
  const notTest = (...res) => [testRe, ...res].filter(Boolean);
  const rowsAt = (test) => table.layers.filter((r) => r.status !== 'new' && test(r)).map((r) => r.path);
  const packages = table.packages ?? [];
  const earlier = (i) => packages.slice(0, i).map((p) => pkgRe(p.pattern));

  const order = rows.get('layer-order');
  if (order) {
    for (const u of units) {
      const bad = units.filter((t) => forbidden(u, t));
      if (!bad.length) continue;
      const badPaths = bad.flatMap((t) => t.paths);
      const allowed = units.filter((t) => !bad.includes(t));
      rule(desktop, order, u.key, `${u.key} (${u.layer}${u.rank ? ` rank ${u.rank}` : ''}) imports only lower layers${['L1', 'L2'].includes(u.layer) ? ' and earlier ranks of its layer' : ''}`,
        { path: srcRe(u.paths), pathNot: notTest(srcRe(nestedUnder(u.paths, units.filter((t) => t !== u)))) },
        { path: srcRe(badPaths), pathNot: notTest(srcRe(nestedUnder(badPaths, allowed))) });
    }
    packages.forEach((p, i) => {
      if (p.lowest_layer === undefined) return;
      const lower = units.filter((u) => level(u) < LAYER_ORDER.indexOf(p.lowest_layer));
      if (!lower.length) return;
      const lowerPaths = lower.flatMap((u) => u.paths);
      rule(desktop, order, `package=${p.pattern}`, `${p.pattern === '*' ? 'a package no earlier row names' : p.pattern} is imported from ${p.lowest_layer} up (first package row wins; L0 imports only @preact/signals, ADR 0022:13)`,
        { path: srcRe(lowerPaths), pathNot: notTest(srcRe(nestedUnder(lowerPaths, units.filter((u) => !lower.includes(u))))) },
        { path: pkgRe(p.pattern), ...(i ? { pathNot: earlier(i) } : {}) });
    });
  }

  packages.forEach((p, i) => {
    const row = p.owner === undefined ? undefined : rows.get(p.rule);
    if (!row) return;
    rule(desktop, row, '', `${p.pattern} is imported only by ${asArray(p.owner).join(', ')}`,
      { pathNot: notTest(srcRe(asArray(p.owner))) }, { path: pkgRe(p.pattern), ...(i ? { pathNot: earlier(i) } : {}) });
  });

  const ipc = rows.get('ipc-only-in-desktop-adapters');
  const ipcPaths = rowsAt((r) => r.area === 'ipc');
  if (ipc && ipcPaths.length) {
    rule(desktop, ipc, '', 'ipc/ is imported only by ipc/ and the *.desktop.ts adapters (2.1-M143)',
      { pathNot: notTest(srcRe(ipcPaths), DESKTOP_ADAPTER) }, { path: srcRe(ipcPaths) });
  }

  const tests = rows.get('no-product-imports-a-test');
  if (tests) rule(desktop, tests, '', 'no product module or edition root imports a test or __tests__/ (ADR 0022:11)', { pathNot: testRe }, { path: testRe });

  const runtimeCycle = rows.get('no-runtime-cycle');
  if (runtimeCycle) {
    rule(desktop, runtimeCycle, '', 'production modules form no runtime import cycle (type-only and dynamic edges excluded)',
      { pathNot: testRe }, { circular: true, dependencyTypesNot: RUNTIME_ONLY, viaOnly: { pathNot: testRe, dependencyTypesNot: RUNTIME_ONLY } });
  }
  const typeCycles = rows.get('type-cycles');
  if (typeCycles) {
    rule(desktop, typeCycles, '', 'production modules form no import cycle through a type-only edge (oxlint leaves import/no-cycle to dependency-cruiser, 2.1-M218)',
      { pathNot: testRe }, { circular: true, viaOnly: { pathNot: testRe }, via: { dependencyTypes: ['type-only', 'type-import'] } });
  }

  const roots = rows.get('edition-roots');
  if (roots) {
    const desktopRoot = srcRe(rowsAt((r) => r.layer === 'L5' && r.edition === 'desktop'));
    const webRoot = srcRe(rowsAt((r) => r.layer === 'L5' && r.edition === 'web'));
    const allRoots = anyOf([desktopRoot, webRoot]);
    const gallery = anyOf((table.outside ?? []).filter((o) => o.edition === 'gallery').map((o) => `${under(bare(o.path))}${o.path.endsWith('/') ? '/' : '$'}`));
    rule(desktop, roots, 'desktop-adapter-only-from-desktop-root', 'a .desktop.ts adapter is imported only by the Desktop root or another Desktop adapter',
      { pathNot: notTest(desktopRoot, DESKTOP_ADAPTER) }, { path: DESKTOP_ADAPTER });
    rule(desktop, roots, 'browser-adapter-only-from-web-root', 'a .browser.ts adapter is imported only by the Web root or another browser adapter',
      { pathNot: notTest(webRoot, BROWSER_ADAPTER) }, { path: BROWSER_ADAPTER });
    rule(desktop, roots, 'no-cross-edition', 'Desktop root and adapters never import Web root or browser adapters (ADR 0005)',
      { path: anyOf([desktopRoot, DESKTOP_ADAPTER]), pathNot: notTest() }, { path: anyOf([webRoot, BROWSER_ADAPTER]) });
    rule(desktop, roots, 'nothing-imports-a-root', 'edition roots (L5) compose the app; nothing below imports them',
      { pathNot: notTest(allRoots) }, { path: allRoots, pathNot: notTest() });
    rule(desktop, roots, 'no-edition-alias', 'a root imports its adapters; an edition alias (#platform and its kin) is deleted in 2a',
      { pathNot: notTest() }, { dependencyTypes: ['aliased-tsconfig-paths'], pathNot: '^node_modules/' });
    if (gallery) {
      rule(desktop, roots, 'no-src-imports-gallery', 'no src module imports the gallery edition root (contracts §13)',
        { path: under('src/'), pathNot: notTest() }, { path: gallery });
      rule(desktop, roots, 'gallery-imports-no-native', 'gallery files import no ipc/, @tauri-apps/* or .desktop.ts module directly (aliased specifiers wait for editions/gallery/, 2a)',
        { path: gallery }, { path: anyOf([srcRe(ipcPaths), '^node_modules/@tauri-apps/', DESKTOP_ADAPTER]), dependencyTypesNot: ['aliased-tsconfig-paths', 'aliased'] });
    }
    const webEntries = srcRe(rowsAt((r) => r.layer === 'L5' && r.edition === 'web' && r.entry));
    const desktopOnly = anyOf([srcRe(rowsAt((r) => r.edition === 'desktop')), DESKTOP_ADAPTER,
      ...packages.filter((p) => !p.editions.includes('web')).map((p) => pkgRe(p.pattern))]);
    if (webEntries) {
      rule(web, roots, 'web-root-reaches-no-desktop', 'the Web root reaches no Desktop-edition module or Desktop-only package (ADR 0005; the Web graph, which is the bundle\'s runtime graph)',
        { path: webEntries }, { path: desktopOnly, reachable: true }, 'excluded (the Web graph cruises without tsPreCompilationDeps: a type-only edge never reaches the bundle)');
    }
  }

  // Converted rules (FAP and its siblings, Phase 0 F1a): each active row's `graph` spec, a forbidden edge from the
  // modules `from` names (tests left out unless `tests`) to those `to` and `packages` name. `typeOnlyTo` are targets a
  // type-only edge may reach: a second rule, `<id>:value-edge`, forbids only their value edges. A `reachable` spec is
  // never a config rule: the adapter walks it over the Desktop report (dependency-cruiser.mjs reachSites).
  for (const row of rows.values()) {
   const specs = graphSpecs(row);
   specs.forEach((g, n) => {
    if (g.reachable) return;
    const part = specs.length > 1 ? `${n + 1}` : '';
    const sub = (s) => [part, s].filter(Boolean).join('-');
    const from = { ...(g.from ? { path: srcGlobsRe(g.from) } : {}), pathNot: [g.tests ? undefined : testRe, srcGlobsRe(g.fromNot)].filter(Boolean) };
    const anyTarget = (g.to ?? []).includes('**');
    const to = anyTarget ? undefined : anyOf([srcGlobsRe(g.to ?? []), ...(g.packages ?? []).map(pkgGlobRe)]);
    const typeOnlyTo = srcGlobsRe(g.typeOnlyTo ?? []);
    const toNot = anyOf([srcGlobsRe(g.toNot ?? []), ...(g.packagesNot ?? []).map(pkgGlobRe)]);
    const runtime = g.runtime ? { dependencyTypesNot: ['type-only', 'type-import'] } : {};
    const what = row.note ?? row.id;
    const typeOnly = g.runtime ? 'excluded' : typeOnlyTo ? `counts, but a type-only edge may reach ${g.typeOnlyTo.join(', ')}` : 'counts';
    rule(desktop, row, sub(''), what, from, { ...(to ? { path: to } : {}), ...(anyOf([toNot, typeOnlyTo]) ? { pathNot: anyOf([toNot, typeOnlyTo]) } : {}), ...runtime }, typeOnly);
    if (typeOnlyTo) rule(desktop, row, sub('value-edge'), `${what} (value edges into the type homes)`, from, { path: typeOnlyTo, ...(toNot ? { pathNot: toNot } : {}), dependencyTypesNot: ['type-only', 'type-import'] }, typeOnly);
   });
  }
  return { desktop, web };
}

/** Options for one graph: the Desktop graph counts type-only edges; the Web graph is the bundle's runtime graph. */
const depcruiseOptions = (table, rows, tsConfig, typeOnlyEdges) => ({
  doNotFollow: { path: '^node_modules/' },
  // A named package's bare specifier too, whether a package row or a rule's graph spec names it: the one a planted
  // fixture, unable to resolve packages, leaves unresolved; and the Node built-ins a rule names, which resolve bare.
  includeOnly: [...new Set(['^src/', '^ui-gallery/', '^node_modules/', '^node:', `^${MIRROR}`,
    ...(table.packages ?? []).filter((p) => p.pattern !== '*').map((p) => pkgRe(p.pattern).replace('(?:node_modules/)?', '')),
    ...rulePackages(rows)])],
  exclude: { path: ['\\.css$', '\\.svg$'] },
  tsPreCompilationDeps: typeOnlyEdges,
  tsConfig: { fileName: tsConfig },
  enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'], extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] },
  combinedDependencies: false,
});


/** The Desktop and Web config texts ({desktop, web}) from the layer table and the active rows. */
export function depcruiseConfigs(table, rows) {
  const { desktop, web } = depcruiseRules(table, rows);
  const cjs = (forbidden, ...options) => `// ${HEADER}\nmodule.exports = ${JSON.stringify({ forbidden, options: depcruiseOptions(...options) }, null, 2)};\n`;
  return { desktop: cjs(desktop, table, rows, 'tsconfig.json', true), web: cjs(web, table, rows, 'tsconfig.web-graph.json', false) };
}

/** The running Node's prefix-free built-ins NODE_BUILTINS lacks (the self-test fails on any). The running Node only
 * checks the frozen list, never feeds the output: a prefix-free built-in it lacks would let `import 'that'` past a
 * `node:*` rule. */
export const unlistedBuiltins = () => builtinModules.filter((m) => !m.startsWith('node:') && !m.startsWith('_') && !NODE_BUILTINS.includes(m.split('/')[0]));
