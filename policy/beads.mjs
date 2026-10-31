// policy/beads.mjs: the beads the policy cites and the closed-bead refusal (2.1-M197; canopi-f47t.52.228), read from the
// tracker export, never bd. policy/check.mjs re-exports them and runs closedBeadRefusals in every mode; `check.mjs
// --closed-beads` runs only it, the check a change touching only .beads/ gets (closedBeadCheck).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATCHETS_DIR = 'policy/ratchets';
const refusal = (code, where, message) => ({ code, where, message });
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The upstream register, whose rows upstream-register.mjs checks; check.mjs reads it for its planned pins. */
export const UPSTREAM_REGISTER = 'policy/upstream.json';

/** The tracker export CI reads beads from, never bd (2.1-M197). */
export const BEADS_FILE = '.beads/issues.jsonl';
const CLOSED = new Set(['closed', 'tombstone']);

/** Bead id -> status from `root`'s tracker export; none without one (a planted case's repository has no tracker). */
export function beadStatuses(root = REPO_ROOT) {
  const file = path.join(root, BEADS_FILE);
  const statuses = new Map();
  if (!fs.existsSync(file)) return statuses;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(record) && typeof record.id === 'string') statuses.set(record.id, record.status);
  }
  return statuses;
}

/** Each `bead` string under `value` with its JSON pointer below `at`. */
function beadsIn(value, at) {
  if (Array.isArray(value)) return value.flatMap((v, i) => beadsIn(v, `${at}/${i}`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, v]) => (key === 'bead' && typeof v === 'string'
    ? [{ bead: v, at: `${at}/bead` }]
    : beadsIn(v, `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)));
}

/**
 * Each bead the policy cites with its JSON pointer and file: every `bead` in a family file (an entry's or a budget's)
 * and in every policy table (a row's owner_target, an inventory row or suite still planned, an upstream row's planned
 * pin test), so a new table citing beads needs no new reader. A closed upstream row is left out: its pin is history.
 */
export function citedBeads(families, tables) {
  const live = (table, doc) => (table === UPSTREAM_REGISTER && Array.isArray(doc?.workarounds)
    ? { ...doc, workarounds: doc.workarounds.map((row) => (row?.status === 'closed' ? null : row)) }
    : doc);
  return [
    ...[...families.values()].flatMap(({ file, doc }) => beadsIn(doc, '').map((c) => ({ ...c, where: file }))),
    ...(tables.docs ?? []).flatMap(({ table, doc }) => beadsIn(live(table, doc), '').map((c) => ({ ...c, where: table }))),
  ];
}

/**
 * Refuses each bead citedBeads() finds that `statuses` records as closed: the bead is what pays the entry down, brings
 * the owner or writes the pin, so a closed one leaves the debt with no one; re-point it to an open bead with the right
 * phase slot. A bead the export does not hold is not refused here (an export older than the bead); the commit gate
 * refuses one a commit names, and the Phase close test one the export lacks.
 */
export function closedBeadRefusals(families, tables, statuses) {
  return citedBeads(families, tables).filter(({ bead }) => CLOSED.has(statuses.get(bead)))
    .map(({ bead, at, where }) => refusal('closed-bead', where, `${at}: ${bead} is ${statuses.get(bead)} in ${BEADS_FILE}; cite an open bead that will pay this down`));
}

/**
 * `--closed-beads`: closedBeadRefusals over the family files and policy tables as written, read without the schema, the
 * glob engine or any tool, so closing a bead an entry or row cites fails its own commit. A file that is not JSON is
 * refused, never read as citing nothing.
 */
export function closedBeadCheck(root = REPO_ROOT) {
  const refusals = [];
  const json = (dir, keep) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json') && keep(e.name)).map((e) => `${dir}/${e.name}`).sort() : [])
    .map((file) => {
      try {
        return { file, doc: JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) };
      } catch (error) {
        refusals.push(refusal('unreadable', file, error.message));
        return { file, doc: undefined };
      }
    });
  const families = new Map(json(RATCHETS_DIR, (n) => !n.endsWith('.schema.json')).map((f) => [f.file, f]));
  const docs = json('policy', () => true).map(({ file, doc }) => ({ table: file, doc }));
  return [...refusals, ...closedBeadRefusals(families, { docs }, beadStatuses(root))];
}
