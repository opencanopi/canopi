// policy/gate/git-link.ts: preflight check for linked worktrees whose `.git` file points to a missing gitdir (Stage 1 E1).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GateError } from './gate-error.ts'

/** Refuses a linked worktree whose `.git` file points to a non-existent gitdir before running git. */
export function checkGitLink(root: string): void {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return
  const match = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, 'utf8').trim())
  if (!match) throw new GateError(`malformed worktree git-link in ${dotGit}: expected "gitdir: <path>"`)
  const target = resolve(root, match[1]!.trim())
  if (!existsSync(target)) {
    throw new GateError(`broken worktree git-link in ${dotGit}: ${target} does not exist (run \`git worktree repair\` from the main checkout)`)
  }
}
