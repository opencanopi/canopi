// policy/core/lower.mjs: `check.mjs --update` (canopi-hlewq, 2.1-M530): lowers falling counts and removes stale
// entries in ratchet families, deletes emptied derived family files, never raises a baseline or adds an unlisted
// entry, and skips budgets, floors (coverage floors never fall) and ceilings families.
import fs from 'node:fs';
import path from 'node:path';
import { RATCHETS_DIR, REPO_ROOT } from './base.mjs';
import { exec } from './exec.mjs';
import { loadAdapter, observe, observedFamilies, toolRefusal } from './observe.mjs';
import { compare, listedCount, loadRatchets, shapeOf } from './ratchets.mjs';
import { loadTableRules, rowFamilyRefusals } from './tables.mjs';

const GLOBAL_LOAD_CODES = new Set(['missing-source', 'schema-keyword', 'layer-table', 'rules-table', 'duplicate-rule', 'missing-rule']);

/** Formats a ratchet JSON document with compact one-line entries so `--update` diffs stay minimal. */
function formatRatchetJson(doc) {
  const keys = Object.keys(doc);
  const lines = ['{'];
  keys.forEach((key, idx) => {
    const comma = idx < keys.length - 1 ? ',' : '';
    const value = doc[key];
    if (key === 'entries' && value && typeof value === 'object' && !Array.isArray(value)) {
      const entryKeys = Object.keys(value);
      if (entryKeys.length === 0) {
        lines.push(`  "entries": {}${comma}`);
      } else {
        lines.push('  "entries": {');
        entryKeys.forEach((ek, ei) => {
          const eComma = ei < entryKeys.length - 1 ? ',' : '';
          const body = JSON.stringify(value[ek]).replace(/\{/g, '{ ').replace(/\}/g, ' }').replace(/":/g, '": ').replace(/,/g, ', ');
          lines.push(`    ${JSON.stringify(ek)}: ${body}${eComma}`);
        });
        lines.push(`  }${comma}`);
      }
      return;
    }
    const serialized = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
    lines.push(`  ${JSON.stringify(key)}: ${serialized}${comma}`);
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

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
  // Never write when observation itself has refusals (refused-site or observed-shape omits sites from the count).
  if (refusals.length) return { updated: false, removed: false, refusals };
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
        fs.writeFileSync(full, formatRatchetJson(lowered.nextDoc));
        updated = true;
        nextDoc = { ...doc, ...lowered.nextDoc };
      }
    }
  }
  return { updated, removed, refusals: compare(nextDoc, observed) };
}

/**
 * Lowers every observed ratchet family in `lane` (or `families`) whose observed count/entries fell below its baseline.
 * Never raises a baseline or adds an unlisted entry; returns `{ updated, removed, refusals }`.
 */
export async function lowerRepo(root = REPO_ROOT, lane = 'commit', { families: only = [] } = {}) {
  const { families, refusals: loadRefusals } = loadRatchets(root, { allowEntryPathDrift: true });
  const tables = loadTableRules(root);
  const allLoadRefusals = [...loadRefusals, ...tables.refusals, ...rowFamilyRefusals(families, tables)];
  if (allLoadRefusals.some((r) => GLOBAL_LOAD_CODES.has(r.code))) {
    return { updated: [], removed: [], refusals: allLoadRefusals };
  }
  const onlyFiles = new Set(only.map((id) => `${RATCHETS_DIR}/${id}.json`));
  const refusals = only.length ? allLoadRefusals.filter((r) => onlyFiles.has(r.where)) : [...allLoadRefusals];
  const presentOnly = only.filter((id) => families.has(id));
  if (only.length && presentOnly.length === 0) return { updated: [], removed: [], refusals };
  const { observed, unions } = observedFamilies(root, lane, presentOnly, families);
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
