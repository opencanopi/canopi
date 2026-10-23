// policy/adapters/tsc.mjs: the tsc-strict family's errors per file (contracts §12; 2.1-M188, A1).
//
// TypeScript's stricter flags are a `tsc-strict` family read from a second tsconfig, desktop/web/tsconfig.strict.json
// (F4's: the main config plus exactOptionalPropertyTypes), checked by TypeScript 7 as `npm run typecheck` runs it, never
// `npx tsc`. Each `<file>(<line>,<col>): error TS<n>: …` line is a site { rule: 'TS<n>', path, line }; the indented
// lines under it continue its message. The project decides the files, so `paths` only gates the run; the checker keeps
// the sites in the family's scope. An error naming no file (a missing or broken tsconfig) or any other line fails the
// run. Recorded output: policy/fixtures/recorded/tsc/.
import path from 'node:path';

const CWD = 'desktop/web';
const TSC = 'node_modules/typescript7/bin/tsc';
const CONFIG = 'tsconfig.strict.json';
const DIAGNOSTIC = /^(.+)\((\d+),\d+\): (error|warning) (TS\d+): /;

const fail = (code, message) => { throw Object.assign(new Error(`tsc: ${message}`), { code }); };

/** Sites from `tsc --pretty false` output, run in `cwd` (repository-relative) with exit `status`. */
export function parse(stdout, { cwd = CWD, status = 0 } = {}) {
  const sites = [];
  for (const line of stdout.split('\n')) {
    if (line === '' || /^\s/.test(line)) continue;
    const match = DIAGNOSTIC.exec(line);
    if (!match) fail('tool-failed', `unread output: ${line}`);
    sites.push({ rule: match[4], path: path.posix.normalize(`${cwd}/${match[1]}`), line: Number(match[2]) });
  }
  if (status === 0 && sites.length) fail('reporter-exit', `exit 0 with ${sites.length} error(s)`);
  if (status !== 0 && !sites.length) fail('tool-failed', `exit ${status} with no diagnostic`);
  return sites;
}

export function collect({ root, paths, exec }) {
  if (paths.length === 0) return [];
  const cwd = path.join(root, CWD);
  const { status, stdout } = exec('node', [TSC, '--noEmit', '--pretty', 'false', '-p', CONFIG], { cwd });
  return parse(stdout, { cwd: CWD, status });
}
