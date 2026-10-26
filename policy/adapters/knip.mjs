// policy/adapters/knip.mjs: knip's unused files, exports, types and dependencies as sites (contracts §12; 2.1-E2,
// 2.1-Q215, 2.1-M185).
//
// Runs desktop/web's pinned knip with its generated config (desktop/web/knip.json, policy/generate.mjs):
// `knip --production --reporter json --no-progress --treat-config-hints-as-errors`, plus this module as a second
// reporter (its default export), since the json reporter prints no configuration hint: it adds one `knip-hints:` line
// after the report on stdout (stdout, since a run that exits 0 keeps no stderr). Each reported item is a site
// { rule, path, target }: `rule` the knip issue type (files, exports, types, dependencies, unlisted, ...), `path` the
// repository file it sits in (package.json for a dependency), `target` `knip:<type>/<symbol>` (`knip:files/file` for an
// unused file), so a path-rule family keys it `<path>: knip:<type>/<symbol>`.
//
// Two graphs until 2a deletes the edition aliases: knip resolves an alias to its first existing target, so a run reads
// only the Desktop aliases (tsconfig.json, vite.config.ts). When desktop/web/tsconfig.web-graph.json exists (the hand
// Web aliases, 2.1-M218) a second run reads it with --tsConfig, and a site counts only when both runs report it, an
// unused file in one run covering every name in it. A planted run (every path under one policy/fixtures/rules/<id>/)
// runs once with --directory over that directory and its own generated knip.json.
//
// knip exits 1 when it reports anything, so the exit status vouches for the report: exit 2 (a config or plugin that
// fails to load) or any other status, a configuration hint, no hints line from the second reporter (it did not run),
// a report line that is not knip's JSON report, or exit 1 with nothing reported fail as `tool-failed`; exit 0 with issues is
// `reporter-exit`. Recorded output: policy/fixtures/recorded/knip/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CWD = 'desktop/web';
const BIN = 'node_modules/.bin/knip';
const WEB_TSCONFIG = 'tsconfig.web-graph.json';
const PLANTED = /^policy\/fixtures\/rules\/[^/]+\//u;
const HINTS = 'knip-hints: ';
const SELF = fileURLToPath(import.meta.url);
const OWN_ROOT = path.resolve(path.dirname(SELF), '../..');
const ARGS = ['--production', '--reporter', 'json', '--reporter', SELF, '--no-progress', '--treat-config-hints-as-errors'];

const fail = (code, message) => { throw Object.assign(new Error(`knip: ${message}`), { code }); };
const firstLine = (text) => text.trim().split('\n')[0] ?? '';

/** knip's reporter interface: the configuration and tag hints as one stdout line the adapter reads back. */
export default function hintsReporter({ configurationHints = [], tagHints = [] }) {
  process.stdout.write(`${HINTS}${JSON.stringify({ configurationHints: [...configurationHints], tagHints: [...tagHints] })}\n`);
}

/** The sites of one run's json report, checked against its exit status and hints line; `base` prefixes knip's paths. */
export function parse(stdout, { status = 0, stderr = '', base = CWD } = {}) {
  if (status !== 0 && status !== 1) fail('tool-failed', `exit ${status}: ${firstLine(stderr) || firstLine(stdout)}`);
  const lines = stdout.split('\n').filter((l) => l.trim());
  const line = lines.find((l) => l.startsWith(HINTS));
  if (!line) fail('tool-failed', `no hints line from the hints reporter (exit ${status}): ${firstLine(stderr)}`);
  const { configurationHints = [], tagHints = [] } = JSON.parse(line.slice(HINTS.length));
  const hints = [...configurationHints, ...tagHints];
  if (hints.length) fail('tool-failed', `configuration hint(s), errors here: ${hints.map((h) => `${h.type ?? 'tag'} ${h.identifier ?? h.tagName ?? JSON.stringify(h)}`).join(', ')}`);
  let report;
  try {
    report = JSON.parse(lines.filter((l) => l !== line).join('\n'));
  } catch {
    fail('tool-failed', `no JSON report (exit ${status}): ${firstLine(stdout)}`);
  }
  if (!Array.isArray(report?.issues)) fail('tool-failed', 'the report has no issues array');
  const sites = report.issues.flatMap((row) => Object.entries(row).filter(([type, items]) => type !== 'owners' && Array.isArray(items)).flatMap(([type, items]) => items.map((item) => {
    const name = type === 'files' ? 'file' : Array.isArray(item) ? item.map((i) => i.name).join(',') : item?.name;
    if (typeof row.file !== 'string' || typeof name !== 'string' || !name) fail('tool-failed', `an issue without a file and a name: ${JSON.stringify(item)}`);
    return { rule: type, path: path.posix.normalize(`${base}/${row.file}`), target: `knip:${type}/${name}` };
  })));
  if (status === 0 && sites.length) fail('reporter-exit', `exit 0 with ${sites.length} issue(s)`);
  if (status === 1 && !sites.length) fail('tool-failed', `exit 1 with nothing reported: ${firstLine(stderr)}`);
  return sites;
}

/** The sites both graphs report: a site of one run held by the other's same key or by its unused file. */
export function bothGraphs(a, b) {
  const keyOf = (s) => `${s.path}: ${s.target}`;
  const holds = (sites) => {
    const keys = new Set(sites.map(keyOf));
    const files = new Set(sites.filter((s) => s.rule === 'files').map((s) => s.path));
    return (s) => keys.has(keyOf(s)) || (s.rule !== 'files' && files.has(s.path));
  };
  const [inA, inB] = [holds(a), holds(b)];
  const aKeys = new Set(a.map(keyOf));
  return [...a.filter(inB), ...b.filter((s) => !aKeys.has(keyOf(s)) && inA(s))];
}

export function collect({ root, paths, exec }) {
  if (paths.length === 0) return [];
  const bin = [root, OWN_ROOT].map((r) => path.join(r, CWD, BIN)).find((b) => fs.existsSync(b));
  if (!bin) fail('tool-failed', `no ${CWD}/${BIN} (run npm ci in ${CWD}; never an npx fetch)`);
  const planted = PLANTED.exec(paths[0])?.[0];
  if (planted && paths.every((p) => p.startsWith(planted))) {
    const dir = path.join(root, planted);
    const { status, stdout, stderr } = exec(bin, [...ARGS, '--directory', dir], { cwd: dir });
    return parse(stdout, { status, stderr, base: planted.slice(0, -1) });
  }
  const cwd = path.join(root, CWD);
  const run = (extra) => {
    const { status, stdout, stderr } = exec(bin, [...ARGS, ...extra], { cwd });
    return parse(stdout, { status, stderr });
  };
  const desktop = run([]);
  const sites = fs.existsSync(path.join(cwd, WEB_TSCONFIG)) ? bothGraphs(desktop, run(['--tsConfig', WEB_TSCONFIG])) : desktop;
  return sites.filter((s) => paths.some((q) => s.path === q || s.path.startsWith(`${q}/`)));
}
