// policy/core/test-repo.mjs: the written git work tree the policy's node:test files check against (beads.test.mjs,
// phase-markers.test.mjs); removed after the test file runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const roots = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A git work tree holding `files` ({path: text}), every file staged, outside the caller's GIT_* environment. */
export function writtenRepo(files, prefix = 'policy-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  return root;
}
