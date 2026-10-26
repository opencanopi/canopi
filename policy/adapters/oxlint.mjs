// policy/adapters/oxlint.mjs: oxlint's JSON as per-file sites (contracts §12; 2.1-M58, 2.1-M187, 2.1-M188).
//
// Runs desktop/web's oxlint with the real config (desktop/web/.oxlintrc.json, F1b's) and an unused disable directive
// reported as an error, over the paths it is given, and normalises each diagnostic to a site { rule, path, line }:
// `eslint(no-console)` -> `no-console` and `<plugin>(<rule>)` -> `<plugin>/<rule>`, the names the config and a
// directive use; an unused directive, which carries no code, is `unused-disable-directive`. Every severity counts: a
// family holds what the tool reports, never a second rule home. It is given only what it lints, the JavaScript and
// TypeScript files (LINTED) and directories among the paths, and a report that linted fewer files than that (none, or
// an ignored file in a family's scope) is refused as tool-failed, never read as clean. Recorded output:
// policy/fixtures/recorded/oxlint/.
//
// One check per concern (2.1-M218, 2.1-Q243, AF9): a config that enables a rule another check owns (DENIED), turns a
// category on or extends another file (either can enable one unseen) is refused as tool-failed before the run.
import fs from 'node:fs';
import path from 'node:path';

const CWD = 'desktop/web';
const BIN = 'node_modules/.bin/oxlint';
const CONFIG = '.oxlintrc.json';

/** The extensions oxlint lints; any other file is never passed to it. */
const LINTED = /\.(?:[cm]?[jt]sx?|vue|astro|svelte)$/;

const fail = (code, message) => { throw Object.assign(new Error(`oxlint: ${message}`), { code }); };

/** Rules the config must leave off, each with the check that owns its concern (2.1-M218, 2.1-Q243). */
export const DENIED = {
  'import/no-cycle': 'dependency-cruiser',
  'vitest/expect-expect': "Vitest's requireAssertions (F4)",
  'no-console': 'the console-only-in-sink family',
  'max-lines': 'the file-size script (2.1-Q243)',
};

/** A config rule key as DENIED names it: `eslint/no-console` and `no-console` are one rule, as are jest/ and vitest/. */
const deniedKey = (key) => key.replace(/^eslint\//, '').replace(/^jest\//, 'vitest/');

const isOff = (setting) => {
  const level = Array.isArray(setting) ? setting[0] : setting;
  return level === 'off' || level === 0 || level === 'allow';
};

/** Reads desktop/web's config under `root`, refusing one that can enable a denied rule. */
export function readConfig(root) {
  const file = path.join(root, CWD, CONFIG);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('tool-failed', `${CWD}/${CONFIG} is not readable JSON: ${error.message}`);
  }
  if (config.extends !== undefined) fail('tool-failed', `${CWD}/${CONFIG} extends another config, which can enable a denied rule; list the rules here`);
  for (const [category, setting] of Object.entries(config.categories ?? {})) {
    if (!isOff(setting)) fail('tool-failed', `${CWD}/${CONFIG} turns category ${category} on, which can enable a denied rule; list the rules instead`);
  }
  for (const rules of [config.rules, ...(config.overrides ?? []).map((o) => o.rules)]) {
    for (const [key, setting] of Object.entries(rules ?? {})) {
      const owner = DENIED[deniedKey(key)];
      if (owner && !isOff(setting)) fail('tool-failed', `${CWD}/${CONFIG} enables ${key}, which ${owner} checks; one check per concern (2.1-M218)`);
    }
  }
  return config;
}

/** oxlint's diagnostic code as the rule id its config and directives name. */
export function ruleId(code) {
  const match = /^([a-z0-9@/_-]+)\(([^()]+)\)$/.exec(code);
  if (!match) return code;
  return match[1] === 'eslint' ? match[2] : `${match[1]}/${match[2]}`;
}

/**
 * Sites from oxlint's `-f json` stdout, run in `cwd` (repository-relative) with exit `status`, over `atLeast` files at
 * the least (each file given, and one for each directory).
 */
export function parse(stdout, { cwd = CWD, status = 0, stderr = '', atLeast = 1 } = {}) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('tool-failed', `no JSON report (exit ${status}): ${(stderr || stdout).trim().split('\n')[0] ?? ''}`);
  }
  if (!report || !Array.isArray(report.diagnostics)) fail('tool-failed', 'the report has no diagnostics array');
  if (!Number.isInteger(report.number_of_files) || report.number_of_files < Math.max(1, atLeast)) {
    fail('tool-failed', `the report linted ${report.number_of_files ?? 'an unknown number of'} file(s) of the ${atLeast} at least it was given; an ignore pattern or an extension oxlint skips covers them`);
  }
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
  readConfig(root);
  const files = paths.filter((p) => LINTED.test(p));
  const dirs = paths.filter((p) => !LINTED.test(p) && fs.statSync(path.join(root, p), { throwIfNoEntry: false })?.isDirectory());
  const linted = paths.filter((p) => files.includes(p) || dirs.includes(p));
  if (linted.length === 0) return [];
  const cwd = path.join(root, CWD);
  const args = ['-c', CONFIG, '-f', 'json', '--report-unused-disable-directives-severity=error',
    ...linted.map((p) => path.relative(cwd, path.join(root, p)).split(path.sep).join('/'))];
  const { status, stdout, stderr } = exec(path.join(cwd, BIN), args, { cwd });
  return parse(stdout, { cwd: CWD, status, stderr, atLeast: files.length + dirs.length });
}
