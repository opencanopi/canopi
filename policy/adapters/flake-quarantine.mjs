// policy/adapters/flake-quarantine.mjs: each quarantined flaky test as a site (ADR 0028 Flakes; 2.1-M203, 2.1-Q242).
//
// A flaky test is skipped with a `flake-quarantine: <bead>` marker beside its skip, and the family lists its file with
// that bead, the bead's record naming the owner (assignee, else owner). One site per marker, keyed by its file; a marker
// naming no bead is refused whatever the baseline. The family lands empty and is empty at each phase close
// (`phase_close: empty` on its rules.json row). Which commits may add an entry is scripts/commit_gate.py's: an open bead
// with an owner, no Q row; the deletion guard passes the skip only with that entry.
import fs from 'node:fs';
import path from 'node:path';

const MARKER = /flake-quarantine:[ \t]*(canopi-[a-z0-9]+(?:\.[0-9]+)*)?/g;

export async function collect({ root, paths }) {
  const sites = [];
  for (const p of paths) {
    const text = fs.readFileSync(path.join(root, p), 'utf8');
    if (!text.includes('flake-quarantine:')) continue;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(MARKER)) {
        sites.push({ rule: 'flake-quarantine', path: p, line: i + 1, ...(m[1] ? { bead: m[1] } : { refused: 'a flake-quarantine marker names no bead' }) });
      }
    });
  }
  return sites;
}
