// policy/beads.mjs: the beads the policy cites, with the closed-bead and absent-bead refusals (2.1-M197; canopi-f47t.52.228,
// canopi-f47t.52.228.54), read from the tracker export, never bd. policy/check.mjs runs both in every mode; `check.mjs
// --closed-beads` runs only them, the check a change touching only .beads/ gets (closedBeadCheck).
import fs from 'node:fs';
import path from 'node:path';
import { workspaceMemberDirs } from './adapters/cargo-manifest.mjs';
import { isObject, RATCHETS_DIR, refusal, REPO_ROOT } from './core/base.mjs';
import { listFiles } from './core/exec.mjs';

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
 * A bead id in running text: `canopi-` and a hash of 3 or 4 base36 characters (bd's ids at this tracker's size), with
 * its child numbers. A crate is named by a word (canopi-format, canopi-support), so a longer name is never read as a
 * bead, nor is a file name (canopi-core.db); the workspace's own crate names are left out by name too (workspaceCrates).
 */
const BEAD_IN_TEXT = /(?<![\p{L}\p{N}_-])canopi-[a-z0-9]{3,4}(?:\.[0-9]+)*(?![\p{L}\p{N}_-]|\.\p{L})/gu;
/** A decision ledger: each table row's cells are read (docs/decisions/<release>.md). */
const LEDGER = /^docs\/decisions\/[^/]+\.md$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
/** A TS or JS test's title: the first string argument of `it`, `test` or `describe`, with `.skip`, `.each(rows)` and the like. */
const TITLE = /(?<![\p{L}\p{N}_$.])(?:it|test|describe)(?:\.[A-Za-z]+)*(?:\([^()]*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gu;

/** The package names of the workspace's crates, from the root Cargo.toml's members; none without a root manifest. */
function workspaceCrates(root) {
  if (!fs.existsSync(path.join(root, 'Cargo.toml'))) return new Set();
  return new Set(workspaceMemberDirs(root).map((dir) => {
    const text = fs.readFileSync(path.join(root, dir, 'Cargo.toml'), 'utf8');
    return /^\s*name\s*=\s*"([^"]+)"/mu.exec(text)?.[1];
  }).filter(Boolean));
}

/**
 * Refuses each bead the policy cites that the tracker export (`exported`, trackerExport()) does not hold: a `bead` in a
 * family file or policy table (citedBeads), a bead in a decision ledger's table cell and one in a TS or JS test title,
 * so a typo or an export older than the citation cannot leave the closed-bead check reading no status. Skipped with no
 * export, since nothing can then be read as absent (a planted case's repository).
 */
export function absentBeadRefusals(root, families, tables, exported) {
  if (!exported.present) return [];
  const refusals = [];
  let crates;
  try {
    crates = workspaceCrates(root);
  } catch (error) {
    return [refusal(error.code ?? 'tool-failed', 'Cargo.toml', error.message)];
  }
  const absent = (bead) => !exported.statuses.has(bead) && !crates.has(bead);
  const say = (where, at, bead) => refusal('absent-bead', where, `${at}: ${bead} is not in ${BEADS_FILE}; cite a bead the tracker holds (bd export after bd create)`);
  for (const { bead, at, where } of citedBeads(families, tables)) if (absent(bead)) refusals.push(say(where, at, bead));
  for (const file of listFiles(root)) {
    const ledger = LEDGER.test(file);
    if (!ledger && !TEST_FILE.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (ledger) {
      text.split('\n').forEach((line, i) => {
        if (!line.trimStart().startsWith('|')) return;
        for (const [bead] of line.matchAll(BEAD_IN_TEXT)) if (absent(bead)) refusals.push(say(file, `line ${i + 1}`, bead));
      });
      continue;
    }
    for (const match of text.matchAll(TITLE)) {
      for (const [bead] of match[2].matchAll(BEAD_IN_TEXT)) {
        if (absent(bead)) refusals.push(say(file, `line ${text.slice(0, match.index).split('\n').length} title`, bead));
      }
    }
  }
  return refusals;
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
    ...absentBeadRefusals(root, families, tables, exported)];
}
