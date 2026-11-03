// policy/core/tables.mjs: the policy tables (policy/*.json with a top-level `rules` array) and the rule registry
// (2.1-M222, 2.1-M223, 2.1-M348): the rows, their checks, --phase-close's refusals and the rows' families.
import fs from 'node:fs';
import path from 'node:path';
import { UPSTREAM_REGISTER } from '../beads.mjs';
import { isObject, isRepoPath, POLICY_DIR, RATCHETS_DIR, refusal, REPO_ROOT, RULES_TABLE } from './base.mjs';
import { listFiles } from './exec.mjs';
import { loadRatchets } from './ratchets.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Registry

/** This checker's own rule id, the name the ADRs and guides use for it. */
export const CHECKER_ID = 'policy-tables-check';

const RULE_ID = /^\S+$/u;
/** A row's `owner_today` when the primitive has no owner yet and 0 sites are allowed. */
export const NO_OWNER = 'none';

/** A row path without its one optional trailing slash: a file or a directory relative to the repository. */
const rowPath = (p) => (typeof p === 'string' && p.endsWith('/') ? p.slice(0, -1) : p);

/** Refusals for a row's own fields: its status, family, owner and example paths and owner_target phase. */
function checkRow(row, i, table, { root, files, phases }) {
  const at = `/rules/${i}`;
  if ('status' in row && row.status !== 'planned') {
    return [refusal('rules-table', table, `${at}: status is "planned" or absent, not ${JSON.stringify(row.status)}`)];
  }
  if ('phase_close' in row && row.phase_close !== 'empty') {
    return [refusal('rules-table', table, `${at}: phase_close is "empty" or absent, not ${JSON.stringify(row.phase_close)}`)];
  }
  if ('family' in row && (typeof row.family !== 'string' || !RULE_ID.test(row.family))) {
    return [refusal('rules-table', table, `${at}: family names one family file, ${RATCHETS_DIR}/<family>.json`)];
  }
  const target = row.owner_target;
  if (target !== undefined && !(isObject(target) && typeof target.path === 'string' && typeof target.phase === 'string')) {
    return [refusal('rules-table', table, `${at}: owner_target is {path, phase, bead?}`)];
  }
  if (row.status === 'planned' && target === undefined) {
    return [refusal('rules-table', table, `${at}: a planned row names the phase it becomes a rule in, owner_target {path, phase, bead?}`)];
  }
  const refusals = [];
  const exists = (p) => isRepoPath(p) && files.some((f) => f === p || f.startsWith(`${p}/`));
  for (const field of ['owner_today', 'example']) {
    if (!(field in row)) continue;
    const p = rowPath(row[field]);
    if (field === 'owner_today' && p === NO_OWNER) continue;
    if (!exists(p)) refusals.push(refusal('owner-path', table, `${row.id}: ${field} ${JSON.stringify(row[field])} names no file or directory${field === 'owner_today' ? ` (write "${NO_OWNER}" for a primitive with no owner yet)` : ''}`));
  }
  if (target && !phases.includes(target.phase)) {
    refusals.push(refusal('phase-label', table, `${row.id}: owner_target phase ${target.phase} is not one of ${RULES_TABLE}'s phases`));
  }
  if (row.status !== 'planned' && row.family !== undefined && !fs.existsSync(path.join(root, RATCHETS_DIR, `${row.family}.json`))) {
    refusals.push(refusal('missing-rule', table, `rule ${row.id}${row.ledger ? ` (${row.ledger})` : ''} names family ${row.family}, and ${RATCHETS_DIR}/${row.family}.json is missing`));
  }
  return refusals;
}

/**
 * The rules the policy tables declare (2.1-M222, 2.1-M223): each `policy/*.json` table's top-level `rules` array of rows
 * with an `id` (rules.json, F1b's primitives.json); another table without `rules` declares none, but rules.json must
 * exist and hold rows, since the required rules are its rows.
 *   - `family` names the ratchet family that enforces the row, and that family's file must exist: the required rules
 *     are these rows, so deleting a family file, with or without its planted directory, fails every mode. An active
 *     row naming a tool needs one unless that tool is agent-hooks or commit-gate (rowFamilyRefusals).
 *   - `"status": "planned"` marks a rule whose owner is not built yet: it generates no rule, needs no planted
 *     violation, adapter or family until its phase (its owner_target, which it must have; --phase-close refuses it
 *     once that phase closes), and --list-rules shows it as planned.
 *   - `owner_today` (an existing path, or `none`) and `example` must exist; `owner_target: {path, phase, bead}` names a
 *     phase from rules.json's `phases`, the plan's labels in the order the plan lists them, a phase after its streams.
 * Returns { rules: Map(id -> {table, row}) of active rows, planned: Map of planned rows, phases, refusals, docs: each
 * readable table as {table, doc} }.
 */
export function loadTableRules(root = REPO_ROOT) {
  const rules = new Map();
  const planned = new Map();
  const refusals = [];
  const dir = path.join(root, POLICY_DIR);
  const names = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort()
    : [];
  const docs = [];
  for (const name of names) {
    const table = `${POLICY_DIR}/${name}`;
    try {
      docs.push({ table, doc: JSON.parse(fs.readFileSync(path.join(root, table), 'utf8')) });
    } catch (error) {
      refusals.push(refusal('unreadable', table, error.message));
    }
  }
  // The required rules are rules.json's rows: a missing table, or one without rows, would drop them unrefused.
  const required = docs.find((d) => d.table === RULES_TABLE);
  const hasRows = (doc) => isObject(doc) && Array.isArray(doc.rules) && doc.rules.length > 0;
  if (!fs.existsSync(path.join(root, RULES_TABLE))) {
    refusals.push(refusal('missing-source', RULES_TABLE, 'no rules table: the required rules are its rows'));
  } else if (required && !hasRows(required.doc)) {
    refusals.push(refusal('rules-table', RULES_TABLE, 'rules is a non-empty array of rows: the required rules are its rows'));
  }
  let phases = [];
  const order = required?.doc?.phases;
  if (order !== undefined) {
    if (Array.isArray(order) && order.every((p) => typeof p === 'string' && RULE_ID.test(p)) && new Set(order).size === order.length) phases = order;
    else refusals.push(refusal('rules-table', RULES_TABLE, 'phases is an array of distinct phase labels, in the plan\'s order'));
  }
  const files = docs.length ? listFiles(root) : [];
  for (const { table, doc } of docs) {
    if (!isObject(doc) || !('rules' in doc) || (table === RULES_TABLE && !hasRows(doc))) continue;
    if (!Array.isArray(doc.rules)) {
      refusals.push(refusal('rules-table', table, 'rules is not an array'));
      continue;
    }
    doc.rules.forEach((row, i) => {
      if (!isObject(row) || typeof row.id !== 'string' || !RULE_ID.test(row.id)) {
        refusals.push(refusal('rules-table', table, `/rules/${i}: a row needs an id, one word`));
        return;
      }
      const seen = rules.get(row.id) ?? planned.get(row.id);
      if (seen) {
        refusals.push(refusal('duplicate-rule', table, `${row.id} is also a rule of ${seen.table}`));
        return;
      }
      const rowRefusals = checkRow(row, i, table, { root, files, phases });
      refusals.push(...rowRefusals);
      if (rowRefusals.some((r) => r.code === 'rules-table')) return;
      (row.status === 'planned' ? planned : rules).set(row.id, { table, row });
    });
  }
  return { rules, planned, phases, refusals, docs };
}

/** The open upstream rows whose pin test is still planned: [{ id, phase, bead }]; none without a readable register. */
export function plannedPins(root = REPO_ROOT) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(root, UPSTREAM_REGISTER), 'utf8'));
  } catch {
    return []; // upstream-register.mjs refuses a missing or unreadable register
  }
  return (Array.isArray(doc?.workarounds) ? doc.workarounds : [])
    .filter((row) => row?.status === 'open' && isObject(row.pin_test?.planned))
    .map((row) => ({ id: row.id, ...row.pin_test.planned }));
}

/**
 * `--phase-close <phase>`: refuses each row, planned or not, whose owner_target phase is `phase` or earlier in
 * rules.json's order while its owner_today is not its owner_target path, or while it is still planned, so it would
 * never become a rule (2.1-M223); a phase the order lacks; each entry left in a family whose row says
 * `phase_close: empty`, which every phase closes empty (the flake quarantine, ADR 0028 Flakes, 2.1-M229); and each
 * open upstream row whose pin test (`pins`, plannedPins()) is still planned for `phase` or earlier, a pin never written.
 */
export function phaseCloseRefusals(tables, phase, families = new Map(), pins = []) {
  const at = tables.phases.indexOf(phase);
  if (at === -1) return [refusal('phase-label', RULES_TABLE, `--phase-close ${phase}: not one of the phases ${tables.phases.join(', ')}`)];
  const refusals = [];
  for (const { table, row } of [...tables.rules.values(), ...tables.planned.values()]) {
    const target = row.owner_target;
    if (!target || tables.phases.indexOf(target.phase) > at) continue;
    const bead = target.bead ? ` (${target.bead})` : '';
    if (rowPath(row.owner_today) !== rowPath(target.path)) {
      refusals.push(refusal('phase-close', table, `${row.id}: phase ${target.phase} closes with its owner at ${row.owner_today ?? '(no owner_today)'}, not ${target.path}${bead}`));
    } else if (row.status === 'planned') {
      refusals.push(refusal('phase-close', table, `${row.id}: phase ${target.phase} closes with the row still planned; drop its status so the rule runs${bead}`));
    }
  }
  for (const { table, row } of tables.rules.values()) {
    const family = row.phase_close === 'empty' ? families.get(row.family) : undefined;
    for (const key of Object.keys(family?.doc.entries ?? {})) {
      refusals.push(refusal('phase-close', family.file, `${key}: phase ${phase} closes with this entry in ${row.id}, which ${table} keeps empty at every phase close (phase_close: empty); fix the test or delete it`));
    }
  }
  for (const pin of pins) {
    const due = tables.phases.indexOf(pin.phase);
    if (due !== -1 && due <= at) {
      refusals.push(refusal('phase-close', UPSTREAM_REGISTER, `${pin.id}: phase ${pin.phase} closes with its pin test still planned (${pin.bead}); write the pin or re-plan it with the bead that will`));
    }
  }
  return refusals;
}

/**
 * The rule registry `check_docs.py` queries (2.1-M186): this checker's id, every family id and every policy table's
 * rule ids, sorted, each once (a family ratcheting a table's rule shares its id); a planned row is listed as
 * `<id> planned`. It is computed from the tables on each call and never committed; a refused table gives refusals and
 * no partial list.
 */
export function listRules(root = REPO_ROOT) {
  const { families, refusals } = loadRatchets(root);
  const tables = loadTableRules(root);
  refusals.push(...tables.refusals);
  const rules = new Set([CHECKER_ID, ...families.keys(), ...tables.rules.keys()]);
  for (const id of tables.planned.keys()) if (!rules.has(id)) rules.add(`${id} planned`);
  if (refusals.length) return { rules: [], refusals };
  return { rules: [...rules].sort(), refusals };
}

/**
 * The tools whose rows are enforced outside this checker, so need no family: scripts/agent_hooks.py and
 * scripts/commit_gate.py hold them on every hook and commit. Any other tool's sites reach a gate only through a family.
 */
const ENFORCED_OUTSIDE_CHECKER = new Set(['agent-hooks', 'commit-gate']);

/**
 * Refuses each active policy table row that names a loaded family and a `tool` other than that family's: the family's
 * tool is the one that runs the row's planted violation and counts its sites. An active row naming a tool and no family
 * is refused too unless ENFORCED_OUTSIDE_CHECKER holds its tool: only families are held to the tree, so its planted
 * violation would fire while its real sites failed no gate (canopi-f47t.52.228).
 */
export function rowFamilyRefusals(families, tables) {
  const refusals = [];
  for (const [id, { row, table }] of tables.rules) {
    if (row.family === undefined && row.tool !== undefined && !ENFORCED_OUTSIDE_CHECKER.has(row.tool)) {
      refusals.push(refusal('rules-table', table, `${id}: an active ${row.tool} row names the family that holds it on the tree (${RATCHETS_DIR}/<family>.json); only ${[...ENFORCED_OUTSIDE_CHECKER].join(', ')} rows are enforced outside the checker`));
      continue;
    }
    const family = row.family === undefined ? undefined : families.get(row.family);
    if (family && row.tool !== undefined && row.tool !== family.doc.tool) {
      refusals.push(refusal('rules-table', table, `${id}: tool ${row.tool} is not its family ${row.family}'s tool ${family.doc.tool}; name the family's tool or none`));
    }
  }
  return refusals;
}
