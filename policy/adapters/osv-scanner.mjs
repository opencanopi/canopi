// policy/adapters/osv-scanner.mjs: OSV advisories per lockfile, the one normaliser of osv-scanner output (contracts
// §12; 2.1-M57, 2.1-M204; ADR 0028 Updates, Advisories).
//
// osv-scanner runs over the lockfiles in `paths` with no ignore list (`--config /dev/null`), so the exception table
// policy/advisories.json, which generates osv-scanner.toml for direct runs, is checked against what is really
// reported: scripts/advisories.py reads this adapter's sites through the CLI below and fails an unlisted, expired or
// stale entry. `--all-packages` makes the JSON name every lockfile read, clean ones included.
// Each advisory group (the ids osv-scanner merges as aliases) on one package in one lockfile is one site
// { rule: <id>, path: <lockfile>, name: '<package>@<version>', aliases: [...] }, its id the group's RUSTSEC id, else
// its GHSA id, else its first id. Refused: output that is not JSON, an exit other than 0 or 1, and a run whose JSON
// leaves out a lockfile asked for (no cached database offline reads none) are `tool-failed`; exit 0 with advisories,
// or exit 1 with none, is `reporter-exit` or `tool-failed`. Recorded output: policy/fixtures/recorded/osv-scanner/.
//
// Modes: online (`--offline-vulnerabilities --download-offline-databases`: the database is fetched into
// OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY, which CI caches, then matched locally) or `offline` (the cached database
// only). The binary is OSV_SCANNER, else `osv-scanner` on PATH.
//
//   node policy/adapters/osv-scanner.mjs [--offline] [--root <dir>] <lockfile>...
//       prints {"sites": [...]} and exits 0, or {"refusal": <code>, "message": ...} and exits 2
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCKFILES = ['Cargo.lock', 'desktop/web/package-lock.json', 'desktop/web/e2e/platform/phones/ios/appium/package-lock.json'];

const fail = (code, message) => { throw Object.assign(new Error(`osv-scanner: ${message}`), { code }); };

/** The id a group is known by: RUSTSEC first (cargo-deny's and RustSec's name), then GHSA, then the first. */
export function canonicalId(ids) {
  return ids.find((id) => id.startsWith('RUSTSEC-')) ?? ids.find((id) => id.startsWith('GHSA-')) ?? ids[0];
}

/** Sites from osv-scanner JSON for the repository-relative `lockfiles`, run with exit `status`. */
export function parse(stdout, { lockfiles, status = 0, stderr = '' }) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('tool-failed', `exit ${status}, output is not JSON${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`);
  }
  if (status !== 0 && status !== 1) {
    fail('tool-failed', `exit ${status}${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`);
  }
  const results = Array.isArray(report?.results) ? report.results : fail('tool-failed', 'JSON without results');
  const sites = [];
  const read = new Set();
  for (const result of results) {
    const source = String(result?.source?.path ?? '').replaceAll('\\', '/');
    const lockfile = lockfiles.find((l) => source === l || source.endsWith(`/${l}`));
    if (!lockfile) fail('tool-failed', `a result for ${source || 'no path'}, which was not asked for`);
    read.add(lockfile);
    for (const entry of result.packages ?? []) {
      const name = `${entry.package?.name}@${entry.package?.version}`;
      for (const group of entry.groups ?? []) {
        const ids = [...(group.ids ?? [])].sort();
        if (!ids.length) fail('tool-failed', `${name}: an advisory group with no id`);
        const aliases = [...new Set([...ids, ...(group.aliases ?? [])])].sort();
        sites.push({ rule: canonicalId(ids), path: lockfile, name, aliases });
      }
    }
  }
  const unread = lockfiles.filter((l) => !read.has(l));
  if (unread.length) {
    fail('tool-failed', `read no ${unread.join(', ')}${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`);
  }
  if (status === 0 && sites.length) fail('reporter-exit', `exit 0 with ${sites.length} advisory site(s)`);
  if (status === 1 && !sites.length) fail('tool-failed', 'exit 1 with no advisory');
  return sites;
}

/** The arguments of one scan of `lockfiles`. */
export function scanArgs(lockfiles, { offline = false } = {}) {
  return ['scan', 'source', '--format', 'json', '--all-packages', '--config', '/dev/null',
    ...(offline ? ['--offline'] : ['--offline-vulnerabilities', '--download-offline-databases']),
    ...lockfiles.flatMap((l) => ['-L', l])];
}

export function collect({ root, paths, exec, offline = false }) {
  const lockfiles = paths.filter((p) => LOCKFILES.includes(p));
  if (lockfiles.length === 0) return [];
  const command = process.env.OSV_SCANNER || 'osv-scanner';
  const { status, stdout, stderr } = exec(command, scanArgs(lockfiles, { offline }), { cwd: root });
  return parse(stdout, { lockfiles, status, stderr });
}

async function main(argv) {
  const { exec } = await import('../check.mjs');
  const offline = argv.includes('--offline');
  const at = argv.indexOf('--root');
  const root = at === -1 ? process.cwd() : path.resolve(argv[at + 1]);
  const paths = argv.filter((a, i) => a !== '--offline' && a !== '--root' && argv[i - 1] !== '--root');
  try {
    process.stdout.write(`${JSON.stringify({ sites: collect({ root, paths, exec, offline }) })}\n`);
    return 0;
  } catch (error) {
    if (error?.code !== 'tool-failed' && error?.code !== 'reporter-exit') throw error;
    process.stdout.write(`${JSON.stringify({ refusal: error.code, message: error.message })}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
