// policy/gate/stamp.ts: the pre-push stamp (2.1-Q266, 2.1-Q270; design check AR1, A4). A green `gate push` on a tree
// that is exactly HEAD (no tracked change, no untracked file git does not ignore: the checks read the tree) writes
// `<git common dir>/canopi-gate/<sha>.json` for the commit it ran on: the sha, the gate table's blob at that commit, the lane, the merge base it ran from, and whether its e2e run and Rust checks ran. The directory is the
// common one, not `git rev-parse --git-path canopi-gate` (a linked worktree's own), so a stamp made in one worktree
// serves a push from any other. It is written to a temporary name and renamed, so a reader never sees half a stamp and
// two runs on one commit leave one whole stamp. A stamp that cannot be read or parsed is no stamp.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git, type Plan } from './plan.ts'
import { TABLE_FILE } from './table.ts'

export const STAMP_DIR = 'canopi-gate'

export interface Stamp {
  readonly sha: string
  /** The blob id of policy/gate/table.ts at `sha`: the table the lane was planned from. */
  readonly table: string
  readonly lane: 'push'
  /** The merge base the lane ran from: it judged every commit after it. */
  readonly base: string
  readonly e2e: boolean
  readonly rust: boolean
}

/** The stamp directory shared by every worktree of the repository at `root`. */
export function stampDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolve(root, git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env).trim()), STAMP_DIR)
}

/** The blob id of the gate table at `sha`, or '' when that commit holds none. */
export function tableAt(root: string, sha: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${sha}:${TABLE_FILE}`], env).trim()
  } catch {
    return ''
  }
}

/** How the working tree differs from HEAD, which the checks read and a stamp certifies (canopi-f47t.52.228.54): the
 * tracked paths whose working copy or index differs, and the untracked files git does not ignore. */
export function treeChanges(root: string, env: NodeJS.ProcessEnv = process.env): { tracked: string[], untracked: string[] } {
  const entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env).split('\0')
  const tracked: string[] = []
  const untracked: string[] = []
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at] ?? ''
    if (entry === '') continue
    if (entry.startsWith('??')) untracked.push(entry.slice(3))
    else tracked.push(entry.slice(3))
    if (/^(?:[RC].|.[RC])/.test(entry)) at++ // a rename or copy's source, in the index or the worktree, follows as its own entry
  }
  return { tracked, untracked }
}

/** `changes` as a clause naming the paths (`during`: they appeared during a run), or '' when the tree is HEAD's. */
export function treeFault(changes: { tracked: string[], untracked: string[] }, during = false): string {
  return [changes.tracked.length ? `the tracked tree ${during ? 'changed' : 'has changes'} (${changes.tracked.join(', ')})` : '',
    changes.untracked.length ? `untracked files (${changes.untracked.join(', ')})${during ? ' appeared' : ''}` : '']
    .filter((part) => part !== '').join(' and ')
}

const isStamp = (value: unknown): value is Stamp => {
  const stamp = value as Partial<Record<keyof Stamp, unknown>> | null
  return typeof stamp === 'object' && stamp !== null && typeof stamp.sha === 'string' && typeof stamp.table === 'string'
    && typeof stamp.lane === 'string' && typeof stamp.base === 'string' && typeof stamp.e2e === 'boolean'
    && typeof stamp.rust === 'boolean'
}

/** The stamp written for `sha`, or undefined when there is none or it cannot be read as one. */
export function readStamp(root: string, sha: string, env: NodeJS.ProcessEnv = process.env): Stamp | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stampDir(root, env), `${sha}.json`), 'utf8'))
    return isStamp(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Writes `stamp` whole or not at all; returns its path. A directory that cannot be written throws. */
export function writeStamp(root: string, stamp: Stamp, env: NodeJS.ProcessEnv = process.env): string {
  const dir = stampDir(root, env)
  const path = join(dir, `${stamp.sha}.json`)
  const temporary = join(dir, `.${stamp.sha}.${process.pid}.tmp`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(temporary, `${JSON.stringify(stamp, null, 2)}\n`)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return path
}

const log = (line: string) => process.stderr.write(`gate: ${line}\n`)

/**
 * The push lane `made` (planned from `base`) run by `run`, and HEAD stamped when it is green: refused before running on
 * a tree that is not HEAD's (treeChanges), and red without a stamp when HEAD or the tree moved during the run or the stamp cannot be
 * written, since a push of that commit would then be refused.
 */
export async function pushAndStamp(root: string, base: string, made: Plan, run: () => Promise<number>,
  env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const head = git(root, ['rev-parse', 'HEAD'], env).trim()
  const before = treeFault(treeChanges(root, env))
  if (before) {
    log(`gate push stamps the commit it runs on, and ${before}: commit or remove them, then run it again; refusing`)
    return 1
  }
  const code = await run()
  if (code !== 0) return code
  const moved = git(root, ['rev-parse', 'HEAD'], env).trim() !== head
  const after = treeFault(treeChanges(root, env), true)
  if (moved || after) {
    log(`GREEN, but no stamp was written: ${moved ? 'HEAD moved' : after} during the run; commit or remove them, then run `
      + 'gate push again')
    return 1
  }
  const stamp: Stamp = {
    sha: head, table: tableAt(root, head, env), lane: 'push', base: git(root, ['merge-base', base, head], env).trim(),
    e2e: made.e2e !== undefined, rust: made.checks.some((planned) => planned.cargo === true && !planned.ciOnly),
  }
  try {
    log(`stamp written: ${writeStamp(root, stamp, env)}`)
    return 0
  } catch (error) {
    log(`GREEN, but no stamp was written: ${stampDir(root, env)} cannot be written `
      + `(${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); a push of ${head} is refused until one is`)
    return 1
  }
}
