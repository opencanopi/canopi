// policy/selection.mjs: what a run of policy/check.mjs observes, and which gate checks run it (2.1-M223, 2.1-M232;
// design check AR8, amending M223).
//
// A run observes one lane, `--lane push|ci` (commit when absent), and only that lane's families: the commit lane never
// waits on the push lane's Rust toolchain, and a push run never repeats the commit lane. With `--family <id>`
// (repeatable) it observes only the named families, each in its own lane. Each lane in use has a check in the gate table
// (policy/gate/table.ts) running it, check and self-test, or the default check refuses it (`lane-unrun`); a later lane
// that only families use is also run by checks naming each of its families by `--family`. A table command is one
// program and its arguments, never a shell line, and the package script an `npm run` check names is credited only when
// it is one command, so a credited run is always the one whose status the gate reads.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The lanes, in order: a run observes exactly one, `commit` by default. */
export const LANES = ['commit', 'push', 'ci'];
/** The gate table whose checks run each lane (2.1-M223 as amended by design check AR8): never a package script. */
export const GATE_TABLE = 'policy/gate/table.ts';

/** Each value of `flag` in a command line, `<flag> <value>` or `<flag>=<value>` (undefined when the value is missing). */
const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : a.startsWith(`${flag}=`) ? [a.slice(flag.length + 1)] : []));

/**
 * The lane a command line names, its first `--lane <lane>` or `--lane=<lane>` (commit when absent): the one parse the
 * CLI and the lane-runner reading share, so a script the reading credits with a lane runs that lane.
 */
export const laneArg = (args) => (flagValues(args, '--lane').length ? flagValues(args, '--lane')[0] : 'commit');
/** The flags check.mjs reads, each with how many values may follow it. */
const EQUALS_FLAGS = new Set(['--lane', '--family']);
const FLAGS = { '--lane': 1, '--family': 1, '--phase-close': 1, '--self-test': 0, '--list-rules': 0, '--closed-beads': 0 };

/**
 * The lane a check.mjs command line runs, after refusing any argument no flag reads: a mistyped flag (`--help`) would
 * otherwise start the whole default check.
 */
export function commandLane(args) {
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const [flag] = args[i].split('=', 1);
    // Only --lane and --family are read through flagValues, which takes the `=` spelling; the rest match exactly.
    if (!(flag in FLAGS) || (args[i].includes('=') && !EQUALS_FLAGS.has(flag))) unknown.push(args[i]);
    else if (!args[i].includes('=')) for (let n = 0; n < FLAGS[flag] && i + 1 < args.length && !args[i + 1].startsWith('-'); n++) i++;
  }
  if (unknown.length) throw new Error(`policy/check.mjs reads no ${unknown.join(', ')}: its flags are ${Object.keys(FLAGS).join(', ')}`);
  const lane = laneArg(args);
  if (!LANES.includes(lane)) throw new Error(`--lane takes ${LANES.join(', ')}`);
  return lane;
}

/**
 * The refusals for a mode combination no run can honour: `--closed-beads` with a lane or families (`lane` the
 * explicit --lane or undefined) would look like a lane or family check while observing none.
 */
export function modeConflicts({ closedBeads, lane, families }) {
  if (!closedBeads || (lane === undefined && !families?.length)) return [];
  const named = [lane !== undefined && `--lane ${lane}`, ...(families ?? []).map((id) => `--family ${id}`)].filter(Boolean);
  return [{ code: 'mode-conflict', where: 'policy/check.mjs', message: `--closed-beads runs alone, never with ${named.join(', ')}` }];
}

/** The families a command line names by `--family`, in order; empty for a lane run. */
export const familyArgs = (args) => flagValues(args, '--family');

/**
 * Whether a run of `lane`, or of the named `families` (ids, empty for a lane run), observes a family's loaded doc
 * (undefined for a table rule with no family, which is commit-lane): a lane run observes that lane alone. A named id
 * with no family file throws.
 */
export function observer(lane, families, loaded) {
  const unknown = families.filter((id) => !loaded.has(id));
  if (unknown.length) throw new Error(`--family takes a family of policy/ratchets/: ${unknown.map(String).join(', ')} names none`);
  if (families.length) return (doc) => families.includes(doc?.family);
  return (doc) => (doc?.lane ?? 'commit') === lane;
}

/** An environment assignment before a command's program (`CANOPI_SKIP_BUNDLED_DB=1`). */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/u;

/** A command's arguments to policy/check.mjs when its program, after env assignments, is `node` running the checker. */
function checkerArgs(words) {
  const at = words.findIndex((w) => !ENV_ASSIGNMENT.test(w));
  return words[at] === 'node' && words[at + 1]?.endsWith('policy/check.mjs') ? words.slice(at + 2) : null;
}

/** Anything that lets a shell line run, skip or discard a command other than its one program: never credited. */
const SHELL = /[|&;<>()`$\n#'"\\]/u;

/**
 * The words a table check runs: its command, or for `npm run <script>` (after env assignments) the script it names in
 * the check directory's package.json when that script is one command with no shell syntax (a chain, pipe, redirection,
 * expansion or quote is credited with nothing, so a credited checker run is always the script's exit status).
 */
function checkWords(root, check) {
  const words = String(check?.command ?? '').split(/\s+/u).filter(Boolean);
  const at = words.findIndex((w) => !ENV_ASSIGNMENT.test(w));
  if (words[at] !== 'npm' || words[at + 1] !== 'run' || words.length !== at + 3) return words;
  let script;
  try {
    script = JSON.parse(fs.readFileSync(path.join(root, check.cwd ?? '', 'package.json'), 'utf8')).scripts?.[words[at + 2]];
  } catch {
    return [];
  }
  return typeof script === 'string' && !SHELL.test(script) ? script.split(/\s+/u).filter(Boolean) : [];
}

/**
 * Each `<mode> <lane>` and `<mode> family:<id>` a check of the gate table under `root` runs (`check commit`,
 * `self-test push`, `check family:bundle-size`, ...), read as the CLI reads its flags; a CI-only row runs nothing here,
 * and another mode (--list-rules, --phase-close, --closed-beads) runs no lane. A table that cannot be loaded runs none.
 */
async function tableRuns(root) {
  let table;
  try {
    table = (await import(pathToFileURL(path.join(root, GATE_TABLE)).href)).TABLE;
  } catch {
    return new Set();
  }
  const runs = new Set();
  for (const check of Object.values(table?.checks ?? {})) {
    if (check?.ciOnly) continue;
    const args = checkerArgs(checkWords(root, check));
    if (!args || args.some((a) => ['--list-rules', '--phase-close', '--closed-beads'].includes(a))) continue;
    const mode = args.includes('--self-test') ? 'self-test' : 'check';
    const families = familyArgs(args);
    if (!families.length) runs.add(`${mode} ${laneArg(args)}`);
    for (const id of families) runs.add(`${mode} family:${id}`);
  }
  return runs;
}

/**
 * Refuses each lane in use, by a family or by a planted case's `toolLane` under `casesRoot`, that no gate table check
 * runs as both the check and the self-test: a family, planted rule or real-tool case would otherwise pass every gate
 * unrun while still covering its codes (2.1-M223). A later lane only families use is run, in a mode, when checks name
 * each of its families by `--family` in that mode (2.1-M232).
 */
export async function unrunLanes(root, families, casesRoot) {
  const byLane = new Map();
  for (const { doc } of families.values()) byLane.set(doc.lane, [...(byLane.get(doc.lane) ?? []), doc.family]);
  const caseLanes = new Set();
  for (const kind of fs.existsSync(casesRoot) ? fs.readdirSync(casesRoot) : []) {
    const dir = path.join(casesRoot, kind);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try {
        const { toolLane } = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (LANES.includes(toolLane)) caseLanes.add(toolLane);
      } catch {
        // A case that is not JSON fails the self-test; it names no lane here.
      }
    }
  }
  const runs = await tableRuns(root);
  const ran = (mode, lane) => runs.has(`${mode} ${lane}`)
    || (lane !== 'commit' && !caseLanes.has(lane) && byLane.get(lane).every((id) => runs.has(`${mode} family:${id}`)));
  return LANES.filter((l) => byLane.has(l) || caseLanes.has(l)).flatMap((l) => ['check', 'self-test'].filter((m) => !ran(m, l)).map((m) => ({
    code: 'lane-unrun',
    where: GATE_TABLE,
    message: `the ${l} lane is in use and no gate check runs \`node policy/check.mjs${m === 'self-test' ? ' --self-test' : ''}${l === 'commit' ? '' : ` --lane ${l}`}\`${l === 'commit' ? '' : ` or names each of its families by --family`}`,
  })));
}
