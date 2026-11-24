// policy/core/diff.mjs: the base-to-head diff of the family files (2.1-M74, 2.1-M348): each change the gate decides on,
// entries moved by git -M and by the layer table.
import fs from 'node:fs';
import path from 'node:path';
import { openGitReader } from '../git.mjs';
import { LAYER_TABLE, MODULE_ROOT, RATCHETS_DIR } from './base.mjs';
import { git } from './exec.mjs';
import { DERIVED_TOOLS, derivedHeader, keyPath, layerMoves, layerMovesAt, listedCount, movePath, sameSet, shapeOf, withKeyPath } from './ratchets.mjs';

/**
 * Every change a base-to-head diff of the family files can name; the commit gate (policy/gate/commit-gate-judge.ts)
 * decides which need a bead and a Q row. `--self-test` fails a change with no planted case.
 */
export const CHANGES = {
  created: 'a family file new at head: its first baseline (2.1-M40)',
  deleted: 'a family file gone at head',
  header: 'a changed version, ledger, tool, scope, lane, key kind, selection, standing mark, ceilings mark or shape; only a key kind or shape hides the entries',
  added: 'an entry new at head that is not a rename',
  raised: 'an entry or count above its base value',
  lowered: 'an entry or count below its base value',
  removed: 'an entry gone at head that was not renamed',
  renamed: 'an entry moved by git -M or the layer table at the same or a lower count (2.1-M74)',
  'bead-stripped': 'an entry whose bead was removed in a non-standing family without a family bead (canopi-0kjje, 2.1-M78)',
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

const isFamilyFile = (f) => path.posix.dirname(f) === RATCHETS_DIR && f.endsWith('.json') && !f.endsWith('.schema.json');
const NO_BLOB = /^0+$/u;

const DERIVED_TABLES = ['policy/rules.json', 'policy/primitives.json'];

/** Map(family -> derivedHeader) from policy/rules.json and policy/primitives.json at `rev` (working tree when omitted). */
async function derivedHeadersOf(root, reader, rev) {
  const headers = new Map();
  for (const table of DERIVED_TABLES) {
    let text;
    if (rev) text = await reader.readAt(rev, table);
    else if (fs.existsSync(path.join(root, table))) text = fs.readFileSync(path.join(root, table), 'utf8');
    if (!text) continue;
    let doc;
    try { doc = JSON.parse(text); } catch { continue; }
    for (const row of Array.isArray(doc?.rules) ? doc.rules : []) {
      if (row && typeof row.id === 'string' && row.status !== 'planned' && DERIVED_TOOLS.has(row.tool) && typeof row.family === 'string') {
        headers.set(row.family, derivedHeader(row));
      }
    }
  }
  return headers;
}

/** Merges a derived header into a shrunk family doc (no `version`), or synthesises an empty derived doc when absent. */
function hydrate(doc, header) {
  if (!doc) return header ? { ...header, entries: {} } : undefined;
  return doc.version === undefined && header ? { ...header, ...doc } : doc;
}

/**
 * Family file stem -> parsed doc at `baseRev` and at `headRev` (the working tree when omitted), for only the family
 * files `git diff --raw` names (and, against the working tree, the untracked ones) plus any derived rule whose header
 * changed in policy/rules.json or policy/primitives.json (2.1-M348, canopi-uxyr).
 */
async function changedFamilies(root, reader, baseRev, headRev) {
  const raw = git(root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', baseRev, ...(headRev ? [headRev] : []), '--', `${RATCHETS_DIR}/`]).split('\0');
  const changed = [];
  for (let i = 0; i + 1 < raw.length && raw[i]; i += 2) {
    const [, , from, to] = raw[i].split(' ');
    if (isFamilyFile(raw[i + 1])) changed.push({ file: raw[i + 1], from, to });
  }
  if (!headRev) {
    for (const file of git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', `${RATCHETS_DIR}/`]).split('\0')) {
      if (isFamilyFile(file)) changed.push({ file, from: '0', to: '0' });
    }
  }
  const baseDerived = await derivedHeadersOf(root, reader, baseRev);
  const headDerived = await derivedHeadersOf(root, reader, headRev);
  const base = new Map();
  const head = new Map();
  const seen = new Set();
  for (const { file, from, to } of changed) {
    const stem = path.posix.basename(file, '.json');
    seen.add(stem);
    const rawBase = !NO_BLOB.test(from) ? JSON.parse(await reader.blob(from)) : undefined;
    const rawHead = headRev
      ? (!NO_BLOB.test(to) ? JSON.parse(await reader.blob(to)) : undefined)
      : (fs.existsSync(path.join(root, file)) ? JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) : undefined);
    const was = hydrate(rawBase, baseDerived.get(stem));
    const now = hydrate(rawHead, headDerived.get(stem));
    if (was) base.set(stem, was);
    if (now) head.set(stem, now);
  }
  for (const [stem, wasHeader] of baseDerived) {
    const nowHeader = headDerived.get(stem);
    if (seen.has(stem) || !nowHeader || JSON.stringify(wasHeader) === JSON.stringify(nowHeader)) continue;
    base.set(stem, { ...wasHeader, entries: {} });
    head.set(stem, { ...nowHeader, entries: {} });
  }
  return { base, head };
}

/** The layer table's moves at `rev` (the working tree when omitted); none when there is no table. */
async function layerMovesOf(root, reader, rev) {
  if (!rev) return layerMovesAt(root);
  const text = await reader.readAt(rev, LAYER_TABLE);
  return text === undefined ? new Map() : layerMoves(text, `${rev}:${LAYER_TABLE}`);
}

/**
 * The header fields a change names; `standing` too (which exempts a family from the stopping rule), and `ceilings`,
 * which keeps a fixed site's headroom (a fall passes with nothing lowered). A family `bead` is read like an entry bead:
 * adding or changing it is no header change, while dropping it or flipping `standing` off while leaving beadless
 * entries emits `bead-stripped` (canopi-0kjje, 2.1-M78).
 */
const HEADER_FIELDS = ['version', 'family', 'ledger', 'tool', 'scope', 'lane', 'keys', 'select', 'standing', 'ceilings'];

/**
 * A key moved in its own coordinates: a path or path-rule key by `moves.path` (repository paths); each path in a name
 * key by `moves.name` when it is a module path under desktop/web/src (`app/a <-> app/b`), else by `moves.path` when it
 * is a repository path (jscpd-clones' `desktop/src/a.rs <-> desktop/src/b.rs`). A moved `<a> <-> <b>` pair is sorted
 * again, as its adapters write it.
 */
function moveKey(kind, key, moves) {
  if (kind === 'name') {
    const move = (token) => {
      const moved = movePath(token, moves.name);
      return moved === token ? movePath(token, moves.path) : moved;
    };
    const pair = key.split(' <-> ');
    return pair.length === 2 ? pair.map((side) => side.split(' ').map(move).join(' ')).sort().join(' <-> ') : key.split(' ').map(move).join(' ');
  }
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
    if (fields.length) changes.push({ change: 'header', family: stem, fields, from: was, to: now });
    // A header change hides nothing: only a new key kind or shape leaves no entries to compare.
    if (fields.includes('keys') || fields.includes('shape')) continue;
    if (shapeOf(now) === 'budgets' || shapeOf(now) === 'floors') {
      changes.push(...diffMeasures(stem, was, now));
      continue;
    }
    if (!('entries' in now)) {
      if (now.count !== was.count) changes.push({ change: now.count > was.count ? 'raised' : 'lowered', family: stem, from: was.count, to: now.count });
      if ((was.bead || was.standing === true) && !now.bead && now.standing !== true && now.count > 0) {
        changes.push({ change: 'bead-stripped', family: stem, from: was.bead ?? 'standing' });
      }
      continue;
    }
    const lostFamilyCover = (was.bead || was.standing === true) && !now.bead && now.standing !== true;
    const renamedFrom = new Set();
    const movedTo = new Map(Object.keys(was.entries).filter((k) => !(k in now.entries))
      .map((k) => [moveKey(now.keys, k, moves), k]));
    for (const [key, entry] of Object.entries(now.entries)) {
      const to = listedCount(entry);
      if (key in was.entries) {
        const from = listedCount(was.entries[key]);
        if (to !== from) changes.push({ change: to > from ? 'raised' : 'lowered', family: stem, key, from, to });
        if (!entry.bead && !now.bead && now.standing !== true && (was.entries[key].bead || lostFamilyCover)) {
          changes.push({ change: 'bead-stripped', family: stem, key, from: was.entries[key].bead ?? was.bead ?? 'standing' });
        }
        continue;
      }
      const oldKey = movedTo.get(key);
      if (oldKey !== undefined && to <= listedCount(was.entries[oldKey])) {
        renamedFrom.add(oldKey);
        changes.push({ change: 'renamed', family: stem, key, from: oldKey, count: to });
        if (!entry.bead && !now.bead && now.standing !== true && (was.entries[oldKey].bead || lostFamilyCover)) {
          changes.push({ change: 'bead-stripped', family: stem, key, from: was.entries[oldKey].bead ?? was.bead ?? 'standing' });
        }
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
 * the head one the commit plans); throws a `layer-table` RefusalError on a table it cannot read. Only the family files
 * the diff names are read (changedFamilies).
 */
export async function diffRatchets(root, baseRev, headRev) {
  const reader = openGitReader(root);
  try {
    const name = new Map([...await layerMovesOf(root, reader, baseRev), ...await layerMovesOf(root, reader, headRev)]);
    const inRepo = [...name].map(([from, to]) => [`${MODULE_ROOT}/${from}`, `${MODULE_ROOT}/${to}`]);
    const moves = { path: new Map([...inRepo, ...gitRenames(root, baseRev, headRev)]), name };
    const { base, head } = await changedFamilies(root, reader, baseRev, headRev);
    return diffFamilies(base, head, moves);
  } finally {
    reader.close();
  }
}
