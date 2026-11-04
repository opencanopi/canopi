// policy/adapters/jscpd.mjs: jscpd's clones as sites, one per clone (contracts §12:526-528; 2.1-Q218, AF20).
//
// Runs desktop/web's pinned jscpd with the repository's config (/.jscpd.json: min-tokens, formats, and the generated
// files and data fixtures it ignores) over the paths it is given, its JSON report written under os.tmpdir() and
// removed after the read, never into the tree. Each clone is one site { rule: 'clone', path, name, line }: `path` the
// clone's first file, relative to the repository, and `name` its two files sorted, `<a> <-> <b>`, so jscpd naming the
// pair in either order gives one key and each clone pair is an entry that can carry its own bead (canopi-f47t.52.257).
//
// Fail-closed: no /.jscpd.json, no installed desktop/web/node_modules/.bin/jscpd (never an npx fetch), an exit other
// than 0, no readable report, a clone naming no first or second file, and a run that analysed no file of a non-empty
// path list (an ignore in the config covering every path given) are each tool-failed, never read as clean.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = '.jscpd.json';
const BIN = 'desktop/web/node_modules/.bin/jscpd';
const REPORT = 'jscpd-report.json';

const fail = (message) => { throw Object.assign(new Error(`jscpd: ${message}`), { code: 'tool-failed' }); };

/** Sites from a jscpd JSON report's text, its file names absolute or relative to `root`, over `given` paths. */
export function parse(text, { root, given }) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    fail('no readable JSON report');
  }
  if (!Array.isArray(report?.duplicates)) fail('the report has no duplicates array');
  const sources = report.statistics?.total?.sources;
  if (given > 0 && !(Number.isInteger(sources) && sources > 0)) {
    fail(`analysed no file of the ${given} given; an ignore in ${CONFIG} or a format it leaves out covers them`);
  }
  const relative = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  return report.duplicates.map((clone) => {
    const [first, second] = [clone?.firstFile?.name, clone?.secondFile?.name];
    if (typeof first !== 'string') fail('a clone names no first file');
    if (typeof second !== 'string') fail('a clone names no second file');
    const pair = [relative(first), relative(second)].sort();
    return { rule: 'clone', path: relative(first), name: pair.join(' <-> '), line: clone.firstFile.start };
  });
}

export function collect({ root, paths, exec, tools = root }) {
  if (paths.length === 0) return [];
  if (!fs.existsSync(path.join(root, CONFIG))) fail(`no ${CONFIG} at the repository root`);
  const bin = path.join(tools, BIN);
  if (!fs.existsSync(bin)) fail(`no ${BIN} (run npm ci in desktop/web; never an npx fetch)`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-jscpd-'));
  try {
    const { status, stderr } = exec(bin, ['--config', CONFIG, '--reporters', 'json', '--output', out, '--absolute', '--silent', '--no-tips', ...paths], { cwd: root });
    if (status !== 0) fail(`exit ${status}: ${String(stderr).trim().split('\n')[0] ?? ''}`);
    const report = path.join(out, REPORT);
    if (!fs.existsSync(report)) fail(`wrote no ${REPORT}`);
    return parse(fs.readFileSync(report, 'utf8'), { root, given: paths.length });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
