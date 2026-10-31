// policy/adapters/ast-grep.mjs: ast-grep's findings as sites (contracts §12, §18; 2.1-M226).
//
// Runs `ast-grep scan --config sgconfig.yml --json=stream <paths>` from the repository root (sgconfig.yml is
// policy/generate.mjs's output; its ruleDirs hold one file per rule). Each finding is a site { rule, path }: `rule` the
// finding's rule id, a rule written once per ast-grep language (`<rule-id>.<language>`, its file
// `<rule-id>.<language>.yml`, generate.mjs's rule-file check) reporting as `<rule-id>`, so its halves count as one
// rule; a further document of that file (`<rule-id>.<language>.<part>`, its own files and ignores, since ast-grep
// scopes a rule by path only per document) reports as `<rule-id>` too; `path` the file, relative to the repository.
// ast-grep's `unused-suppression` hint (an `ast-grep-ignore` that silenced nothing: one naming only `<rule-id>` where
// ast-grep honours the tool id `<rule-id>.<language>`, or one whose finding is gone) is a site refused under each rule
// it names, so the family of that rule fails it as a stale directive (2.1-M257).
//
// ast-grep exits 0 when it has no rule at all and prints nothing, so a clean run proves nothing by itself: the run
// fails closed on no sgconfig.yml, a ruleDirs entry that holds no rule file, any output line that is not one JSON
// finding, an exit status other than 0 or 1, an exit 0 with an error-severity finding (or an exit 1 without one), and
// no installed desktop/web/node_modules/.bin/ast-grep (never an npx fetch).
// Recorded output: policy/fixtures/recorded/ast-grep/.
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = 'sgconfig.yml';
const BIN = 'desktop/web/node_modules/.bin/ast-grep';

const fail = (code, message) => { throw Object.assign(new Error(`ast-grep: ${message}`), { code }); };

/** The ruleDirs entries of an sgconfig.yml text (a block list under `ruleDirs:`). */
export function ruleDirs(text) {
  const at = text.split('\n');
  const start = at.findIndex((line) => /^ruleDirs:\s*$/u.test(line));
  if (start === -1) return [];
  const dirs = [];
  for (const line of at.slice(start + 1)) {
    const item = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/u.exec(line);
    if (!item) break;
    dirs.push(item[1]);
  }
  return dirs;
}

/** The rule files (.yml, .yaml) under the config's ruleDirs. */
function ruleFiles(root, dirs) {
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [])
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.ya?ml$/u.test(e.name) ? [path.join(dir, e.name)] : []));
  return dirs.flatMap((d) => walk(path.join(root, d)));
}

const UNUSED = 'unused-suppression';

/** The tool ids an `ast-grep-ignore` directive's text names: after an optional colon, comma-separated. */
const ignoredIds = (text) => (/ast-grep-ignore\s*:?([^\n]*)/u.exec(text)?.[1] ?? '')
  .replace(/\*\/.*$|-->.*$/u, '').split(',').map((id) => id.trim()).filter(Boolean);

/** The sites of `--json=stream` output, checked against ast-grep's exit status. */
export function parse(stdout, { status = 0, stderr = '' } = {}) {
  if (status !== 0 && status !== 1) fail('tool-failed', `exit ${status}: ${stderr.trim().split('\n')[0] ?? ''}`);
  const findings = stdout.split('\n').filter((line) => line.trim()).map((line) => {
    let finding;
    try {
      finding = JSON.parse(line);
    } catch {
      fail('tool-failed', `a line that is no JSON finding: ${line.slice(0, 120)}`);
    }
    if (typeof finding?.ruleId !== 'string' || typeof finding?.file !== 'string') fail('tool-failed', `a finding without ruleId and file: ${line.slice(0, 120)}`);
    return finding;
  });
  const errors = findings.filter((f) => f.severity === 'error').length;
  if (status === 0 && errors) fail('reporter-exit', `exit 0 with ${errors} error finding(s)`);
  if (status === 1 && !errors) fail('tool-failed', `exit 1 without an error finding: ${stderr.trim().split('\n')[0] ?? ''}`);
  return findings.flatMap((f) => {
    const file = path.posix.normalize(f.file.split(path.sep).join('/'));
    if (f.ruleId === UNUSED) {
      const line = (f.range?.start?.line ?? 0) + 1;
      return ignoredIds(f.text ?? f.lines ?? '').map((id) => ({ rule: id.split('.')[0], path: file, line,
        refused: `an ast-grep-ignore naming ${id} silences nothing (ast-grep honours only the tool id <rule-id>.<language>); name the tool id, or delete a directive whose finding is gone` }));
    }
    // `<rule-id>.<language>` and its further documents `<rule-id>.<language>.<part>` all report as `<rule-id>`.
    return [{ rule: f.ruleId.split('.')[0], path: file }];
  });
}

export function collect({ root, paths, exec, tools = root }) {
  if (paths.length === 0) return [];
  const config = path.join(root, CONFIG);
  if (!fs.existsSync(config)) fail('tool-failed', `no ${CONFIG} at the repository root (node policy/generate.mjs writes it)`);
  const dirs = ruleDirs(fs.readFileSync(config, 'utf8'));
  if (!dirs.length) fail('tool-failed', `${CONFIG} names no ruleDirs`);
  if (!ruleFiles(root, dirs).length) fail('tool-failed', `no rule file under ${dirs.join(', ')}: a scan would pass with no rule`);
  const bin = path.join(tools, BIN);
  if (!fs.existsSync(bin)) fail('tool-failed', `no ${BIN} (run npm ci in desktop/web; never an npx fetch)`);
  const { status, stdout, stderr } = exec(bin, ['scan', '--config', CONFIG, '--json=stream', ...paths], { cwd: root });
  return parse(stdout, { status, stderr });
}
