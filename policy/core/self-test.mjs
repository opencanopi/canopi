// policy/core/self-test.mjs: `check.mjs --self-test`'s planted cases (2.1-M348): every refusal and change has a case
// under policy/fixtures/check/<kind>/, each kind run by its runner, and the self-test fails a code with none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closedBeadCheck } from '../beads.mjs';
import { LANE_RUNNERS, LANES, lanesUpTo } from '../selection.mjs';
import { CASES_DIR, REPO_ROOT, RefusalError, RULES_TABLE, SCHEMA_FILE } from './base.mjs';
import { CHANGES, diffRatchets } from './diff.mjs';
import { exec, git, listFiles } from './exec.mjs';
import { loadGlobEngine, matchesGlob } from './globs.mjs';
import { checkPlanted, checkRepo, loadAdapter, observe, toolRefusal } from './observe.mjs';
import { compare, loadRatchets, REFUSALS, sameSet } from './ratchets.mjs';
import { listRules, NO_OWNER } from './tables.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Self-test: the planted cases

/** The rules table a case without one gets: one planned row, so it requires no family, planted violation or tool. */
const FIXTURE_RULES_TABLE = {
  version: 1,
  phases: ['later'],
  rules: [{ id: 'fixture-later', status: 'planned', owner_today: NO_OWNER, owner_target: { path: 'src/', phase: 'later' } }],
};

/** The lane runners a repo case without its own gets: the check and the self-test at every lane. */
const FIXTURE_LANE_RUNNERS = {
  name: 'fixture',
  scripts: Object.fromEntries(LANES.map((l) => [`policy:${l}`, `node policy/check.mjs --self-test --lane ${l} && node policy/check.mjs --lane ${l}`])),
};

/**
 * Writes a case's files into a new git work tree, every file staged as a checkout has them, then applies the
 * case's unstaged edits: `unstagedDeletes` (paths removed from disk only) and `unstagedMoves` ([from, to] on disk).
 * `copy` ({path: repository file}) adds real files, such as recorded source or the real adapters, beside `files`, and
 * `copyDirs` (repository directories) every file git tracks under each at the same path, so a case follows what a
 * real planted directory holds. A case without its own policy/rules.json gets FIXTURE_RULES_TABLE, and none with
 * `rulesTable: false`.
 */
function materialise(files, schemaOverride, kase = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-'));
  const all = { ...files };
  for (const dir of kase.copyDirs ?? []) {
    const tracked = git(REPO_ROOT, ['ls-files', '-z', '--', `${dir}/`]).split('\0').filter(Boolean);
    if (!tracked.length) throw new Error(`copyDirs: git tracks no file under ${dir}/`);
    for (const rel of tracked) all[rel] = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  }
  for (const [rel, from] of Object.entries(kase.copy ?? {})) all[rel] = fs.readFileSync(path.join(REPO_ROOT, from), 'utf8');
  if (schemaOverride === undefined) all[SCHEMA_FILE] = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_FILE), 'utf8');
  else if (schemaOverride !== false) all[SCHEMA_FILE] = schemaOverride;
  if (!(RULES_TABLE in all) && kase.rulesTable !== false) all[RULES_TABLE] = FIXTURE_RULES_TABLE;
  for (const [rel, content] of Object.entries(all)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  for (const gone of kase.unstagedDeletes ?? []) fs.rmSync(path.join(root, gone));
  for (const [from, to] of kase.unstagedMoves ?? []) fs.renameSync(path.join(root, from), path.join(root, to));
  return root;
}

/**
 * Runs `run` with the real tools building into `root`/target, so a case's planted crate never lands in a shared
 * target directory (`real` cases: the tool itself runs, nothing is replayed).
 */
async function inOwnTarget(root, run) {
  const saved = process.env.CARGO_TARGET_DIR;
  process.env.CARGO_TARGET_DIR = path.join(root, 'target');
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.CARGO_TARGET_DIR;
    else process.env.CARGO_TARGET_DIR = saved;
  }
}

/**
 * A budget adapter's observed values as `<key>=<value>` lines, a floor adapter's as `<key> <field>=<value>`; with
 * `familyFile`, that real family's refusals and whether it equals what was measured (`equal`, else `differs`): a
 * floor family's floors and patterns, a budget family's ceilings, as a reset writes them.
 */
async function measured(adapter, args, familyFile) {
  const observed = await adapter.measure(args);
  const lines = Object.entries(observed).flatMap(([key, got]) => (typeof got === 'number' ? [`${key}=${got}`] : [
    ...Object.entries(got.values ?? {}).map(([metric, v]) => `${key} ${metric}=${v}`),
    ...['include', 'exclude'].filter((f) => got[f] !== undefined).map((f) => `${key} ${f}=${JSON.stringify(got[f])}`),
  ]));
  if (!familyFile) return lines;
  const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, familyFile), 'utf8'));
  const held = doc.floors ?? doc.budgets;
  /** The values a held entry is compared with: a budget adapter measures one number, the ceiling a reset writes. */
  const values = (got) => (typeof got === 'number' ? { ceiling: got } : got.values ?? {});
  const same = Object.keys(held).length === Object.keys(observed).length && Object.entries(held).every(([key, h]) => key in observed
    && JSON.stringify(Object.entries(h.floors ?? { ceiling: h.ceiling }).sort()) === JSON.stringify(Object.entries(values(observed[key])).sort())
    && ['include', 'exclude'].every((f) => sameSet(h[f], observed[key][f])));
  return [...compare(doc, observed).map((r) => r.code), ...lines, same ? 'equal' : 'differs'];
}

const RUNNERS = {
  /** `matches` ([path, glob, expected]) through matchesGlob; `engineFrom: "empty"` loads the engine from a directory
   * with no packages installed. */
  glob(kase) {
    if (kase.engineFrom === 'empty') {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-glob-'));
      try {
        loadGlobEngine(base);
        return [];
      } catch (error) {
        if (error instanceof RefusalError) return [error.code];
        throw error;
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
    return (kase.matches ?? []).filter(([p, glob, want]) => matchesGlob(p, glob) !== want).map(([p, glob]) => `${p} ~ ${glob}`);
  },
  async diff(kase) {
    const root = materialise(kase.base ?? {});
    try {
      git(root, ['-c', 'user.name=policy', '-c', 'user.email=policy@localhost', 'commit', '-q', '--no-verify', '-m', 'base']);
      git(root, ['tag', 'base']);
      for (const [from, to] of kase.moves ?? []) {
        fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
        git(root, ['mv', from, to]);
      }
      for (const gone of kase.delete ?? []) git(root, ['rm', '-q', gone]);
      for (const [rel, content] of Object.entries(kase.head ?? {})) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
      }
      git(root, ['add', '-A']);
      if (kase.commitHead) git(root, ['-c', 'user.name=policy', '-c', 'user.email=policy@localhost', 'commit', '-q', '--no-verify', '-m', 'head']);
      // Base against HEAD when committed, the working tree when not.
      return (await diffRatchets(root, 'base', kase.commitHead ? 'HEAD' : undefined)).map((c) => c.change);
    } catch (error) {
      if (error instanceof RefusalError) return [error.code];
      throw error;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  rules(kase) {
    const root = materialise(kase.files ?? {}, kase.schema, kase);
    try {
      const { rules, refusals } = listRules(root);
      return refusals.length ? refusals.map((r) => r.code) : rules;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  compare(kase) {
    return compare(kase.doc, kase.observed).map((r) => r.code);
  },
  observe(kase) {
    const { observed, refusals } = observe(kase.doc, kase.sites);
    const counts = typeof observed === 'number' ? [`count=${observed}`] : Object.entries(observed).map(([k, n]) => `${k}=${n}`);
    return [...refusals.map((r) => r.code), ...counts];
  },
  /**
   * An adapter over recorded real output (`recorded`, or inline `stdout`, replayed with `status`), real recorded
   * source (`paths` under policy/fixtures/recorded/) or inline sources (`files`); with `family`, its refusals and
   * observed counts too.
   * Gives each distinct site as `<rule> @ <path> [<name>] -> <target> (refused) x<n>`, and with `showCommand` the
   * command run, relative to the repository. With `real`, the tool runs on the materialised files instead, with this
   * repository's installed tool binaries unless `tools: false`. With `message`, a thrown refusal gives its code only
   * if its message says that text, for a refusal whose code a different break would give too.
   */
  async adapters(kase) {
    const adapter = await loadAdapter(REPO_ROOT, kase.tool);
    const root = kase.files || kase.copy ? materialise(kase.files ?? {}, false, kase) : REPO_ROOT;
    const tools = kase.tools === false ? root : REPO_ROOT;
    const commands = [];
    const replay = (command, args) => {
      commands.push(`$ ${[path.isAbsolute(command) ? path.relative(root, command) : command, ...args].join(' ')}`);
      const stdout = kase.recorded ? fs.readFileSync(path.join(REPO_ROOT, kase.recorded), 'utf8') : kase.stdout ?? '';
      return { status: kase.status ?? 0, stdout, stderr: kase.stderr ?? '' };
    };
    try {
      const paths = kase.paths ?? Object.keys({ ...kase.files, ...kase.copy });
      const run = kase.real ? exec : replay;
      if (typeof adapter.measure === 'function') return await measured(adapter, { root, paths, exec: run, tools }, kase.familyFile);
      const sites = kase.real
        ? await inOwnTarget(root, () => adapter.collect({ root, paths, exec: run, tools }))
        : await adapter.collect({ root, paths, exec: run, tools });
      const counts = new Map();
      for (const s of sites) {
        const label = `${s.rule} @ ${s.path ?? ''}${s.name ? ` [${s.name}]` : ''}${s.target ? ` -> ${s.target}` : ''}${s.refused ? ' (refused)' : ''}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const held = kase.family ? observe(kase.family, sites, adapter.refuse) : { refusals: [], observed: {} };
      const refused = [...held.refusals.map((r) => r.code), ...Object.entries(held.observed).map(([k, n]) => `${k}=${n}`)];
      return [...refused, ...[...counts].map(([label, n]) => `${label} x${n}`), ...(kase.showCommand ? commands : [])];
    } catch (error) {
      const { code, message } = toolRefusal(error, kase.tool);
      return [kase.message === undefined || message.includes(kase.message) ? code : `${code} not saying "${kase.message}": ${message}`];
    } finally {
      if (root !== REPO_ROOT) fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /**
   * An adapter's markers() (upstream-register's pre-push exemptions, 2.1-M237) over the case's materialised files, each
   * `<path>:<line> <id>`, or a thrown refusal's code.
   */
  async markers(kase) {
    const adapter = await loadAdapter(REPO_ROOT, kase.tool);
    const root = materialise(kase.files ?? {}, false, kase);
    try {
      return adapter.markers({ root, paths: listFiles(root) }).map((m) => `${m.path}:${m.line} ${m.id}`);
    } catch (error) {
      return [toolRefusal(error, kase.tool).code];
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /**
   * A case without its own LANE_RUNNERS gets FIXTURE_LANE_RUNNERS, which runs every lane; `closedBeads` runs
   * `--closed-beads` (closedBeadCheck) instead of the default check.
   */
  async repo(kase) {
    const files = { ...kase.files };
    if (!(LANE_RUNNERS in files)) files[LANE_RUNNERS] = FIXTURE_LANE_RUNNERS;
    const root = materialise(files, kase.schema, kase);
    try {
      if (kase.closedBeads) return closedBeadCheck(root).map((r) => r.code);
      const check = () => checkRepo(root, kase.lane, { phaseClose: kase.phaseClose, families: kase.families });
      return (await (kase.real ? inOwnTarget(root, check) : check())).refusals.map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /** With `real`, the planted violations' real tools build into the case's own target directory. */
  async planted(kase) {
    const root = materialise(kase.files ?? {}, kase.schema, kase);
    try {
      const run = () => checkPlanted(root, kase.lane, kase.families);
      return (await (kase.real ? inOwnTarget(root, run) : run())).map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  /** The self-test itself over the cases in `cases` (`<kind>/<name>.json` -> case) at `lane`: `<status> <case>` per case. */
  async selftest(kase) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-cases-'));
    try {
      for (const [rel, inner] of Object.entries(kase.cases ?? {})) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), JSON.stringify(inner));
      }
      const lines = [];
      await runCases(dir, (line) => lines.push(line.split(/\s+/).slice(0, 2).join(' ').replace(/:$/, '')), kase.lane);
      return lines;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  load(kase) {
    const root = materialise(kase.files ?? {}, kase.schema, kase);
    try {
      return loadRatchets(root).refusals.map((r) => r.code);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
};

/**
 * Runs `run` as a git hook in a linked worktree would: GIT_DIR and GIT_INDEX_FILE name a decoy repository, and HOME
 * holds a git config that signs every commit and tag with a signer that always fails. Returns the failures: a
 * planted case that wrote into the caller's repository, or that a developer's signing config would break or stall.
 */
async function asGitHook(run) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canopi-policy-hook-'));
  const decoy = path.join(scratch, 'decoy');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n');
  git(scratch, ['init', '-q', decoy]);
  git(decoy, ['-c', 'user.name=decoy', '-c', 'user.email=decoy@localhost', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '--no-verify', '-m', 'decoy']);
  const state = () => `${git(decoy, ['for-each-ref'])}${git(decoy, ['ls-files', '-s'])}`;
  const before = state();
  const saved = Object.fromEntries(['GIT_DIR', 'GIT_INDEX_FILE', 'HOME', 'RUSTUP_HOME', 'CARGO_HOME'].map((k) => [k, process.env[k]]));
  // The real toolchain stays where the developer's home has it: only git's config moves.
  const realHome = os.homedir();
  Object.assign(process.env, {
    GIT_DIR: path.join(decoy, '.git'), GIT_INDEX_FILE: path.join(decoy, '.git', 'index'), HOME: home,
    RUSTUP_HOME: saved.RUSTUP_HOME ?? path.join(realHome, '.rustup'), CARGO_HOME: saved.CARGO_HOME ?? path.join(realHome, '.cargo'),
  });
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const failures = state() === before ? [] : ['the planted cases wrote into the calling repository'];
  fs.rmSync(scratch, { recursive: true, force: true });
  return failures;
}

/**
 * Runs every planted case (none for named `only` families) and the planted violations of the rules observed (in the
 * lanes up to `lane`, or the named families); returns { failures, missing }, missing the codes with no case in any lane.
 */
export async function selfTest(casesRoot = path.join(REPO_ROOT, CASES_DIR), log = () => {}, lane = 'commit', only = []) {
  let result = { failures: [], missing: [] };
  const leaks = only.length ? [] : await asGitHook(async () => { result = await runCases(casesRoot, log, lane); });
  for (const leak of leaks) log(`FAIL ${leak}`);
  const silent = (await checkPlanted(REPO_ROOT, lane, only)).map((r) => `${r.code}: ${r.where}: ${r.message}`);
  for (const line of silent) log(`FAIL planted ${line}`);
  if (!silent.length) log('ok   planted violations of this repository fire');
  return { failures: [...result.failures, ...leaks, ...silent], missing: result.missing };
}

/**
 * Runs the cases under `casesRoot`, skipping one whose `toolLane` (the lane whose environment its real tools need, such
 * as push for a Rust toolchain; commit when absent) is past `lane`; a skipped case still counts as its codes' case.
 */
export async function runCases(casesRoot, log, lane = 'commit') {
  const failures = [];
  const covered = new Set();
  const strays = fs.existsSync(casesRoot) ? fs.readdirSync(casesRoot).filter((d) => !(d in RUNNERS)) : [];
  for (const stray of strays) {
    log(`FAIL ${stray}: not a case kind (${Object.keys(RUNNERS).join(', ')})`);
    failures.push(stray);
  }
  for (const kind of Object.keys(RUNNERS)) {
    const dir = path.join(casesRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) {
        log(`FAIL ${kind}/${name}: a case is a .json file`);
        failures.push(`${kind}/${name}`);
        continue;
      }
      const kase = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const expected = [...new Set(kase.expect)].sort();
      expected.forEach((code) => covered.add(code));
      if (!LANES.includes(kase.toolLane ?? 'commit')) {
        log(`FAIL ${kind}/${name}: toolLane takes ${LANES.join(', ')}`);
        failures.push(`${kind}/${name}`);
        continue;
      }
      if (!lanesUpTo(lane).includes(kase.toolLane ?? 'commit')) {
        log(`skip ${kind}/${name}: its tools need the ${kase.toolLane} lane (--self-test --lane ${kase.toolLane})`);
        continue;
      }
      let got;
      try {
        got = [...new Set(await RUNNERS[kind](kase))].sort();
      } catch (error) {
        got = [`threw: ${error.message}`];
      }
      const ok = JSON.stringify(got) === JSON.stringify(expected);
      log(`${ok ? 'ok  ' : 'FAIL'} ${kind}/${name}${ok ? '' : `: expected [${expected}], got [${got}]`}`);
      if (!ok) failures.push(`${kind}/${name}`);
    }
  }
  const missing = [...Object.keys(REFUSALS), ...Object.keys(CHANGES)].filter((code) => !covered.has(code));
  return { failures, missing };
}
