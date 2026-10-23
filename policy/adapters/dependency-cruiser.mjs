// policy/adapters/dependency-cruiser.mjs: dependency-cruiser's violations as sites (contracts §12; 2.1-M58, 2.1-M186).
//
// Runs desktop/web's depcruise with the real config (desktop/web/.dependency-cruiser.cjs, F1a's) over the paths it is
// given, and normalises each violation to a site { rule, path, name }: `rule` the config's rule name, `path` the
// repository file the edge leaves, `name` `<from> -> <to>` in the layer table's module coordinates (relative to
// desktop/web/src), so a named family's entry moves with the layer table. Its `--output-type baseline` list (the
// known-violations file) reads the same way, and a violation `--ignore-known` reports at severity `ignore` is still
// a site: the ratchet family is the only baseline, never a second rule home.
//
// depcruise exits 0 whatever it finds with `--output-type json`, so the report vouches for itself instead: an
// environment issue (a missing TypeScript compiler cruises almost nothing), nothing cruised, or an error count that
// disagrees with the error violations fails the run. Recorded output: policy/fixtures/recorded/dependency-cruiser/.
import path from 'node:path';

const CWD = 'desktop/web';
const BIN = 'node_modules/.bin/depcruise';
const CONFIG = '.dependency-cruiser.cjs';
const MODULE_ROOT = 'src/';

const fail = (code, message) => { throw Object.assign(new Error(`dependency-cruiser: ${message}`), { code }); };

/** A depcruise module path (relative to desktop/web) in the layer table's coordinates. */
const modulePath = (p) => (p.startsWith(MODULE_ROOT) ? p.slice(MODULE_ROOT.length) : p);

/** Sites from depcruise's JSON report, or from its baseline list, run in `cwd` (repository-relative). */
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
  return violations.map((v) => {
    if (typeof v?.from !== 'string' || typeof v?.to !== 'string' || typeof v?.rule?.name !== 'string') {
      fail('tool-failed', `a violation without from, to and rule: ${JSON.stringify(v)}`);
    }
    return { rule: v.rule.name, path: path.posix.normalize(`${cwd}/${v.from}`), name: `${modulePath(v.from)} -> ${modulePath(v.to)}` };
  });
}

export function collect({ root, paths, exec }) {
  if (paths.length === 0) return [];
  const cwd = path.join(root, CWD);
  const args = ['--config', CONFIG, '--output-type', 'json',
    ...paths.map((p) => path.relative(cwd, path.join(root, p)).split(path.sep).join('/'))];
  const { status, stdout } = exec(path.join(cwd, BIN), args, { cwd });
  return parse(stdout, { cwd: CWD, status });
}
