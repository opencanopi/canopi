// policy/selection.mjs: what a run of policy/check.mjs observes, and which package scripts run it (2.1-M223, 2.1-M232).
//
// A run observes a lane, `--lane push|ci` (commit when absent), that is that lane and every earlier one; or, with
// `--family <id>` (repeatable), only the named families and their table rows, each in its own lane and no earlier one,
// so a ci-lane family runs alone in the job that holds its inputs and that job needs no earlier lane's tools (the push
// lane's clippy). Each lane in use has a LANE_RUNNERS script that runs it, check and self-test, or the default check
// refuses it (`lane-unrun`); a later lane that only families use is also run by scripts naming each of its families by
// `--family`. That is all the checker vouches for: that a gate runs the script is the gate's wiring. The gates name the
// scripts (`test:policies`, `test:policies:push`, `test:policies:bundle`), never the checker's flags.
import fs from 'node:fs';
import path from 'node:path';

/** The lanes a run observes: `commit` by default, `--lane push` adds push, `--lane ci` every lane. */
export const LANES = ['commit', 'push', 'ci'];
/** The lanes a run of `lane` observes: that lane and every earlier one. */
export const lanesUpTo = (lane) => LANES.slice(0, LANES.indexOf(lane) + 1);
/** The scripts file whose scripts run each lane: the gates name its scripts, never the checker's flags (2.1-M223). */
export const LANE_RUNNERS = 'desktop/web/package.json';

/** Each value of `flag` in a command line, `<flag> <value>` or `<flag>=<value>` (undefined when the value is missing). */
const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : a.startsWith(`${flag}=`) ? [a.slice(flag.length + 1)] : []));

/**
 * The lane a command line names, its first `--lane <lane>` or `--lane=<lane>` (commit when absent): the one parse the
 * CLI and the lane-runner reading share, so a script the reading credits with a lane runs that lane.
 */
export const laneArg = (args) => (flagValues(args, '--lane').length ? flagValues(args, '--lane')[0] : 'commit');
/** The families a command line names by `--family`, in order; empty for a lane run. */
export const familyArgs = (args) => flagValues(args, '--family');

/**
 * Whether a run of `lane`, or of the named `families` (ids, empty for a lane run), observes a family's loaded doc
 * (undefined for a table rule with no family, which is commit-lane). A named id with no family file throws.
 */
export function observer(lane, families, loaded) {
  const unknown = families.filter((id) => !loaded.has(id));
  if (unknown.length) throw new Error(`--family takes a family of policy/ratchets/: ${unknown.map(String).join(', ')} names none`);
  if (families.length) return (doc) => families.includes(doc?.family);
  return (doc) => lanesUpTo(lane).includes(doc?.lane ?? 'commit');
}

/** An environment assignment before a command's program (`CANOPI_SKIP_BUNDLED_DB=1`). */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/u;

/**
 * The commands of a script that is one pure `&&` chain, each as its words, or none when anything in it can discard a
 * command's exit status or run it as no command of its own: a pipe, `||`, `;`, `&`, a newline, a subshell, a command
 * substitution (inside quotes too, so `sh -c '...'` is no chain) or a `#` (a comment hides the rest). A redirection
 * keeps the status and is dropped.
 */
function pureChain(script) {
  if (/[|;`()\n#]|\$\(|(?<![&>])&(?![&>])/u.test(script.replaceAll('&&', ' ').replace(/\d*[<>]&\d+|&>>?/gu, ' '))) return [];
  return script.split('&&').map((command) => command.replace(/\d*[<>]&\d+|&>>?|\d*>>?|</gu, ' ').trim().split(/\s+/u));
}

/** A command's arguments to policy/check.mjs when its program, after env assignments, is the checker or `node` running it. */
function checkerArgs(words) {
  let at = words.findIndex((w) => !ENV_ASSIGNMENT.test(w));
  if (words[at] === 'node') at++;
  return words[at]?.endsWith('policy/check.mjs') ? words.slice(at + 1) : null;
}

/**
 * Each `<mode> <lane>` and `<mode> family:<id>` a script in LANE_RUNNERS runs (`check commit`, `self-test push`,
 * `check family:bundle-size`, ...): every checker command (checkerArgs) of a pure `&&` chain (pureChain) that only
 * checker commands precede, the lane and families read as the CLI reads them; another mode (--list-rules, --diff,
 * --phase-close) runs none. Any other command before it may end the shell with status 0 (`exit`, `exec`, `command
 * exit`, `eval exit`, a quoted or escaped `exit`, an expansion, a sourced file, ...), so the chain is credited no
 * further: an allowlist of the checker alone fails closed where a denylist of shell-ending spellings cannot. A checker
 * command whose status the script can discard is never credited, so a failing run always fails its script.
 */
function scriptRuns(root) {
  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, LANE_RUNNERS), 'utf8')).scripts ?? {};
  } catch {
    return new Set();
  }
  const runs = new Set();
  for (const script of Object.values(scripts)) {
    for (const words of pureChain(String(script))) {
      const args = checkerArgs(words);
      if (!args) break;
      if (args.some((a) => ['--list-rules', '--diff', '--phase-close'].includes(a))) continue;
      const mode = args.includes('--self-test') ? 'self-test' : 'check';
      const families = familyArgs(args);
      if (!families.length) runs.add(`${mode} ${laneArg(args)}`);
      for (const id of families) runs.add(`${mode} family:${id}`);
    }
  }
  return runs;
}

/**
 * Refuses each lane in use, by a family or by a planted case's `toolLane` under `casesRoot`, that no LANE_RUNNERS
 * script runs as both the check and the self-test: a later-lane family, planted rule or real-tool case would otherwise
 * pass every gate unrun while still covering its codes (2.1-M223). A later lane only families use is run, in a mode,
 * when scripts name each of its families by `--family` in that mode (2.1-M232).
 */
export function unrunLanes(root, families, casesRoot) {
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
  const runs = scriptRuns(root);
  const ran = (mode, lane) => runs.has(`${mode} ${lane}`)
    || (lane !== 'commit' && !caseLanes.has(lane) && byLane.get(lane).every((id) => runs.has(`${mode} family:${id}`)));
  return LANES.filter((l) => byLane.has(l) || caseLanes.has(l)).flatMap((l) => ['check', 'self-test'].filter((m) => !ran(m, l)).map((m) => ({
    code: 'lane-unrun',
    where: LANE_RUNNERS,
    message: `the ${l} lane is in use and no script runs \`node policy/check.mjs${m === 'self-test' ? ' --self-test' : ''}${l === 'commit' ? '' : ` --lane ${l}`}\`${l === 'commit' ? '' : ` or names each of its families by --family`}`,
  })));
}
