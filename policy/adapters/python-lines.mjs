// policy/adapters/python-lines.mjs: every line of Python as a site, so the python-lines count family only shrinks
// (2.1-Q261: tooling converges on Rust and TypeScript and Python leaves gradually; new tooling is never Python).
//
// Over the paths it is given (the family's scope, every *.py the repository lists), each file's newline-terminated
// lines are counted the way file-size counts them (a last line without a newline is not one), one site
// { rule: 'python-lines', path, line } per line. Generated files and data fixtures count too: a Python line is a
// Python line whoever wrote it. A path given that cannot be read is tool-failed, never a file of no lines.
import fs from 'node:fs';
import path from 'node:path';

const PYTHON = /\.py$/u;

export function collect({ root, paths }) {
  const sites = [];
  for (const p of paths) {
    if (!PYTHON.test(p)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, p), 'utf8');
    } catch (error) {
      throw Object.assign(new Error(`python-lines: cannot read ${p}: ${error.code ?? error.message}`), { code: 'tool-failed' });
    }
    let line = 0;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) sites.push({ rule: 'python-lines', path: p, line: ++line });
  }
  return sites;
}
