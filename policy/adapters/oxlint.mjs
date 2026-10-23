// policy/adapters/oxlint.mjs: oxlint's JSON as per-file sites (contracts §12; 2.1-M58, 2.1-M187, 2.1-M188).
//
// Runs desktop/web's oxlint with the real config (desktop/web/.oxlintrc.json, F1b's) and an unused disable directive
// reported as an error, over the paths it is given, and normalises each diagnostic to a site { rule, path, line }:
// `eslint(no-console)` -> `no-console` and `<plugin>(<rule>)` -> `<plugin>/<rule>`, the names the config and a
// directive use; an unused directive, which carries no code, is `unused-disable-directive`. Every severity counts: a
// family holds what the tool reports, never a second rule home. Recorded output: policy/fixtures/recorded/oxlint/.
import path from 'node:path';

const CWD = 'desktop/web';
const BIN = 'node_modules/.bin/oxlint';
const CONFIG = '.oxlintrc.json';

const fail = (code, message) => { throw Object.assign(new Error(`oxlint: ${message}`), { code }); };

/** oxlint's diagnostic code as the rule id its config and directives name. */
export function ruleId(code) {
  const match = /^([a-z0-9@/_-]+)\(([^()]+)\)$/.exec(code);
  if (!match) return code;
  return match[1] === 'eslint' ? match[2] : `${match[1]}/${match[2]}`;
}

/** Sites from oxlint's `-f json` stdout, run in `cwd` (repository-relative) with exit `status`. */
export function parse(stdout, { cwd = CWD, status = 0, stderr = '' } = {}) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('tool-failed', `no JSON report (exit ${status}): ${(stderr || stdout).trim().split('\n')[0] ?? ''}`);
  }
  if (!report || !Array.isArray(report.diagnostics)) fail('tool-failed', 'the report has no diagnostics array');
  const sites = report.diagnostics.map((d) => {
    if (typeof d.filename !== 'string') fail('tool-failed', `a diagnostic names no file: ${d.message}`);
    const rule = typeof d.code === 'string' ? ruleId(d.code)
      : /disable directive/i.test(d.message ?? '') ? 'unused-disable-directive' : 'diagnostic';
    return { rule, path: path.posix.normalize(`${cwd}/${d.filename}`), line: d.labels?.[0]?.span?.line, severity: d.severity };
  });
  const errors = sites.filter((s) => s.severity === 'error').length;
  if (status === 0 && errors > 0) fail('reporter-exit', `exit 0 with ${errors} error(s)`);
  if (status !== 0 && errors === 0) fail('tool-failed', `exit ${status} with no error reported`);
  return sites.map(({ severity, ...site }) => site);
}

export function collect({ root, paths, exec }) {
  if (paths.length === 0) return [];
  const cwd = path.join(root, CWD);
  const args = ['-c', CONFIG, '-f', 'json', '--report-unused-disable-directives-severity=error',
    ...paths.map((p) => path.relative(cwd, path.join(root, p)).split(path.sep).join('/'))];
  const { status, stdout, stderr } = exec(path.join(cwd, BIN), args, { cwd });
  return parse(stdout, { cwd: CWD, status, stderr });
}
