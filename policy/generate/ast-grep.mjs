// policy/generate/ast-grep.mjs: ast-grep's project config, the rule-file, rule-test and rule-members refusals and the
// primitives step (contracts §12, §18; ADR 0028; 2.1-M189, 2.1-M226, 2.1-M250; Phase 0 F1a and F1b, split from
// policy/generate.mjs by 2.1-Q243).
import fs from 'node:fs';
import path from 'node:path';
import { HEADER, SRC, bare, escRe, filesUnder, rowFor } from './boundary-facts.mjs';

export const AST_GREP_RULES = 'policy/ast-grep/rules';
export const AST_GREP_TESTS = 'policy/ast-grep/rule-tests';

/** sgconfig.yml: the one ast-grep project, its rules and its rule tests. */
export const sgconfigText = () => `# ${HEADER}\nruleDirs:\n  - ${AST_GREP_RULES}\ntestConfigs:\n  - testDir: ${AST_GREP_TESTS}\n`;

/** Refusals for ast-grep rule files: a file below a subdirectory (ast-grep walks ruleDirs recursively; a flat directory
 * keeps each id its one file name), an id that is no active ast-grep row (`<id>` or `<id>.<lang>`), or a message
 * that lacks its row's owner and example (contracts §18; 2.1-M226). */
export function ruleFileRefusals(root, rows) {
  const refusals = [];
  for (const name of filesUnder(path.join(root, AST_GREP_RULES)).sort()) {
    const where = `${AST_GREP_RULES}/${name}`;
    if (name.includes('/')) {
      refusals.push({ code: 'rule-file', where, message: `a rule file sits directly in ${AST_GREP_RULES}, never in a subdirectory` });
      continue;
    }
    const [text, ...parts] = fs.readFileSync(path.join(root, where), 'utf8').split(/^---[ \t]*$/mu);
    const fieldOf = (doc) => (key) => /^(['"]?)(.*)\1\s*$/.exec(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(doc)?.[1] ?? '')?.[2] ?? '';
    const field = fieldOf(text);
    const id = field('id');
    const lang = field('language').toLowerCase();
    // A further document scopes another part of the same rule by path: its id `<id>.<part>`, its language and the
    // owner and example in its message as the first document's.
    for (const doc of parts) {
      const f = fieldOf(doc);
      if (!new RegExp(`^${escRe(id)}\\.[a-z0-9-]+$`, 'u').test(f('id')) || f('language').toLowerCase() !== lang) {
        refusals.push({ code: 'rule-file', where, message: `a further document's id is ${id}.<part> in language ${lang} (id ${JSON.stringify(f('id'))})` });
      } else if (rows.get(id.split('.')[0])?.tool === 'ast-grep' && !isPrimitiveRow(rows.get(id.split('.')[0]))) {
        const row = rows.get(id.split('.')[0]);
        const missing = ['owner_today', 'example'].filter((k) => !row[k] || !f('message').includes(row[k]));
        if (missing.length) refusals.push({ code: 'rule-message', where, message: `${f('id')}'s message names no ${missing.join(' and ')} of ${row.id}` });
      }
    }
    const [base, suffix] = id.split('.');
    const row = rows.get(base);
    if (!name.endsWith('.yml') || !id || `${id}.yml` !== name || (suffix !== undefined && suffix !== lang)) {
      refusals.push({ code: 'rule-file', where, message: `a rule file is <id>.yml or <id>.<language>.yml, its id the file name (id ${JSON.stringify(id)}, language ${JSON.stringify(lang)})` });
    } else if (row?.tool !== 'ast-grep') {
      refusals.push({ code: 'rule-file', where, message: `${base} is no active ast-grep row of a policy table (policy/rules.json, policy/primitives.json)` });
    } else if (!isPrimitiveRow(row)) {
      const message = field('message');
      const missing = ['owner_today', 'example'].filter((k) => !row[k] || !message.includes(row[k]));
      if (missing.length) refusals.push({ code: 'rule-message', where, message: `the message names no ${missing.join(' and ')} of ${base} (${missing.map((k) => row[k]).join(', ')})` });
    }
  }
  return refusals;
}

// The primitives step (contracts §12:543, §18:659-661; ADR 0028:14; 2.1-M189; Phase 0 F1b): a §18 row of
// policy/primitives.json (`primitive` F<n> or R<n>, tool ast-grep, active) owns its rule files' `message` and
// `ignores`; the matcher (`files`, `rule`) stays hand-written. The message names the rule, the primitive, the row's
// note, its ADR, owner_today (and also_owners), the target and the example; the ignores are the test files, owner_today
// with the destination the layer table moves it to, and also_owners (`exceptions` stay counted entries). A rule file
// whose message or ignores differ is a drifted output: --check names it, a write restores it.
const PRIMITIVES = 'policy/primitives.json';
const RULE_ROOTS = '{desktop/web,policy/fixtures/rules/*}/';
const TEST_IGNORES = ['src/__tests__/**', 'src/**/__fixtures__/**', 'src/**/*.test.ts', 'src/**/*.test.tsx'];
/** Whether a policy table row is a §18 primitive row whose rule files this step writes. */
export const isPrimitiveRow = (row) => /^[FR]\d+$/u.test(row?.primitive ?? '') && row.tool === 'ast-grep' && row.status !== 'planned';

/** The generated message of a primitive row. */
export function primitiveMessage(row) {
  const also = row.also_owners?.length ? ` (also ${row.also_owners.join(', ')})` : '';
  const target = row.owner_target ? `; target ${row.owner_target.path} (${row.owner_target.phase})` : '';
  return `${row.id} (§18 ${row.primitive}): ${row.note ?? row.id}. ADR ${row.adr ?? 'none'}; owner ${row.owner_today}${also}${target}; example ${row.example ?? 'none yet'}`;
}

/** The generated ignores of a primitive row: globs over desktop/web and the planted mirror. */
function primitiveIgnores(root, row, table) {
  const rel = (p) => p.replace(/^desktop\/web\//u, '');
  const glob = (p) => {
    const full = path.join(root, p);
    const dir = fs.existsSync(full) ? fs.statSync(full).isDirectory() : !path.extname(p);
    return `${RULE_ROOTS}${rel(p)}${dir ? '/**' : ''}`;
  };
  const owners = [row.owner_today, ...(row.also_owners ?? [])].filter((p) => p && p !== 'none');
  // §12:543: the owner follows the layer table's destination column, so the generated rule renames with the move.
  const moved = owners.flatMap((p) => {
    const inSrc = p.startsWith(`${SRC}/`) ? p.slice(SRC.length + 1) : undefined;
    const layer = inSrc === undefined ? undefined : rowFor(table.layers, inSrc);
    if (!layer?.destination) return [];
    return [`${SRC}/${bare(layer.destination)}${inSrc.slice(bare(layer.path).length)}`];
  });
  return [...TEST_IGNORES.map((g) => `${RULE_ROOTS}${g}`), ...[...new Set([...owners, ...moved])].map(glob)];
}

/** {path: text} for each primitive row's rule files, message and ignores regenerated in every document. */
export function primitiveRuleOutputs(root, table) {
  const file = path.join(root, PRIMITIVES);
  if (!fs.existsSync(file)) return {};
  const rows = (JSON.parse(fs.readFileSync(file, 'utf8')).rules ?? []).filter(isPrimitiveRow);
  const names = filesUnder(path.join(root, AST_GREP_RULES));
  const outputs = {};
  for (const row of rows) {
    const message = `message: ${JSON.stringify(primitiveMessage(row))}`;
    const ignores = `ignores:\n${primitiveIgnores(root, row, table).map((g) => `  - ${JSON.stringify(g)}`).join('\n')}\n`;
    for (const name of names.filter((n) => n.startsWith(`${row.id}.`) && n.endsWith('.yml'))) {
      const rel = `${AST_GREP_RULES}/${name}`;
      const docs = fs.readFileSync(path.join(root, rel), 'utf8').split(/^(?=---[ \t]*$)/mu).map((doc) => {
        const body = doc.replace(/^message:.*$/mu, message).replace(/^ignores:\n(?:[ \t]+-.*\n)*/mu, '');
        return body.replace(/^rule:/mu, `${ignores}rule:`);
      });
      outputs[rel] = docs.join('');
    }
  }
  return outputs;
}

/** Refuses each rule test (AST_GREP_TESTS) whose id names no rule document of AST_GREP_RULES. */
export function ruleTestRefusals(root) {
  const ids = new Set(filesUnder(path.join(root, AST_GREP_RULES)).flatMap((name) => fs.readFileSync(path.join(root, AST_GREP_RULES, name), 'utf8')
    .split(/^---[ \t]*$/mu).map((doc) => /^id:[ \t]*['"]?([^'"\s]+)/mu.exec(doc)?.[1]).filter(Boolean)));
  return filesUnder(path.join(root, AST_GREP_TESTS)).flatMap((name) => {
    const id = /^id:[ \t]*['"]?([^'"\s]+)/mu.exec(fs.readFileSync(path.join(root, AST_GREP_TESTS, name), 'utf8'))?.[1];
    return ids.has(id) ? [] : [{ code: 'rule-test', where: `${AST_GREP_TESTS}/${name}`, message: `test id ${JSON.stringify(id)} names no rule in ${AST_GREP_RULES}: ast-grep test would skip it and pass` }];
  });
}

/** Rules whose `# members:` regex spells a string-literal union (a hand-kept list, so held to its source): the
 * RasterQuantity rule to the generated contract's union (FAP's raster-quantity test read it), the tool-id rule to the
 * ToolId union of its row's owner_today, so the list follows the owner to the command table's tool rows (2c). A member
 * added or renamed in the union, a list edited by hand, or a union no longer readable is refused. */
const MEMBER_RULES = [
  { rule: 'raster-quantity-literal-only-in-item-types', type: 'RasterQuantity', source: () => `${SRC}/generated/contracts.ts` },
  { rule: 'tool-id-literal-only-in-rows', type: 'ToolId', source: (row) => row.owner_today },
];
export function memberRefusals(root, rows) {
  const refusals = [];
  for (const { rule: id, type, source } of MEMBER_RULES) {
    const row = rows.get(id);
    if (row?.tool !== 'ast-grep') continue;
    const file = source(row);
    const text = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : '';
    const union = new RegExp(`export type ${type} =((?:\\s*\\|?\\s*["'][^"'\\n]+["'])+)`, 'u').exec(text.replace(/\/\/[^\n]*/gu, ''))?.[1];
    const members = union ? [...union.matchAll(/["']([^"']+)["']/gu)].map((m) => m[1]).sort() : [];
    if (!members.length) {
      refusals.push({ code: 'rule-members', where: file, message: `no ${type} union of string literals to read` });
      continue;
    }
    for (const name of filesUnder(path.join(root, AST_GREP_RULES)).filter((n) => n.startsWith(`${id}.`))) {
      const text2 = fs.readFileSync(path.join(root, AST_GREP_RULES, name), 'utf8');
      const listed = (/# members:[^\n]*\n\s*regex: \^(?:\['"\])?\(([^)]*)\)(?:\['"\])?\$/u.exec(text2)?.[1] ?? '').split('|').filter(Boolean).sort();
      if (listed.join() !== members.join()) refusals.push({ code: 'rule-members', where: `${AST_GREP_RULES}/${name}`, message: `members ${listed.join(', ') || '(none)'}; ${file}'s ${type} union is ${members.join(', ')}` });
    }
  }
  return refusals;
}

