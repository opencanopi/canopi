// policy/core/diff.mjs: the base-to-head diff of the family files (2.1-M74, 2.1-M348): each change the gate decides on,
// entries moved by git -M and by the layer table.
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_ROOT, RATCHETS_DIR } from './base.mjs';
import { git } from './exec.mjs';
import { keyPath, layerMovesAt, listedCount, sameSet, shapeOf, withKeyPath } from './ratchets.mjs';

/**
 * Every change a base-to-head diff of the family files can name (`--diff`); the gate (F3b) decides which need a
 * bead and a Q row. `--self-test` fails a change with no planted case.
 */
export const CHANGES = {
  created: 'a family file new at head: its first baseline (2.1-M40)',
  deleted: 'a family file gone at head',
  header: 'a changed version, ledger, tool, scope, lane, key kind or shape; only a key kind or shape hides the entries',
  added: 'an entry new at head that is not a rename',
  raised: 'an entry or count above its base value',
  lowered: 'an entry or count below its base value',
  removed: 'an entry gone at head that was not renamed',
  renamed: 'an entry moved by git -M or the layer table at the same or a lower count (2.1-M74)',
  'floor-globs': 'a floor family\'s include or exclusion patterns changed',
};

/** Old path -> new path for each rename git -M finds between `baseRev` and `headRev` (the working tree when omitted). */
export function gitRenames(root, baseRev, headRev) {
  const parts = git(root, ['diff', '-M', '--name-status', '-z', baseRev, ...(headRev ? [headRev] : [])]).split('\0');
  const renames = new Map();
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i];
    if (status.startsWith('R')) renames.set(parts[i + 1], parts[i + 2]);
    i += status.startsWith('R') || status.startsWith('C') ? 3 : 2;
  }
  return renames;
}

/** Family file stem -> parsed doc, at a revision or (rev omitted) in the working tree. */
function familiesAt(root, rev) {
  const families = new Map();
  const names = rev
    ? git(root, ['ls-tree', '-z', '--name-only', rev, '--', `${RATCHETS_DIR}/`]).split('\0').filter(Boolean).map((f) => path.posix.basename(f))
    : fs.existsSync(path.join(root, RATCHETS_DIR)) ? fs.readdirSync(path.join(root, RATCHETS_DIR)) : [];
  for (const name of names.filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'))) {
    const file = `${RATCHETS_DIR}/${name}`;
    const text = rev ? git(root, ['show', `${rev}:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8');
    families.set(path.basename(name, '.json'), JSON.parse(text));
  }
  return families;
}

const HEADER_FIELDS = ['version', 'family', 'ledger', 'tool', 'scope', 'lane', 'keys', 'select'];

/** `p` moved by `renames`: its exact rename (a file, git -M), else the longest renamed directory holding it. */
function movePath(p, renames) {
  if (renames.has(p)) return renames.get(p);
  let dir;
  for (const from of renames.keys()) if (p.startsWith(`${from}/`) && (dir === undefined || from.length > dir.length)) dir = from;
  return dir === undefined ? p : `${renames.get(dir)}${p.slice(dir.length)}`;
}

/**
 * A key moved in its own coordinates: a path or path-rule key by `moves.path` (repository paths), each module path
 * in a name key (`app/a <-> app/b`) by `moves.name` (module paths under desktop/web/src).
 */
function moveKey(kind, key, moves) {
  if (kind === 'name') return key.split(' ').map((token) => movePath(token, moves.name)).join(' ');
  const p = keyPath(kind, key);
  return p ? withKeyPath(kind, key, movePath(p, moves.path)) : key;
}

/**
 * The changes between two sets of family docs. `moves.path` maps an old repository file or directory to its new
 * path (git -M's renames and the layer table's moves under desktop/web/src); `moves.name` maps old module paths to
 * new (the layer table's moves) (2.1-M74).
 */
export function diffFamilies(base, head, moves) {
  const changes = [];
  for (const stem of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const was = base.get(stem);
    const now = head.get(stem);
    if (!was) { changes.push({ change: 'created', family: stem }); continue; }
    if (!now) { changes.push({ change: 'deleted', family: stem }); continue; }
    const fields = HEADER_FIELDS.filter((f) => JSON.stringify(was[f]) !== JSON.stringify(now[f]));
    if (shapeOf(was) !== shapeOf(now)) fields.push('shape');
    if (fields.length) changes.push({ change: 'header', family: stem, fields });
    // A header change hides nothing: only a new key kind or shape leaves no entries to compare.
    if (fields.includes('keys') || fields.includes('shape')) continue;
    if (shapeOf(now) === 'budgets' || shapeOf(now) === 'floors') {
      changes.push(...diffMeasures(stem, was, now));
      continue;
    }
    if (!('entries' in now)) {
      if (now.count !== was.count) changes.push({ change: now.count > was.count ? 'raised' : 'lowered', family: stem, from: was.count, to: now.count });
      continue;
    }
    const renamedFrom = new Set();
    const movedTo = new Map(Object.keys(was.entries).filter((k) => !(k in now.entries))
      .map((k) => [moveKey(now.keys, k, moves), k]));
    for (const [key, entry] of Object.entries(now.entries)) {
      const to = listedCount(entry);
      if (key in was.entries) {
        const from = listedCount(was.entries[key]);
        if (to !== from) changes.push({ change: to > from ? 'raised' : 'lowered', family: stem, key, from, to });
        continue;
      }
      const oldKey = movedTo.get(key);
      if (oldKey !== undefined && to <= listedCount(was.entries[oldKey])) {
        renamedFrom.add(oldKey);
        changes.push({ change: 'renamed', family: stem, key, from: oldKey, count: to });
      } else {
        changes.push({ change: 'added', family: stem, key, to });
      }
    }
    for (const key of Object.keys(was.entries)) {
      if (!(key in now.entries) && !renamedFrom.has(key)) changes.push({ change: 'removed', family: stem, key });
    }
  }
  return changes;
}

/** Numbers keyed `<key>/<field>`: a budget's ceiling and tolerance, a floor family's floors per tool and metric. */
function measures(doc) {
  const out = new Map();
  if (shapeOf(doc) === 'budgets') {
    for (const [key, b] of Object.entries(doc.budgets)) for (const f of ['ceiling', 'tolerance']) out.set(`${key}/${f}`, b[f]);
  } else {
    for (const [tool, t] of Object.entries(doc.floors)) for (const [m, v] of Object.entries(t.floors)) out.set(`${tool}/${m}`, v);
  }
  return out;
}

/**
 * A budget or floor family's changes: each number raised or lowered (for a floor, lowered is the loosening; for a
 * budget, raised), a key added or removed, and a floor tool's changed patterns.
 */
function diffMeasures(stem, was, now) {
  const changes = [];
  const before = measures(was);
  const after = measures(now);
  for (const [key, to] of after) {
    if (!before.has(key)) changes.push({ change: 'added', family: stem, key, to });
    else if (to !== before.get(key)) changes.push({ change: to > before.get(key) ? 'raised' : 'lowered', family: stem, key, from: before.get(key), to });
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push({ change: 'removed', family: stem, key });
  if (shapeOf(now) === 'floors') {
    for (const tool of Object.keys(now.floors)) {
      for (const field of ['include', 'exclude']) {
        const from = was.floors[tool]?.[field] ?? [];
        const to = now.floors[tool][field] ?? [];
        if (!sameSet(from, to)) changes.push({ change: 'floor-globs', family: stem, key: `${tool}/${field}`, from, to });
      }
    }
  }
  return changes;
}

/**
 * The changes between the family files at `baseRev` and at `headRev` (the working tree when omitted). An entry
 * moves with git -M's renames and with the layer table's moves at either revision (the base names a planned move,
 * the head one the commit plans); throws a `layer-table` RefusalError on a table it cannot read.
 */
export function diffRatchets(root, baseRev, headRev) {
  const name = new Map([...layerMovesAt(root, baseRev), ...layerMovesAt(root, headRev)]);
  const inRepo = [...name].map(([from, to]) => [`${MODULE_ROOT}/${from}`, `${MODULE_ROOT}/${to}`]);
  const moves = { path: new Map([...inRepo, ...gitRenames(root, baseRev, headRev)]), name };
  return diffFamilies(familiesAt(root, baseRev), familiesAt(root, headRev), moves);
}

/**
 * `--diff <base> [<head>]`'s revisions: the base is the argument right after `--diff`, the head the one after it only
 * when it is no flag, so another flag's value (`--lane push`) never becomes a revision; head omitted is the working tree.
 */
export function diffRevisions(argv) {
  const at = argv.indexOf('--diff');
  const positional = (a) => a !== undefined && !a.startsWith('-');
  const base = argv[at + 1];
  if (!positional(base)) throw new Error('--diff needs a base revision right after it: --diff <base> [<head>]');
  return { base, head: positional(argv[at + 2]) ? argv[at + 2] : undefined };
}
