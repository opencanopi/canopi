// policy/adapters/cargo-deny.mjs: cargo-deny's JSON as named sites (contracts §12, §18; 2.1-M204, 2.1-M189; ADR 0028).
//
// Runs the pinned cargo-deny (VERSION, checked against `cargo deny --version` in the same command) as `cargo deny
// --format json check` with the repository's deny.toml (`--config`), over the repository's workspace or a planted
// directory's own (`workspaceDir`), and normalises each error diagnostic to a site `{ rule, name }` keyed `<check>:<advisory id or
// crate>`: an advisory by its id (`advisories:RUSTSEC-2026-0386`, its `target` the crate, version and patched versions
// cargo-deny's Solution note names), anything else by the crate it is about (`bans:gdal`, `licenses:<crate>`). A
// [bans].deny entry's reason starts with the policy table row it enforces (`no-gdal: ...`), and its `banned` site's
// rule is that row's id. A stale ignore (`advisory-not-detected`) is denied, so it fails like a new advisory.
// Warnings (duplicate versions, unused licence allowances) are not sites.
//
// deny.toml and the policy tables must agree (AF11, contracts §18): a [bans].deny entry whose reason cites no active
// row (`config:bans.deny:<crate>`, rule `uncited-ban`) and an active row naming this family with no entry citing it
// (`config:<row id>`, rule `unbanned-row`) are sites too; a planned row needs no entry. The family's own planted
// directory (policy/fixtures/rules/cargo-deny/) brings its own deny.toml for that, an uncited ban; every other planted
// directory runs the repository's deny.toml, so a planted ban proves the real config, and one with a deny.toml of its
// own is refused.
//
// A planted run is offline and checks bans only (its crates are local path crates). The repository's run fetches the
// advisory database: when the fetch fails it is retried once, then the check runs `--offline` on the cached database
// with a warning, and with no cached database it is tool-failed. It fails closed otherwise too: a missing or other
// version of cargo-deny (the message names the install command), a line that is not JSON, no summary (truncated
// output), a summary whose error count differs from the errors listed, an error with no code or a code this adapter
// does not map to its check, and an exit status that disagrees with the errors (0 with errors is reporter-exit).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToml, workspaceDir } from './cargo-manifest.mjs';

export const VERSION = '0.20.2';
const INSTALL = `cargo install --locked --version ${VERSION} cargo-deny`;
const FAMILY = 'cargo-deny';
const OWN_PLANTED = `policy/fixtures/rules/${FAMILY}`;
const CONFIG = 'deny.toml';
const ROW_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*):/;

/** Each diagnostic code cargo-deny 0.20.2 gives, by the check that gives it (its src/*\/diags.rs Code enums). */
const CHECKS = {
  advisories: ['vulnerability', 'notice', 'unmaintained', 'unsound', 'yanked', 'advisory-ignored', 'yanked-ignored',
    'index-failure', 'index-cache-load-failure', 'advisory-not-detected', 'yanked-not-detected', 'unknown-advisory'],
  bans: ['banned', 'allowed', 'not-allowed', 'duplicate', 'skipped', 'wildcard', 'unmatched-skip', 'unnecessary-skip',
    'allowed-by-wrapper', 'unmatched-wrapper', 'skipped-by-root', 'unmatched-skip-root', 'build-script-not-allowed',
    'exact-features-mismatch', 'feature-not-explicitly-allowed', 'feature-banned', 'unknown-feature',
    'default-feature-enabled', 'path-bypassed', 'path-bypassed-by-glob', 'checksum-match', 'checksum-mismatch',
    'denied-by-extension', 'detected-executable', 'detected-executable-script', 'unable-to-check-path',
    'features-enabled', 'unmatched-bypass', 'unmatched-path-bypass', 'unmatched-glob', 'unused-wrapper',
    'workspace-duplicate', 'unresolved-workspace-dependency', 'unused-workspace-dependency', 'non-utf8-path',
    'non-root-path', 'replaced-in-std', 'unmatched-replacement-ignore'],
  licenses: ['accepted', 'rejected', 'unlicensed', 'skipped-private-workspace-crate', 'license-not-encountered',
    'license-exception-not-encountered', 'missing-clarification-file', 'parse-error', 'empty-license-field',
    'no-license-field', 'gather-failure'],
  sources: ['git-source-underspecified', 'allowed-source', 'allowed-by-organization', 'source-not-allowed',
    'unmatched-source', 'unmatched-organization'],
  config: ['deprecated'],
};
const CHECK_OF = new Map(Object.entries(CHECKS).flatMap(([check, codes]) => codes.map((code) => [code, check])));

const fail = (code, message) => { throw Object.assign(new Error(`cargo-deny: ${message}`), { code }); };
const lastLine = (text) => String(text ?? '').trim().split('\n').at(-1) ?? '';

/**
 * cargo-deny prints its JSON on stderr, and a run's exec keeps stderr only when the tool fails, so each run is one POSIX
 * shell command that prints the version of the cargo-deny it runs, then that run's report, both on stdout.
 */
const RUN = 'cargo deny --version && exec cargo deny "$@" 2>&1';

/** One run's stdout without its first line, the version, after refusing a missing or other cargo-deny. */
function versionChecked(stdout, stderr) {
  const [first, ...rest] = String(stdout).split('\n');
  const got = /^cargo-deny (\S+)$/.exec(first.trim())?.[1];
  if (!got) fail('tool-failed', `cargo-deny is not installed (${lastLine(stderr) || 'no version printed'}); install it with \`${INSTALL}\``);
  if (got !== VERSION) fail('tool-failed', `cargo-deny ${got} is installed and ${VERSION} is pinned; install it with \`${INSTALL}\``);
  return rest.join('\n');
}

/** The run's config, repository-relative: the repository's deny.toml, or the family's own planted one. */
function configFor(root, dir) {
  const own = dir ? path.posix.join(dir, CONFIG) : CONFIG;
  if (dir && fs.existsSync(path.join(root, own))) {
    if (dir === OWN_PLANTED) return own;
    fail('tool-failed', `${own}: a planted rule runs the repository's ${CONFIG}; remove its own`);
  }
  if (!fs.existsSync(path.join(root, CONFIG))) fail('tool-failed', `no ${CONFIG} at the repository root`);
  return CONFIG;
}

/** The active rows of the policy tables (policy/*.json `rules`) that name this family, by id; planned rows left out. */
function activeRows(root) {
  const dir = path.join(root, 'policy');
  const ids = new Set();
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue; // policy/check.mjs refuses an unreadable table; it names no row here.
    }
    for (const row of Array.isArray(doc?.rules) ? doc.rules : []) {
      if (row?.family === FAMILY && row.status !== 'planned' && typeof row.id === 'string' && row.id !== FAMILY) ids.add(row.id);
    }
  }
  return ids;
}

/** The consistency sites between a parsed deny.toml and the active rows (AF11). */
export function consistencySites(config, rows) {
  const entries = (Array.isArray(config.bans?.deny) ? config.bans.deny : []).map((e) => (typeof e === 'string' ? { crate: e } : e));
  const sites = [];
  const cited = new Set();
  for (const entry of entries) {
    const crate = entry.crate ?? entry.name ?? '(unnamed)';
    const id = ROW_ID.exec(entry.reason ?? '')?.[1];
    if (id && rows.has(id)) cited.add(id);
    else sites.push({ rule: 'uncited-ban', name: `config:bans.deny:${crate}` });
  }
  for (const id of [...rows].sort()) if (!cited.has(id)) sites.push({ rule: 'unbanned-row', name: `config:${id}` });
  return sites;
}

/** The directory the advisory databases are cached in: deny.toml's [advisories] db-path, else $CARGO_HOME/advisory-dbs. */
function dbDir(config, cwd) {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const raw = config.advisories?.['db-path'] ?? '$CARGO_HOME/advisory-dbs';
  const expanded = raw.replace(/^~(?=\/|$)/, os.homedir()).replace(/\$\{?CARGO_HOME\}?/g, cargoHome);
  return path.resolve(cwd, expanded);
}

const hasCachedDb = (dir) => fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory());

/** A report's ERROR log line saying the advisory database could not be fetched, if any. */
const fetchFailure = (report) => report.logErrors.find((m) => /failed to fetch advisory database/i.test(m));

/**
 * cargo-deny's `--format json` output as { diagnostics, summary, logErrors }, refusing a line that is not
 * JSON. `summary` is undefined when the run printed none (it stopped early, or the output was cut short).
 */
export function readReport(output) {
  const report = { diagnostics: [], summary: undefined, logErrors: [] };
  for (const line of String(output).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      fail('tool-failed', `printed a line that is not JSON (truncated output?): ${line.slice(0, 120)}`);
    }
    if (entry.type === 'diagnostic') report.diagnostics.push(entry.fields ?? {});
    else if (entry.type === 'summary') report.summary = entry.fields ?? {};
    else if (entry.type === 'log' && entry.fields?.level === 'ERROR') report.logErrors.push(String(entry.fields.message ?? ''));
  }
  return report;
}

/** One error diagnostic as a site. */
function siteOf(d) {
  if (typeof d.code !== 'string') fail('tool-failed', `an error with no code: ${d.message}`);
  const check = d.advisory ? 'advisories' : CHECK_OF.get(d.code);
  if (!check) fail('tool-failed', `error code ${d.code} is not one cargo-deny ${VERSION} gives; map it to its check here`);
  const krate = d.graphs?.[0]?.Krate;
  const span = d.labels?.[0]?.span;
  if (check === 'advisories') {
    const id = d.advisory?.id ?? (krate ? undefined : span);
    const solution = (d.notes ?? []).find((n) => n.startsWith('Solution: '));
    const target = krate && solution ? `${krate.name} ${krate.version}: ${solution.slice('Solution: '.length)}` : undefined;
    return { rule: d.code, name: `advisories:${id ?? krate?.name ?? d.code}`, ...(target ? { target } : {}) };
  }
  const name = `${check}:${krate?.name ?? span ?? d.code}`;
  if (d.code !== 'banned') return { rule: d.code, name };
  const reason = d.labels?.find((l) => l.message === 'reason')?.span ?? '';
  return { rule: ROW_ID.exec(reason)?.[1] ?? 'banned', name };
}

/** The sites of a finished report run with exit `status`, failing closed on a report that does not add up. */
export function reportSites(report, status) {
  if (!report.summary) fail('tool-failed', `exit ${status} with no summary (truncated output, or the run stopped early)${report.logErrors.length ? `: ${lastLine(report.logErrors[0])}` : ''}`);
  if (report.logErrors.length) fail('tool-failed', lastLine(report.logErrors[0]));
  const errors = report.diagnostics.filter((d) => d.severity === 'error');
  const counted = Object.values(report.summary).reduce((n, c) => n + (Number.isInteger(c?.errors) ? c.errors : 0), 0);
  if (counted !== errors.length) fail('tool-failed', `the summary counts ${counted} error(s) and the report lists ${errors.length} (truncated output?)`);
  if (status === 0 && errors.length) fail('reporter-exit', `exit 0 with ${errors.length} error(s)`);
  if (status !== 0 && !errors.length) fail('tool-failed', `exit ${status} with no error reported`);
  return errors.map(siteOf);
}

export function collect({ root, paths, exec }) {
  const dir = workspaceDir(paths);
  const configFile = configFor(root, dir);
  const config = readToml(path.join(root, configFile));
  const run = (offline) => {
    const args = [...(offline ? ['--offline'] : []), '--format', 'json', '--manifest-path', path.posix.join(dir, 'Cargo.toml'),
      '--config', configFile, 'check', '-D', 'advisory-not-detected', ...(dir ? ['bans'] : [])];
    const { status, stdout, stderr } = exec('sh', ['-c', RUN, 'sh', ...args], { cwd: root });
    const report = readReport(versionChecked(stdout, stderr));
    // An offline run fetches nothing, so a fetch line is no failure of it (and one recorded output can stand for each
    // call of a replayed case).
    if (offline) report.logErrors = report.logErrors.filter((m) => !fetchFailure({ logErrors: [m] }));
    return { status, report };
  };
  let result = run(Boolean(dir));
  if (!dir && fetchFailure(result.report)) {
    result = run(false);
    const failure = fetchFailure(result.report);
    if (failure) {
      const cache = dbDir(config, root);
      if (!hasCachedDb(cache)) fail('tool-failed', `the advisory database is unreachable and none is cached in ${cache}: ${lastLine(failure)}`);
      console.warn(`cargo-deny: the advisory database is unreachable (${lastLine(failure)}); checking against the cached copy in ${cache}`);
      result = run(true);
    }
  }
  return [...reportSites(result.report, result.status), ...consistencySites(config, activeRows(root))];
}
