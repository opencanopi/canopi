// policy/gate/deletion-guard-vitest.ts: the deletion guard's Vitest pass (2.1-M199, 2.1-Q224, 2.1-Q267), which CI's
// Commit gate job runs with `pr --vitest`. Vitest titles (.each rows, template literals) lost between the merge base and
// head are read by `vitest list --staticParse=false` on each revision's whole tree (a test may read any file of it at
// collection), linking the checkout's node_modules: the base lists each test file deleted, changed or renamed (its old
// path), the head each one changed, renamed or added, so a move into any file passes. A file either side cannot list is
// named in a note and left to the per-commit reading, never counted as lost. A lost title
// needs a route in a commit that touched its file, judged by the deletion guard's one loss router (routeLoss,
// canopi-f47t.52.228.51): that commit cites a merge-base Q row; names it in Retires-test with the code under test
// deleted, or a test of documentation only (M329); rewords it (Rewords-test) to a title it adds in the same file with
// no fewer assertions, or folds it into a title kept there that grows by its assertions (M330); or quotes a title it
// adds (its own file first), with no fewer assertions. The last two need a commit that dropped the title, so one that only
// edited its file never spends its added titles on it (canopi-f47t.52.240). Every commit of the range is judged: none is
// before the gate.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { type Change, deletedCode, type Loss, RETIRES, REWORDS, type Route, type Routed, routeLoss } from './deletion-guard.ts'
import { strip } from './ledger.ts'
import { TABLE } from './table.ts'
import { asserts, bodiesFor, byCodePoint, type Finding, GuardRefusal, quoted, type Read } from './test-reader.ts'

/** What the pass reads of the repository: git -M changes and files at a revision. */
export interface RangeGit {
  readonly root: string
  changed(from: string, to: string): Change[]
  show(rev: string, path: string): Promise<string | undefined>
}

/** A commit of the range: its id, first parent and message. */
export interface RangeCommit {
  readonly rev: string
  readonly parent: string
  readonly message: string
}

type Listed = readonly [name: string, file: string]
const WEB = 'desktop/web'
const WEB_TEST = new RegExp(TABLE.paths.webVitestTest, 'u')

const lastPart = (name: string) => name.split(' > ').at(-1) ?? name
const tally = (names: readonly Listed[]) => {
  const counts = new Map<string, number>()
  for (const [name] of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

/** ([full test name, file relative to `web`] across `files`, the files vitest could not list): one run, then one each. */
function vitestTitles(web: string, files: readonly string[], out: string): [Listed[], string[]] {
  const listed = (batch: readonly string[]): Listed[] | undefined => {
    const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--staticParse=false', `--json=${out}`, ...batch],
      { cwd: web, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (run.status !== 0 || !existsSync(out)) return undefined
    const real = realpathSync(web)
    const names = (JSON.parse(readFileSync(out, 'utf8')) as { name: string, file: string }[])
      .map((entry): Listed => [entry.name, relative(real, entry.file).split('\\').join('/')])
    rmSync(out)
    return names
  }
  if (!files.length) return [[], []]
  const all = listed(files)
  if (all) return [all, []]
  const names: Listed[] = []
  const unread: string[] = []
  for (const file of files) {
    const one = listed([file])
    if (one) names.push(...one)
    else unread.push(file)
  }
  return [names, unread]
}

/** (old paths, new paths, old -> new) of the web Vitest project's test files in `changes` (TABLE.paths.webVitestTest,
 * either side of a rename), relative to desktop/web. */
export function webTests(changes: readonly Change[]): [string[], string[], Map<string, string>] {
  const oldFiles: string[] = []
  const newFiles: string[] = []
  const renamed = new Map<string, string>()
  for (const [status, old, now] of changes) {
    const wasTest = status !== 'A' && WEB_TEST.test(old)
    const isTest = status !== 'D' && WEB_TEST.test(now)
    if (!wasTest && !isTest) continue
    if (wasTest) oldFiles.push(old.slice(WEB.length + 1))
    if (isTest) newFiles.push(now.slice(WEB.length + 1))
    renamed.set(old, now)
  }
  return [oldFiles, newFiles, renamed]
}

/** vitestTitles of `files` in `rev`'s tree, its node_modules the checkout's; a missing install refuses naming npm ci. */
function listedAt(root: string, rev: string, files: readonly string[]): [Listed[], string[]] {
  const modules = join(root, WEB, 'node_modules')
  if (!existsSync(join(modules, 'vitest/vitest.mjs'))) {
    throw new GuardRefusal(`${WEB}/node_modules/vitest is missing for the Vitest pass: run npm ci in ${WEB}`)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'canopi-gate-vitest-'))
  try {
    if (spawnSync('git', ['cat-file', '-e', `${rev}:${WEB}`], { cwd: root }).status !== 0) return [[], [...files]]
    const archive = spawnSync('git', ['archive', rev], { cwd: root, maxBuffer: 1024 * 1024 * 1024 })
    if (archive.status !== 0) throw new GuardRefusal(`git archive ${rev} failed: ${String(archive.stderr).trim()}`)
    const tar = spawnSync('tar', ['-x', '-C', scratch], { input: archive.stdout })
    if (tar.status !== 0) throw new GuardRefusal(`tar could not unpack ${rev} in ${scratch}: ${String(tar.stderr).trim()}`)
    const web = join(scratch, WEB)
    symlinkSync(modules, join(web, 'node_modules'))
    return vitestTitles(web, files.filter((file) => existsSync(join(web, file))), join(scratch, 'list.json'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** What a commit's vitest listing holds: [title, path] of each title it adds, old -> new path, and `title\0path` of each
 * title it drops (the parent's path). */
type CommitTitles = [added: [string, string][], renamed: Map<string, string>, dropped: Set<string>]

/** The vitest titles `rev` adds and drops over `parent` in the test files it changes. */
function commitAdded(root: string, rev: string, parent: string, changes: readonly Change[]): CommitTitles {
  const [oldFiles, newFiles, renamed] = webTests(changes)
  const [before] = listedAt(root, parent, oldFiles)
  const [after] = listedAt(root, rev, newFiles)
  const was = tally(before)
  const added: [string, string][] = []
  for (const [name, file] of after) {
    const n = was.get(name) ?? 0
    if (n) was.set(name, n - 1)
    else added.push([lastPart(name), `${WEB}/${file}`])
  }
  const dropped = new Set(before.filter(([name]) => (was.get(name) ?? 0) > 0).map(([name, file]) => `${lastPart(name)}\0${WEB}/${file}`))
  return [added, renamed, dropped]
}

/** The Vitest pass's findings and its notes (files the base or head listing could not read). */
export async function vitestPass(git: RangeGit, mergeBase: string, head: string, commits: readonly RangeCommit[],
  citesQ: (message: string) => boolean): Promise<{ findings: Finding[], notes: string[] }> {
  const [baseFiles, headFiles, renamed] = webTests(git.changed(mergeBase, head))
  if (!baseFiles.length) return { findings: [], notes: [] }
  const [baseTitles, unread] = listedAt(git.root, mergeBase, baseFiles)
  const [headTitles, headUnread] = listedAt(git.root, head, headFiles)
  const note = (at: string, files: readonly string[]) => (files.length
    ? [`vitest list could not read these at ${at}; the per-commit reading stands for them: ${files.join(', ')}`] : [])
  const notes = [...note('the base', unread), ...note('head', headUnread)]
  // A base file whose head file is unread has no head listing to compare: the per-commit reading judges it.
  const unreadAt = new Set(headUnread)
  const base = baseTitles.filter(([, file]) => !unreadAt.has(renamed.get(`${WEB}/${file}`)?.slice(WEB.length + 1) ?? file))
  const was = tally(base)
  const now = tally(headTitles)
  const candidates = new Set([...now].filter(([name, n]) => (was.get(name) ?? 0) < n).map(([name]) => lastPart(name)))
  const seen = new Set<string>()
  const lost = base.filter(([name, file]) => {
    const key = `${name}\0${file}`
    if (seen.has(key) || (was.get(name) ?? 0) <= (now.get(name) ?? 0)) return false
    seen.add(key)
    return true
  }).sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]))
  const touched = new Map<string, Set<string>>()
  const touches = (commit: RangeCommit) => {
    let paths = touched.get(commit.rev)
    if (!paths) {
      paths = new Set(git.changed(commit.parent, commit.rev).flatMap(([, old, path]) => [old, path]))
      touched.set(commit.rev, paths)
    }
    return paths
  }
  const own = new Map<string, CommitTitles>()
  const folded = new Map<string, number>()
  const findings: Finding[] = []
  for (const [name, file] of lost) {
    const path = `${WEB}/${file}`
    const title = lastPart(name)
    const paths = [path, renamed.get(path) ?? path] as const
    const text = await git.show(mergeBase, path)
    const loss = { title, path, text, bodies: bodiesFor(path, text, title) }
    let routed = false
    let refusal: Finding | undefined
    for (const commit of commits) {
      const at = touches(commit)
      if (!at.has(path) && !at.has(renamed.get(path) ?? '')) continue
      const verdict = await routeOne(git, loss, paths, commit, citesQ, candidates, own, folded)
      if (verdict.kind === 'routed') {
        routed = true
        break
      }
      if (verdict.kind === 'refused') refusal ??= verdict.finding
    }
    if (!routed) {
      findings.push(refusal ?? ['gate-test-deleted', `'${name}' (${file}) is gone at head with no route in a commit that `
        + 'touched its file'])
    }
  }
  return { findings, notes }
}

/** One commit's route for one lost title: its Q row, Retires-test, Rewords-test or a quoted title it adds (routeLoss). */
async function routeOne(git: RangeGit, loss: Loss, paths: readonly [string, string],
  commit: RangeCommit, citesQ: (message: string) => boolean, candidates: ReadonlySet<string>,
  own: Map<string, CommitTitles>, folded: Map<string, number>): Promise<Routed> {
  const { rev, parent, message } = commit
  const readParent: Read = (path) => git.show(parent, path)
  const retired = new Set([...message.matchAll(RETIRES)].map((match) => strip(match[1] ?? '')))
  const authorised = citesQ(message)
  const route: { -readonly [K in keyof Route]: Route[K] } = {
    authorised, retired, read: readParent, pyModules: new Set(),
    deletedCode: !authorised && retired.has(loss.title)
      ? await deletedCode(git.changed(parent, rev), readParent, (path) => git.show(rev, path)) : new Map(),
  }
  const rewords = [...message.matchAll(REWORDS)].filter((match) => strip(match[1] ?? '') === loss.title)
    .map((match) => strip(match[2] ?? ''))
  if (!authorised && !retired.has(loss.title) && (rewords.length || [...candidates].some((t) => quoted(t, message)))) {
    let added = own.get(rev)
    if (!added) {
      added = commitAdded(git.root, rev, parent, git.changed(parent, rev))
      own.set(rev, added)
    }
    const [free, moved, dropped] = added
    // Only a commit that dropped the title spends its added titles on it: one that merely edited the file routes none.
    if (!paths.some((path) => dropped.has(`${loss.title}\0${path}`))) return routeLoss(loss, route)
    const pairs = paths.map((path) => [path, moved.get(path) ?? path] as const)
    const same = new Set(pairs.flat())
    let pick = free.findIndex(([t, p]) => rewords.includes(t) && same.has(p))
    if (pick !== -1) {
      const [t, p] = free[pick] ?? ['', '']
      route.reword = { title: t, path: p, bodies: bodiesFor(p, await git.show(rev, p), t), sameFile: true }
    } else {
      for (const kept of rewords) {
        for (const [from, to] of pairs) {
          const before = bodiesFor(from, await git.show(parent, from), kept)
          const after = bodiesFor(to, await git.show(rev, to), kept)
          if (before && after && !route.reword) {
            const key = `${rev}\0${to}\0${kept}`
            folded.set(key, (folded.get(key) ?? 0) + asserts(loss.bodies ?? []))
            route.reword = { title: kept, path: to, bodies: after, sameFile: true, fold: { before, owed: folded.get(key) ?? 0 } }
          }
        }
      }
      if (!route.reword) {
        const named = free.flatMap(([t], i) => (quoted(t, message) ? [i] : []))
        pick = named.find((i) => same.has(free[i]?.[1] ?? '')) ?? named[0] ?? -1
        if (pick !== -1) {
          const [t, p] = free[pick] ?? ['', '']
          route.replacement = { title: t, path: p, bodies: bodiesFor(p, await git.show(rev, p), t) }
        }
      }
    }
    const verdict = await routeLoss(loss, route)
    if (verdict.kind === 'routed' && pick !== -1 && !route.reword?.fold) free.splice(pick, 1)
    return verdict
  }
  return routeLoss(loss, route)
}
