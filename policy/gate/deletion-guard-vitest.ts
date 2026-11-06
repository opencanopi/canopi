// policy/gate/deletion-guard-vitest.ts: the deletion guard's Vitest pass (2.1-M199, 2.1-Q224, 2.1-Q267, 2.1-Q272), which
// CI's Commit gate job runs with `pr --vitest`. Vitest titles (.each rows, template literals) lost between the merge base
// and head are read by `vitest list --staticParse=false` on each revision's whole tree (a test may read any file of it at
// collection), linking the checkout's node_modules: the base lists each test file deleted, changed or renamed (its old
// path), the head each one changed, renamed or added, so a move into any file passes. A file either side cannot list is
// named in a note and left to the static reading; a file listed at both ends is judged here alone (one reading,
// canopi-f47t.52.240). The PR is judged on its net change: a lost title takes its route through the deletion guard's
// one loss router (routeLoss, canopi-f47t.52.228.51): a merge-base Q row cited by a commit that touched its file or on a
// PR body line naming the file (2.1-Q274); or, from any commit message of the range or the PR body, Retires-test with
// the code under test deleted, or a test of documentation only (M329); Rewords-test (a template pair names its rows) to
// a title head adds in the same file, or a fold into a title kept there (M330); or a quoted title head adds (its own
// file first). No route counts assertions (2.1-Q272).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { type Change, deletedCode, RETIRES, rewordPairs, type Route, routeLoss } from './deletion-guard.ts'
import { strip } from './ledger.ts'
import { TABLE } from './table.ts'
import { bodiesFor, byCodePoint, type Finding, GuardRefusal, quoted, type Read, refill } from './test-reader.ts'

/** What the pass reads of the repository: git -M changes and files at a revision. */
export interface RangeGit {
  readonly root: string
  changed(from: string, to: string): Change[]
  show(rev: string, path: string): Promise<string | undefined>
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

/** The Vitest pass's findings, its notes (files the base or head listing could not read) and the base paths it read at
 * both ends. `text`: every commit message of the range and the PR body; `authorised`: whether a Q row in a file's
 * route (judgeRange's tiedRoutes, 2.1-Q274) routes its tests. */
export async function vitestPass(git: RangeGit, mergeBase: string, head: string, text: string,
  authorised: (path: string) => boolean): Promise<{ findings: Finding[], notes: string[], listed: Set<string> }> {
  const changes = git.changed(mergeBase, head)
  const [baseFiles, headFiles, renamed] = webTests(changes)
  if (!baseFiles.length) return { findings: [], notes: [], listed: new Set() }
  const [baseTitles, unread] = listedAt(git.root, mergeBase, baseFiles)
  const [headTitles, headUnread] = listedAt(git.root, head, headFiles)
  const note = (at: string, files: readonly string[]) => (files.length
    ? [`vitest list could not read these at ${at}; the static reading stands for them: ${files.join(', ')}`] : [])
  const notes = [...note('the base', unread), ...note('head', headUnread)]
  // A base file whose head file is unread has no head listing to compare: the static reading judges it.
  const unreadAt = new Set(headUnread)
  const headOf = (file: string) => renamed.get(`${WEB}/${file}`)?.slice(WEB.length + 1) ?? file
  const listed = new Set(baseFiles.filter((file) => !unread.includes(file) && !unreadAt.has(headOf(file))).map((file) => `${WEB}/${file}`))
  const base = baseTitles.filter(([, file]) => listed.has(`${WEB}/${file}`))
  // A title's global deficit (so a move into any file passes), charged to the files whose own count fell: a loss is
  // judged in the file it fell in, never at the same title kept in another file (canopi-f47t.52.240).
  const now = tally(headTitles)
  const deficit = tally(base)
  for (const [name, n] of deficit) deficit.set(name, n - (now.get(name) ?? 0))
  const at = (names: readonly Listed[]) => tally(names.map(([name, file]) => [`${name}\0${file}`, file]))
  const baseAt = at(base)
  const headAt = at(headTitles)
  const lost = [...new Map(base.map((pair) => [`${pair[0]}\0${pair[1]}`, pair])).values()]
    .sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]))
    .filter(([name, file]) => {
      const owed = deficit.get(name) ?? 0
      if (owed <= 0 || (baseAt.get(`${name}\0${file}`) ?? 0) <= (headAt.get(`${name}\0${headOf(file)}`) ?? 0)) return false
      deficit.set(name, owed - 1)
      return true
    })
  // [title, path] of each title head adds: what a lost title may be reworded or quoted to.
  const left = tally(base)
  const free: [string, string][] = []
  for (const [name, file] of headTitles) {
    const n = left.get(name) ?? 0
    if (n) left.set(name, n - 1)
    else free.push([lastPart(name), `${WEB}/${file}`])
  }
  const retired = new Set([...text.matchAll(RETIRES)].map((match) => strip(match[1] ?? '')))
  const readBase: Read = (path) => git.show(mergeBase, path)
  const route: Omit<Route, 'reword' | 'replacement'> = {
    authorised: false, retired, read: readBase, pyModules: new Set(),
    deletedCode: retired.size ? await deletedCode(changes, readBase, (path) => git.show(head, path)) : new Map(),
  }
  const pairs = rewordPairs(text, true)
  const findings: Finding[] = []
  for (const [name, file] of lost) {
    const path = `${WEB}/${file}`
    const title = lastPart(name)
    const textAt = await git.show(mergeBase, path)
    const loss = { title, path, text: textAt, bodies: bodiesFor(path, textAt, title) }
    const same = new Set([path, renamed.get(path) ?? path])
    const to = renamed.get(path) ?? path
    const targets = pairs.flatMap(([from, into]) => refill(from, into, title) ?? [])
    let pick = free.findIndex(([t, p]) => targets.includes(t) && same.has(p))
    let next: Route = authorised(path) ? { ...route, authorised: true } : route
    if (next.authorised || retired.has(title)) pick = -1
    else if (pick !== -1) {
      next = { ...route, reword: { title: free[pick]?.[0] ?? '', sameFile: true } }
    } else {
      const headText = targets.length ? await git.show(head, to) : undefined
      // A fold (M330): a title kept in the file, at the base and at head; no assertion count (2.1-Q272).
      const kept = targets.find((t) => bodiesFor(path, textAt, t) && bodiesFor(to, headText, t))
      if (kept !== undefined) next = { ...route, reword: { title: kept, sameFile: true } }
      else {
        const named = free.flatMap(([t], i) => (quoted(t, text) ? [i] : []))
        pick = named.find((i) => same.has(free[i]?.[1] ?? '')) ?? named[0] ?? -1
        if (pick !== -1) next = { ...route, replacement: free[pick]?.[0] ?? '' }
      }
    }
    const verdict = await routeLoss(loss, next)
    if (verdict.kind === 'routed') {
      if (pick !== -1) free.splice(pick, 1)
      continue
    }
    if (verdict.kind === 'refused') {
      findings.push(verdict.finding)
      continue
    }
    const near = free.find(([, p]) => same.has(p))?.[0]
    findings.push(near === undefined
      ? ['gate-test-deleted', `'${name}' (${file}) is gone at head with no route in the range's messages or the PR body`]
      : ['gate-test-reworded', `'${title}' looks reworded to '${near}' (${file}): add Rewords-test: ${title} -> ${near}`])
  }
  return { findings, notes, listed }
}
