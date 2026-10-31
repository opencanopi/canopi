// policy/adapters/guarded-files.mjs: each guarded data file as a site (contracts §12; 2.1-Q225, 2.1-M199).
//
// The guarded-files family lists the user-reviewed data files a commit changes only with a merge-base Q row. This
// adapter is the family's static half: one site per path it is given that exists, so a guarded file deleted or renamed
// leaves its entry stale and a file the family does not list is unlisted. The change half, which commits may touch a
// listed file, is scripts/commit_gate.py's (gate-guarded-file); a planned guarded file joins with the commit that
// creates it.
import fs from 'node:fs';
import path from 'node:path';

export async function collect({ root, paths }) {
  return paths.filter((p) => fs.statSync(path.join(root, p), { throwIfNoEntry: false })?.isFile())
    .map((p) => ({ rule: 'guarded-files', path: p }));
}
