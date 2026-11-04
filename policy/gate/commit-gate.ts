// policy/gate/commit-gate.ts: the commit gate the tracked hooks in .githooks and CI's Commit gate job run (2.1-M14,
// 2.1-M195 to 2.1-M199, 2.1-M228, 2.1-M229, 2.1-Q224, 2.1-Q225, 2.1-Q267; contracts §12; ADR 0028 Agent enforcement), a
// mode of the gate's entry:
//
//   node policy/gate/cli.mjs commit-gate pre-commit            the staged change's commit lane (`affected --staged`)
//   node policy/gate/cli.mjs commit-gate pre-merge-commit      a merge's commit lane, as pre-commit
//   node policy/gate/cli.mjs commit-gate commit-msg <file>     the message and diff rules on the index tree
//   node policy/gate/cli.mjs commit-gate pr <base> <head> [--body-file <f>] [--vitest]
//                                                              every commit of base..head with this (the head's) gate
//   node policy/gate/cli.mjs commit-gate tree <before> <after> a push to main: each first-parent commit names its PR
//   node policy/gate/cli.mjs commit-gate planted <dir>...      each policy/fixtures/rules/<rule>/case.json, in a
//                                                              temporary repository: one JSON line {file, rules} each
//
// Exit 0 green, 1 red or refused, 2 usage, 130 interrupted. A commit is judged from files only, never gh, bd or the
// network (2.1-M197): its family changes come from policy/core/diff.mjs's diffRatchets in process, its rules from
// commit-gate-judge.ts and its tests from deletion-guard.ts; an attribution trailer or footer, or the tool's name, in a
// message or PR body is refused (gate-no-attribution). A bead is open when any committed .beads/issues.jsonl of the
// change's range holds it open, so local and CI give one verdict: pr mode reads every commit of base..head; commit-msg
// reads the staged tree, the branch's commits since merge-base(HEAD, origin/main) and the integration tip
// (branch.<branch>.canopiIntegration). The working tree is never read. Q rows come from docs/decisions/*.md at the
// merge base (ledger.ts). A merge is judged on what differs from every parent (--cc). An amend is read from the
// committing git's argv (/proc); where that is unreadable the commit is judged against HEAD and HEAD^ and the stricter
// verdict holds. Every commit of a pr range is judged (design check A3): no commit is before the gate.
//
// Failure states, each a one-line refusal: a held index.lock outside a hook (busy); a shallow clone missing a commit
// of the range, or a blob it names (unreadable: fetch the whole range); a missing desktop/web install where a TS test
// or the Vitest pass needs it (npm ci); SIGINT (interrupted, exit 130, nothing written).
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { citesInText } from '../beads.mjs'
import { LAYER_TABLE, RefusalError } from '../core/base.mjs'
import { diffRatchets } from '../core/diff.mjs'
import { openGitReader } from '../git.mjs'
import {
  Authority, FLAKES, type FamilyChange, judgeCitations, judgeDemotions, judgeFamilies, judgeGuarded, type LoadJson, qRowsOf,
  RATCHETS,
} from './commit-gate-judge.ts'
import { type Change, deletedCode, judge as judgeTests, RETIRES } from './deletion-guard.ts'
import { type RangeCommit, vitestPass } from './deletion-guard-vitest.ts'
import { splitLines } from './ledger.ts'
import { TABLE } from './table.ts'
import { type Finding, GuardRefusal, isTestFile } from './test-reader.ts'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const ATTRIBUTION = /(?<![\p{L}\p{N}_])Claude(?![\p{L}\p{N}_])|noreply@anthropic\.com/gu
const PR_SUBJECT = /\(#\d+\)\s*$|^Merge pull request #\d+ /u
/**
 * The gate's own files (2.1-M228), listed when a commit changes them: the table's policyGate rule (all of policy/,
 * the hooks and the workflow), tests aside.
 */
const GATE_RULE = new RegExp(TABLE.paths.policyGate)
const isGateFile = (path: string) => GATE_RULE.test(path) && !/\.test\.[cm]?[jt]sx?$/u.test(path)
/** The case files a planted repository leaves out of what it copies: the cases themselves. */
const PLANTED_SKIP = 'policy/fixtures'

/** A git query the gate depends on failed: the commit is refused, never read as passing. */
class GitFailed extends Error {}

const usage = `usage: node policy/gate/cli.mjs commit-gate pre-commit | pre-merge-commit
       node policy/gate/cli.mjs commit-gate commit-msg <file>
       node policy/gate/cli.mjs commit-gate pr <base> <head> [--body-file <file>] [--vitest]
       node policy/gate/cli.mjs commit-gate tree <before> <after>
       node policy/gate/cli.mjs commit-gate planted <dir>...`

/** git's environment: no GIT_* but a hook's GIT_INDEX_FILE (absolute), and no optional lock taken. */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')))
  const index = env['GIT_INDEX_FILE']
  if (index) clean['GIT_INDEX_FILE'] = isAbsolute(index) ? index : resolve(index)
  clean['GIT_OPTIONAL_LOCKS'] = '0'
  return clean
}

/** The repository the gate reads: git, file text at a revision through one batch reader, parsed JSON. */
class Repo {
  readonly root: string
  readonly env: NodeJS.ProcessEnv
  /** policy/git.mjs's batch reader. */
  readonly reader: { blob(id: string): Promise<string>, close(): void }
  private readonly json = new Map<string, Promise<unknown>>()

  constructor(root: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = root
    this.env = env
    this.reader = openGitReader(root) as unknown as Repo['reader']
  }

  run(args: readonly string[], input?: string) {
    return spawnSync('git', args, { cwd: this.root, encoding: 'utf8', env: gitEnv(this.env), input, maxBuffer: 256 * 1024 * 1024 })
  }

  ok(args: readonly string[], input?: string): string {
    const run = this.run(args, input)
    if (run.error) throw new GitFailed(`git ${args.join(' ')} failed: ${run.error.message}`)
    if (run.status !== 0) throw new GitFailed(`git ${args.join(' ')} failed: ${run.stderr.trim()}`)
    return run.stdout
  }

  /** A full commit id, or undefined when `rev` names none. */
  verify(rev: string): string | undefined {
    const run = this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    return run.status === 0 ? run.stdout.trim() : undefined
  }

  /**
   * A file's text at a revision (a commit or tree id), undefined when its tree has no such path. cat-file answers
   * `missing` alike for an absent path and an object not fetched, so the tree decides: a path it lists, or a tree it
   * cannot read, is refused as unreadable, never judged as absent.
   */
  async show(rev: string, path: string): Promise<string | undefined> {
    try {
      return await this.reader.blob(`${rev}:${path}`)
    } catch (error) {
      if ((error as { code?: string }).code !== 'missing-object') throw error
      const listed = this.run(['ls-tree', '-z', '--name-only', rev, '--', path])
      if (listed.status === 0 && listed.stdout === '') return undefined
      throw new GitFailed(`${rev.slice(0, 9)}:${path} is not readable, an object of the range not fetched: fetch the whole `
        + 'range (actions/checkout fetch-depth: 0, or git fetch --unshallow)')
    }
  }

  readonly load: LoadJson = (rev, path) => {
    const key = `${rev}:${path}`
    let value = this.json.get(key)
    if (!value) {
      value = this.show(rev, path).then((text) => {
        try {
          return text ? JSON.parse(text) as unknown : undefined
        } catch {
          return undefined
        }
      })
      this.json.set(key, value)
    }
    return value
  }

  private readonly changes = new Map<string, Change[]>()

  /** [status, old path, new path] with git -M renames (each pair read once). */
  changed(from: string, to: string): Change[] {
    const key = `${from}..${to}`
    let found = this.changes.get(key)
    if (!found) {
      found = this.readChanged(from, to)
      this.changes.set(key, found)
    }
    return found
  }

  private readChanged(from: string, to: string): Change[] {
    const parts = this.ok(['diff', '-M', '--name-status', '-z', from, to]).split('\0')
    const out: Change[] = []
    for (let i = 0; i < parts.length && parts[i];) {
      const status = (parts[i] ?? '')[0] ?? ''
      if (status === 'R' || status === 'C') {
        out.push([status, parts[i + 1] ?? '', parts[i + 2] ?? ''])
        i += 3
      } else {
        out.push([status, parts[i + 1] ?? '', parts[i + 1] ?? ''])
        i += 2
      }
    }
    return out
  }

  /** The module names under scripts/ at `rev`: what a Python test imports from repository code (design check A11). */
  pyModules(rev: string): Set<string> {
    const names = this.ok(['ls-tree', '--name-only', '-z', rev, '--', 'scripts/']).split('\0').filter(Boolean)
    return new Set(names.map((name) => name.slice('scripts/'.length).replace(/\.py$/u, '')))
  }

  /** The distinct .beads/issues.jsonl blobs of `revs`, in order, read by one git process (2.1-M197). */
  beadBlobs(revs: readonly string[]): string[] {
    if (!revs.length) return []
    const out = this.ok(['cat-file', '--batch-check=%(objectname) %(objecttype)'], revs.map((rev) => `${rev}:.beads/issues.jsonl\n`).join(''))
    return [...new Set(splitLines(out).filter((line) => line.endsWith(' blob')).map((line) => line.split(' ')[0] ?? ''))]
  }

  /** The Q rows of every docs/decisions/*.md at `rev`. */
  async qRows(rev: string): Promise<Set<string>> {
    const names = this.ok(['ls-tree', '-z', '--name-only', rev, '--', 'docs/decisions/']).split('\0')
      .filter((name) => name.endsWith('.md')).sort()
    const texts: string[] = []
    for (const name of names) texts.push((await this.show(rev, name)) ?? '')
    return qRowsOf(texts)
  }

  async authority(mergeBase: string, sources: readonly string[]): Promise<Authority> {
    return new Authority(mergeBase, await this.qRows(mergeBase), sources, (id) => this.reader.blob(id))
  }
}

const slice60 = (text: string) => [...text].slice(0, 60).join('')
const report = (label: string, findings: readonly Finding[]) => {
  for (const [rule, text] of findings) process.stdout.write(`${label}: ${rule}: ${text}\n`)
  return findings.length > 0
}

/** Findings for a commit of `tree` over `parents` (a merge judged on what differs from every one). */
async function judge(repo: Repo, parentsIn: readonly string[], tree: string, message: string, auth: Authority): Promise<Finding[]> {
  const parents = parentsIn.length ? parentsIn : [EMPTY_TREE]
  const first = parents[0] ?? EMPTY_TREE
  // diffRatchets names a change only where a family file changed, and refuses a layer table it cannot read: a diff
  // touching neither skips it.
  const families = async (from: string) => repo.changed(from, tree)
    .some(([, old, now]) => [old, now].some((path) => path.startsWith(`${RATCHETS}/`) || path === LAYER_TABLE))
    ? await diffRatchets(repo.root, from, tree) as FamilyChange[] : []
  let changes = await families(first)
  let files = repo.changed(first, tree)
  for (const other of parents.slice(1)) {
    const same = (c: FamilyChange) => `${c.family}\0${c.key ?? ''}`
    const theirs = new Set((changes.length ? await families(other) : []).map(same))
    changes = changes.filter((c) => theirs.has(same(c)))
    const touched = new Set(repo.changed(other, tree).flatMap(([, old, now]) => [old, now]))
    files = files.filter(([, old, now]) => touched.has(old) || touched.has(now))
  }
  const findings: Finding[] = [...message.matchAll(ATTRIBUTION)].slice(0, 1).map((match): Finding => ['gate-no-attribution',
    `the message names '${match[0]}': no attribution trailer, footer or tool name (AGENTS.md Commits; 2.1-M230)`])
  const paths = new Set(files.flatMap(([, old, now]) => [old, now]))
  findings.push(...await judgeFamilies(first, tree, message, auth, changes, files, repo.load))
  findings.push(...await judgeGuarded(first, message, auth, changes, files, repo.load))
  findings.push(...await judgeDemotions(first, tree, message, auth, paths, repo.load))
  const citing = []
  for (const [status, old, now] of files) {
    if (status === 'D' || !citesInText(now)) continue
    citing.push([now, status === 'A' ? '' : (await repo.show(first, old)) ?? '', (await repo.show(tree, now)) ?? ''] as const)
  }
  findings.push(...await judgeCitations(citing, auth))
  const tests = files.filter(([, old, now]) => isTestFile(old) || isTestFile(now))
  if (!tests.length) return findings
  const quarantined = new Map<string, string>()
  for (const change of changes) {
    if (change.family !== FLAKES || (change.change !== 'added' && change.change !== 'raised') || change.key === undefined) continue
    const doc = await repo.load(tree, `${RATCHETS}/${FLAKES}.json`) as { entries?: Record<string, { bead?: string }> } | undefined
    const bead = doc?.entries?.[change.key]?.bead
    if (bead && await auth.owned(bead)) quarantined.set(change.key, bead)
  }
  const contents = []
  for (const [status, old, now] of tests) {
    const was = status === 'A' ? undefined : old
    const is = status === 'D' ? undefined : now
    contents.push([was, is, was ? (await repo.show(first, was)) ?? '' : '', is ? (await repo.show(tree, is)) ?? '' : ''] as const)
  }
  const retires = new RegExp(RETIRES.source, 'mu').test(message)
  const read = (path: string) => repo.show(first, path)
  findings.push(...await judgeTests(contents, message, {
    authorised: auth.citesQ(message),
    deletedCode: retires ? await deletedCode(files, read, (path) => repo.show(tree, path)) : new Map(),
    quarantined, beadOpen: (bead) => auth.beadOpen(bead), read,
    pyModules: retires && first !== EMPTY_TREE ? repo.pyModules(first) : new Set(),
  }))
  return findings
}

/** The committing git's argv says --amend (git takes `--am` as its prefix): true or false, undefined when unreadable. */
function amending(): boolean | undefined {
  // The entry may have run the gate again on the engines Node, so the committing git is the nearest non-node ancestor.
  let pid = process.ppid
  for (let depth = 0; depth < 4; depth += 1) {
    let argv: string[]
    let parent: number
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      parent = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+\S+\s+/su, '').split(' ')[0])
    } catch {
      return undefined
    }
    if (!/(^|\/)node[\d.]*$/u.test(argv[0] ?? '')) return argv.some((arg) => arg.length >= 4 && '--amend'.startsWith(arg))
    pid = parent
  }
  return undefined
}

/** The local integration tip (branch.<branch>.canopiIntegration), or undefined. */
function integrationTip(repo: Repo): string | undefined {
  const branch = repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim()
  const tip = branch ? repo.run(['config', '--get', `branch.${branch}.canopiIntegration`]).stdout.trim() : ''
  return tip ? repo.verify(tip) : undefined
}

const SCISSORS = / -{24} >8 -{24}$/u

/**
 * The message git will store from the hook's file, as its cleanup leaves it: everything from a scissors line on (a
 * verbose commit's diff) and every comment line dropped. The comment prefix is core.commentString or core.commentChar,
 * '#' when unset; with `auto` it is the one the scissors line carries, else '#'.
 */
function messageText(repo: Repo, text: string): string {
  const lines = splitLines(text)
  const configured = ['core.commentString', 'core.commentChar']
    .map((key) => repo.run(['config', '--get', key]).stdout.replace(/\n$/u, '')).find(Boolean)
  const fromScissors = lines.find((line) => SCISSORS.test(line))?.replace(SCISSORS, '')
  const comment = configured && configured !== 'auto' ? configured : fromScissors || '#'
  const cut = lines.indexOf(`${comment} ------------------------ >8 ------------------------`)
  return (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !line.startsWith(comment)).join('\n')
}

async function commitMsg(repo: Repo, file: string): Promise<number> {
  if (!repo.env['GIT_INDEX_FILE']) {
    const lock = repo.ok(['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']).trim()
    if (existsSync(lock)) {
      throw new GitFailed(`the index is locked (${lock} exists): another git command, a concurrent commit or checkout, `
        + 'is writing it; the gate judges no half-written index, so run it again when that ends')
    }
  }
  const message = messageText(repo, readFileSync(file, 'utf8'))
  const tree = repo.ok(['write-tree']).trim()
  const head = repo.verify('HEAD')
  const merging = repo.verify('MERGE_HEAD')
  const base = repo.ok(['merge-base', head ?? 'origin/main', 'origin/main']).trim()
  const branch = head ? repo.ok(['rev-list', `${base}..${head}`]).split(/\s+/u).filter(Boolean) : []
  const tip = integrationTip(repo)
  const auth = await repo.authority(base, repo.beadBlobs([tree, ...branch, ...(tip ? [tip] : [])]))
  let candidates: string[][]
  if (merging && head) candidates = [[head, ...repo.ok(['rev-parse', 'MERGE_HEAD']).split(/\s+/u).filter(Boolean)]]
  else if (!head) candidates = [[]]
  else {
    const before = repo.verify(`${head}^`)
    const amend = amending()
    candidates = amend ? [before ? [before] : []] : amend === false ? [[head]] : [[head], before ? [before] : []]
  }
  const findings: Finding[] = []
  for (const parents of candidates) {
    for (const finding of await judge(repo, parents, tree, message, auth)) {
      if (!findings.some(([rule, text]) => rule === finding[0] && text === finding[1])) findings.push(finding)
    }
  }
  if (report('commit gate', findings)) {
    process.stderr.write('commit gate: refused; fix the commit or its message (the rules: policy/gate/commit-gate.ts)\n')
    return 1
  }
  return 0
}

/** Refuses a range a shallow clone cannot judge: a commit of it, or a parent it needs, is not fetched. */
function refuseShallow(repo: Repo, ends: readonly string[], revs: readonly string[]): void {
  const file = repo.ok(['rev-parse', '--path-format=absolute', '--git-path', 'shallow']).trim()
  if (!existsSync(file)) return
  const missing = ends.find((rev) => !repo.verify(rev))
  if (missing) {
    throw new GitFailed(`the clone is shallow and lacks ${missing}: fetch the whole range (actions/checkout fetch-depth: 0, `
      + 'or git fetch --unshallow)')
  }
  const boundary = new Set(splitLines(readFileSync(file, 'utf8')))
  const cut = revs.find((rev) => boundary.has(rev))
  if (cut) {
    throw new GitFailed(`the clone is shallow at ${cut.slice(0, 9)}, a commit of the range, so its parent is not fetched: `
      + 'fetch the whole range (actions/checkout fetch-depth: 0, or git fetch --unshallow)')
  }
}

async function pr(repo: Repo, base: string, head: string, bodyFile: string | undefined, withVitest: boolean): Promise<number> {
  refuseShallow(repo, [base, head], [])
  // One read of every commit of the range: id, parents, subject and message.
  const commits = repo.ok(['log', '--reverse', '--topo-order', '--format=%H%x1f%P%x1f%s%x1f%B%x1e', `${base}..${head}`])
    .split('\x1e').map((record) => record.replace(/^\n/u, '')).filter(Boolean).map((record) => {
      const [rev = '', parents = '', subject = '', message = ''] = record.split('\x1f')
      return { rev, parents: parents.split(' ').filter(Boolean), subject, message }
    })
  const revs = commits.map(({ rev }) => rev)
  // Before the merge base, which a range cut by a shallow boundary has none of.
  refuseShallow(repo, [], revs)
  const mergeBase = repo.ok(['merge-base', base, head]).trim()
  // A long range takes minutes; say what runs, on stderr so the report on stdout stays the gate's verdict.
  process.stderr.write(`commit gate: judging ${revs.length} commit(s) of ${base}..${head}\n`)
  const auth = await repo.authority(mergeBase, repo.beadBlobs(revs))
  let failed = false
  if (bodyFile) {
    const body = readFileSync(bodyFile, 'utf8')
    failed = report('PR body', [...body.matchAll(ATTRIBUTION)].slice(0, 1).map((m): Finding => ['gate-no-attribution', `names '${m[0]}'`])) || failed
  }
  const gateChanges: string[] = []
  const judged: RangeCommit[] = []
  for (const { rev, parents, subject, message } of commits) {
    const label = `${rev.slice(0, 9)} ${slice60(subject.trim())}`
    judged.push({ rev, parent: parents[0] ?? EMPTY_TREE, message })
    if (repo.changed(parents[0] ?? EMPTY_TREE, rev).some(([, old, now]) => isGateFile(old) || isGateFile(now))) {
      gateChanges.push(label)
    }
    failed = report(label, await judge(repo, parents, rev, message, auth)) || failed
  }
  if (withVitest) {
    const { findings, notes } = await vitestPass(repo, mergeBase, head, judged, (message) => auth.citesQ(message))
    for (const note of notes) process.stdout.write(`${note}\n`)
    failed = report('vitest list', findings) || failed
  }
  for (const label of gateChanges) process.stdout.write(`changes the gate's own files: ${label}\n`)
  process.stdout.write(`commit gate: ${revs.length} commit(s): ${failed ? 'RED' : 'OK'}\n`)
  return failed ? 1 : 0
}

function treeMode(repo: Repo, before: string, after: string): number {
  let failed = false
  let rev = ''
  for (const line of splitLines(repo.ok(['rev-list', '--first-parent', '--reverse', '--format=%s', `${before}..${after}`]))) {
    if (line.startsWith('commit ')) {
      rev = line.split(' ')[1] ?? ''
      continue
    }
    if (!PR_SUBJECT.test(line)) {
      failed = report(`${rev.slice(0, 9)} ${slice60(line)}`, [['gate-squash-subject', 'names no PR ((#NN) or Merge pull request '
        + '#NN): not checked by a PR (2.1-M228)']]) || failed
    }
  }
  process.stdout.write(`commit gate tree: ${failed ? 'RED' : 'OK'}\n`)
  return failed ? 1 : 0
}

/** A planted case: base files, head files and a message; `mode: tree` for a push to main. */
interface PlantedCase {
  readonly base?: Record<string, unknown>
  readonly head?: Record<string, unknown>
  readonly message: string
  readonly mode?: string
}

/**
 * Each planted case judged by the real gate in a temporary repository outside the calling tree, holding this
 * checkout's policy/ (its cases aside; a relative case path is read from `root`), its engines manifest and its desktop/web install (both excluded from the
 * case's commits): {file, rules} per case, the rules each a gate rule the gate's output names. The gate runs through
 * its entry, so on an older Node it runs on the engines Node too.
 */
export function planted(root: string, cases: readonly string[]): { file: string, rules: string[] }[] {
  const out: { file: string, rules: string[] }[] = []
  for (const name of cases) {
    const path = resolve(root, name)
    const caseFile = existsSync(join(path, 'case.json')) ? join(path, 'case.json') : path
    const kase = JSON.parse(readFileSync(caseFile, 'utf8')) as PlantedCase
    const scratch = mkdtempSync(join(tmpdir(), 'canopi-gate-planted-'))
    try {
      const repo = join(scratch, 'repo')
      cpSync(join(root, 'policy'), join(repo, 'policy'), {
        recursive: true, filter: (source) => !source.startsWith(join(root, PLANTED_SKIP)),
      })
      mkdirSync(join(repo, 'desktop/web'), { recursive: true })
      writeFileSync(join(repo, 'desktop/web/package.json'), readFileSync(join(root, 'desktop/web/package.json')))
      if (existsSync(join(root, 'desktop/web/node_modules'))) symlinkSync(join(root, 'desktop/web/node_modules'), join(repo, 'desktop/web/node_modules'))
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
      Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITHUB_ACTIONS: 'true' })
      const git = (...args: string[]) => {
        const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=planted', '-c',
          'user.email=planted@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' })
        if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo}: ${run.stderr.trim()}`)
        return run.stdout.trim()
      }
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, '.git/info/exclude'), 'desktop/web/package.json\ndesktop/web/node_modules\n')
      const revs: string[] = []
      for (const [files, message] of [[kase.base ?? {}, 'chore: base'], [kase.head ?? {}, kase.message]] as const) {
        for (const [path, text] of Object.entries(files)) {
          const target = join(repo, path)
          if (text === null) {
            rmSync(target)
            continue
          }
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`)
        }
        git('add', '-A')
        git('commit', '-q', '--allow-empty', '-m', message)
        revs.push(git('rev-parse', 'HEAD'))
      }
      const run = spawnSync(process.execPath, ['policy/gate/cli.mjs', 'commit-gate', kase.mode ?? 'pr', ...revs], {
        cwd: repo, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      })
      if (run.status !== 0 && run.status !== 1) throw new Error(`${caseFile}: the gate exited ${run.status}: ${run.stderr.trim()}`)
      out.push({ file: name, rules: [...new Set([...run.stdout.matchAll(/: (gate-[a-z-]+): /gu)].map((m) => m[1] ?? ''))].sort() })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return out
}

/** The commit gate's exit code for `args` (after `commit-gate`) in the repository at `root`. */
export async function commitGate(root: string, args: readonly string[]): Promise<number> {
  const [mode, ...rest] = args
  const repo = new Repo(root)
  const interrupted = () => {
    process.stderr.write('commit gate: interrupted; nothing was written\n')
    process.exit(130)
  }
  process.once('SIGINT', interrupted)
  try {
    if (mode === 'commit-msg' && rest.length === 1 && rest[0]) return await commitMsg(repo, rest[0])
    if (mode === 'pr' && rest.length >= 2) {
      const [base = '', head = '', ...flags] = rest
      const at = flags.indexOf('--body-file')
      const known = flags.every((flag, i) => flag === '--vitest' || flag === '--body-file' || (at !== -1 && i === at + 1))
      if (known && (at === -1 || flags[at + 1] !== undefined)) return await pr(repo, base, head, at === -1 ? undefined : flags[at + 1], flags.includes('--vitest'))
    }
    if (mode === 'tree' && rest.length === 2) return treeMode(repo, rest[0] ?? '', rest[1] ?? '')
    if (mode === 'planted' && rest.length) {
      for (const result of planted(root, rest.map((name) => resolve(name)))) process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
  } catch (error) {
    const known = error instanceof GitFailed || error instanceof GuardRefusal || error instanceof RefusalError
    const failure = error as NodeJS.ErrnoException
    const missing = failure.code === 'missing-object' || failure.code === 'cat-file-exited'
    const why = known ? failure.message
      : missing ? `${failure.message}: an object of the range is not fetched; fetch the whole range (fetch-depth: 0)`
        : failure.syscall ? `${failure.message}${failure.path && !failure.message.includes(failure.path) ? `: ${failure.path}` : ''}`
          : failure.message
    process.stderr.write(`commit gate: ${why}; refusing${error instanceof GitFailed ? ' (fetch origin/main if it is missing)' : ''}\n`)
    return 1
  } finally {
    process.removeListener('SIGINT', interrupted)
    repo.reader.close()
  }
  process.stderr.write(`${usage}\n`)
  return 2
}
