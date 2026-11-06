// policy/adapters/ratchet-entry-has-bead.mjs: each ratchet entry that no open bead pays down and that is not standing,
// the stopping rule's input (ADR 0028 Stopping rule; 2.1-M78; canopi-f47t.52.257).
//
// Over the family files it is given (policy/ratchets/*.json, the schema left out), a family with a family-level `bead` or
// `standing: true` gives no site; otherwise each entry without its own `bead` is one site { rule, path, name }, `name`
// the family, so the ratchet-entry-has-bead family counts a family's beadless entries and only shrinks: a new entry, or
// a new family, with no bead fails. A count family above 0 is one site (its total is one entry). Budgets and floors are
// standing by kind and give none (2.1-M78). The closed-bead and absent-bead refusals hold every bead open and real.
//
// Fail-closed: a family file that is not JSON is tool-failed, never a family with no entries; a family naming both a
// bead and standing is a refused site: it says two things about the same entries.
import fs from 'node:fs';
import path from 'node:path';

const RULE = 'ratchet-entry-has-bead';
const SCHEMA = /(?:^|\/)ratchet\.schema\.json$/u;
const fail = (message) => { throw Object.assign(new Error(`${RULE}: ${message}`), { code: 'tool-failed' }); };

export function collect({ root, paths }) {
  const sites = [];
  for (const p of paths) {
    if (!p.endsWith('.json') || SCHEMA.test(p)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
    } catch (error) {
      fail(`cannot read ${p} as JSON: ${error.message}`);
    }
    const name = typeof doc?.family === 'string' ? doc.family : path.basename(p, '.json');
    if (doc?.bead !== undefined && doc?.standing !== undefined) {
      sites.push({ rule: RULE, path: p, name, refused: 'a family names a bead or says standing, not both' });
      continue;
    }
    if (doc?.bead !== undefined || doc?.standing === true) continue;
    if (doc?.entries && typeof doc.entries === 'object') {
      for (const entry of Object.values(doc.entries)) if (!entry?.bead) sites.push({ rule: RULE, path: p, name });
    } else if (Number.isInteger(doc?.count) && doc.count > 0) {
      sites.push({ rule: RULE, path: p, name });
    }
  }
  return sites;
}
