// policy/beads.mjs: the beads the policy cites, with the closed-bead and absent-bead refusals (2.1-M197; canopi-f47t.52.228,
// canopi-f47t.52.228.54), read from the tracker export, never bd. policy/check.mjs runs both in every mode; `check.mjs
// --closed-beads` runs only them, the check a change touching only .beads/ gets (closedBeadCheck).
import fs from 'node:fs';
import path from 'node:path';
import { isObject, RATCHETS_DIR, refusal, REPO_ROOT } from './core/base.mjs';

/** The upstream register, whose rows upstream-register.mjs checks; check.mjs reads it for its planned pins. */
export const UPSTREAM_REGISTER = 'policy/upstream.json';

/** The tracker export CI reads beads from, never bd (2.1-M197). */
export const BEADS_FILE = '.beads/issues.jsonl';
const CLOSED = new Set(['closed', 'tombstone']);

/**
 * `root`'s tracker export: { present, statuses (bead id -> status), refusals }. With no export (a planted case's
 * repository has no tracker) it is absent and holds no status. A line that is not a JSON record with a string id is an
 * `unreadable` refusal naming the line, never skipped: a lost line would read its bead as absent, or a closed one as
 * open. Blank lines are no records.
 */
export function trackerExport(root = REPO_ROOT) {
  const file = path.join(root, BEADS_FILE);
  const statuses = new Map();
  const refusals = [];
  if (!fs.existsSync(file)) return { present: false, statuses, refusals };
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      refusals.push(refusal('unreadable', `${BEADS_FILE}:${i + 1}`, `not a JSON record (${error.message}); repair the export (bd export) before the policy reads it`));
      return;
    }
    if (isObject(record) && typeof record.id === 'string') statuses.set(record.id, record.status);
    else refusals.push(refusal('unreadable', `${BEADS_FILE}:${i + 1}`, 'a record with no string id'));
  });
  return { present: true, statuses, refusals };
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
 * phase slot. A cited bead the export does not hold is absentBeadRefusals()'s.
 */
export function closedBeadRefusals(families, tables, statuses) {
  return citedBeads(families, tables).filter(({ bead }) => CLOSED.has(statuses.get(bead)))
    .map(({ bead, at, where }) => refusal('closed-bead', where, `${at}: ${bead} is ${statuses.get(bead)} in ${BEADS_FILE}; cite an open bead that will pay this down`));
}

/**
 * A bead id in running text: `canopi-` and a base36 hash of any length (bd grows it with the tracker), with its child
 * numbers; the commit gate's BEAD reads the same ids. A file name (canopi-core.db) is none. A crate or another name
 * spelt like one (canopi-format, `canopi-sw`) is written in a code span, which textBeads leaves out; outside one it
 * reads as a citation, so the gate refuses it on the commit writing it rather than miss a longer hash.
 */
const BEAD_IN_TEXT = /(?<![\p{L}\p{N}_-])canopi-[a-z0-9]+(?:\.[0-9]+)*(?![\p{L}\p{N}_-]|\.\p{L})/gu;
/** A decision ledger: each table row's cells are read (docs/decisions/<release>.md). */
const LEDGER = /^docs\/decisions\/[^/]+\.md$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** A TS or JS test's title: the first string argument of `it`, `test` or `describe`, with `.skip`, `.each(rows)` and the like. */
const TITLE = /(?<![\p{L}\p{N}_$.])(?:it|test|describe)(?:\.[A-Za-z]+)*(?:\([^()]*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gu;
/** A code span, in a ledger cell or a test title: a crate, a store or a path, never a citation. */
const CODE_SPAN = /`[^`\n]*`/gu;

/** Whether `file` is one whose text textBeads reads: a decision ledger or a TS or JS test. */
export const citesInText = (file) => LEDGER.test(file) || TEST_FILE.test(file);

/**
 * The beads `text` (the file `file`) cites as decisions or tests, each with where: a decision ledger's table cells
 * (`line N`), code spans aside, and a TS or JS test's titles (`line N title`); none in any other file. The commit gate
 * refuses one a commit newly cites that no export holds (policy/gate/commit-gate-judge.ts judgeCitations): a typo or an
 * export older than the citation is caught where it is written, and cited history is never re-read, so bd pruning a
 * closed bead leaves it standing.
 */
export function textBeads(file, text) {
  if (!citesInText(file)) return [];
  if (LEDGER.test(file)) {
    return text.split('\n').flatMap((line, i) => (line.trimStart().startsWith('|')
      ? [...line.replace(CODE_SPAN, '').matchAll(BEAD_IN_TEXT)].map(([bead]) => ({ bead, at: `line ${i + 1}` }))
      : []));
  }
  return [...text.matchAll(TITLE)].flatMap((match) => [...match[2].replace(CODE_SPAN, '').matchAll(BEAD_IN_TEXT)]
    .map(([bead]) => ({ bead, at: `line ${text.slice(0, match.index).split('\n').length} title` })));
}

/**
 * Refuses each bead the policy cites (citedBeads: a `bead` in a family file or policy table) that the tracker export
 * (`exported`, trackerExport()) does not hold, so a typo or an export older than the citation cannot leave the
 * closed-bead check reading no status. Skipped with no export, since nothing can then be read as absent (a planted
 * case's repository). A ledger cell or test title is the commit gate's, on the commit that writes it (textBeads).
 */
export function absentBeadRefusals(families, tables, exported) {
  if (!exported.present) return [];
  return citedBeads(families, tables).filter(({ bead }) => !exported.statuses.has(bead))
    .map(({ bead, at, where }) => refusal('absent-bead', where, `${at}: ${bead} is not in ${BEADS_FILE}; cite a bead the tracker holds (bd export after bd create)`));
}

/**
 * `--closed-beads`: closedBeadRefusals and absentBeadRefusals over the family files and policy tables as written, read
 * without the schema, the glob engine or any tool, so closing a bead an entry or row cites, or dropping one from the
 * export, fails its own commit. A file that is not JSON is refused, never read as citing nothing.
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
  const tables = { docs: json('policy', () => true).map(({ file, doc }) => ({ table: file, doc })) };
  const exported = trackerExport(root);
  return [...refusals, ...exported.refusals, ...closedBeadRefusals(families, tables, exported.statuses),
    ...absentBeadRefusals(families, tables, exported)];
}
