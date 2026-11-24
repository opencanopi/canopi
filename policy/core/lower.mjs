// policy/core/lower.mjs: `check.mjs --update` (canopi-hlewq, 2.1-M530): lowers falling counts and removes stale
// entries in ratchet families, deletes emptied derived family files, never raises a baseline or adds an unlisted
// entry, and skips budgets, floors (coverage floors never fall) and ceilings families.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './base.mjs';
import { exec } from './exec.mjs';
import { loadAdapter, observe, observedFamilies, toolRefusal } from './observe.mjs';
import { compare, listedCount, loadRatchets, shapeOf } from './ratchets.mjs';
import { loadTableRules, rowFamilyRefusals } from './tables.mjs';

/**
 * Lowers a raw on-disk family doc against `observed` sites/count. Returns `{ changed, remove, nextDoc }`.
 * Never raises a value, never adds an unlisted entry, and never touches budgets, floors or ceilings families.
 */
function lowerFamilyDoc(rawDoc, doc, observed) {
  const shape = shapeOf(doc);
  if (shape === 'budgets' || shape === 'floors' || doc.ceilings === true) {
    return { changed: false, remove: false, nextDoc: rawDoc };
  }
  if (shape === 'count') {
    if (typeof observed === 'number' && observed < rawDoc.count) {
      return { changed: true, remove: false, nextDoc: { ...rawDoc, count: observed } };
    }
    return { changed: false, remove: false, nextDoc: rawDoc };
  }
  const nextEntries = {};
  let changed = false;
  for (const [key, entry] of Object.entries(rawDoc.entries ?? {})) {
    const seen = observed?.[key] ?? 0;
    if (seen <= 0) {
      changed = true;
      continue;
    }
    if (seen < listedCount(entry)) {
      changed = true;
      nextEntries[key] = { ...entry, count: seen };
    } else {
      nextEntries[key] = entry;
    }
  }
  if (!changed) return { changed: false, remove: false, nextDoc: rawDoc };
  const remove = rawDoc.version === undefined && Object.keys(nextEntries).length === 0 && !rawDoc.bead && rawDoc.standing !== true;
  return { changed: true, remove, nextDoc: { ...rawDoc, entries: nextEntries } };
}

/** Runs one family for `--update`, lowering its file on disk when observed < baseline and returning remaining refusals. */
async function lowerOneFamily(root, { file, doc, inScope, paths }, adapter, shared) {
  const shape = shapeOf(doc);
  if (shape === 'budgets' || shape === 'floors' || doc.ceilings === true) {
    return { updated: false, removed: false, refusals: [] };
  }
  let sites;
  try {
    sites = (await adapter.collect({ root, paths, exec, select: doc.select, shared })).filter((s) => s.path === undefined || inScope(s.path));
  } catch (error) {
    return { updated: false, removed: false, refusals: [toolRefusal(error, file)] };
  }
  const { observed, refusals } = observe(doc, sites, adapter.refuse);
  const full = path.join(root, file);
  let updated = false;
  let removed = false;
  let nextDoc = doc;
  if (fs.existsSync(full)) {
    const rawDoc = JSON.parse(fs.readFileSync(full, 'utf8'));
    const lowered = lowerFamilyDoc(rawDoc, doc, observed);
    if (lowered.changed) {
      if (lowered.remove) {
        fs.unlinkSync(full);
        removed = true;
        nextDoc = { ...doc, entries: {} };
      } else {
        fs.writeFileSync(full, `${JSON.stringify(lowered.nextDoc, null, 2)}\n`);
        updated = true;
        nextDoc = { ...doc, ...lowered.nextDoc };
      }
    }
  }
  return { updated, removed, refusals: [...refusals, ...compare(nextDoc, observed)] };
}

/**
 * Lowers every observed ratchet family in `lane` (or `families`) whose observed count/entries fell below its baseline.
 * Never raises a baseline or adds an unlisted entry; returns `{ updated, removed, refusals }`.
 */
export async function lowerRepo(root = REPO_ROOT, lane = 'commit', { families: only = [] } = {}) {
  const { families, refusals } = loadRatchets(root);
  const tables = loadTableRules(root);
  refusals.push(...tables.refusals, ...rowFamilyRefusals(families, tables));
  if (refusals.length) return { updated: [], removed: [], refusals };
  const { observed, unions } = observedFamilies(root, lane, only, families);
  const sharing = new Map();
  const updated = [];
  const removed = [];
  for (const item of observed) {
    const adapter = await loadAdapter(root, item.doc.tool);
    if (adapter.shared && !sharing.has(item.doc.tool)) sharing.set(item.doc.tool, { union: [...unions.get(item.doc.tool)].sort() });
    const res = await lowerOneFamily(root, item, adapter, sharing.get(item.doc.tool));
    if (res.updated) updated.push(item.file);
    if (res.removed) removed.push(item.file);
    refusals.push(...res.refusals);
  }
  return { updated, removed, refusals };
}
