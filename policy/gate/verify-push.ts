// policy/gate/verify-push.ts: the pre-push hook's judge (2.1-Q266, 2.1-Q270; design check AR1, A4). `.githooks/pre-push`
// hands it git's ref lines (`<local ref> <local sha> <remote ref> <remote sha>`), for the user's checkout as for every
// worktree. It allows a deletion, a tag whose commit is on origin/main, a range holding no change, and a docs or
// beads-only range after its cheap lane runs here on the commit checked out; any other pushed commit needs a green
// pre-push stamp (stamp.ts) made from the gate table that commit holds, from a merge base the pushed range's start or
// origin/main holds, with the e2e run and Rust checks the range needs. Otherwise it refuses, naming the command to run.
import { GateError, docsOnly, git, planAffected, pushNeeds } from './plan.ts'
import { execute } from './run.ts'
import { readStamp, tableAt, trackedChanges } from './stamp.ts'

export const PUSH_COMMAND = 'node policy/gate/cli.mjs push --base origin/main'
const ZERO = /^0+$/
const log = (line: string) => process.stderr.write(`gate: pre-push: ${line}\n`)
const short = (sha: string) => sha.slice(0, 12)

const isAncestor = (root: string, ancestor: string, of: string, env: NodeJS.ProcessEnv) => {
  try {
    git(root, ['merge-base', '--is-ancestor', ancestor, of], env)
    return true
  } catch {
    return false
  }
}

/** Why `sha`'s stamp does not cover the range `base..sha` with `paths` changed, or undefined when it does. */
function stampFault(root: string, sha: string, base: string, paths: readonly string[], env: NodeJS.ProcessEnv) {
  const stamp = readStamp(root, sha, env)
  if (!stamp) return 'it has no green pre-push stamp'
  if (stamp.sha !== sha) return `its stamp names another commit (${short(stamp.sha)})`
  if (stamp.lane !== 'push') return `its stamp is from the ${stamp.lane} lane, not the pre-push lane`
  if (stamp.table !== tableAt(root, sha, env)) return 'its stamp was made with another gate table than the one it holds'
  // A lane from a commit origin/main holds covers every pushed change origin/main lacks: a branch that took a newer
  // main, by merge or rebase, starts its range before that main.
  if (!isAncestor(root, stamp.base, base, env) && !isAncestor(root, stamp.base, 'origin/main', env)) {
    return `its stamp's lane ran from ${short(stamp.base)}, which neither origin/main nor the pushed range's start `
      + `${short(base)} holds`
  }
  const needs = pushNeeds(root, paths)
  if (needs.e2e && !stamp.e2e) return "its stamp's lane ran no e2e, which the pushed changes need"
  if (needs.rust && !stamp.rust) return "its stamp's lane ran no Rust check, which the pushed changes need"
  return undefined
}

/** A docs or beads-only range's lane, run here on the commit checked out; why it cannot pass, or undefined. */
async function cheapLane(root: string, sha: string, base: string, paths: readonly string[], env: NodeJS.ProcessEnv) {
  if (git(root, ['rev-parse', 'HEAD'], env).trim() !== sha || trackedChanges(root, env).length) {
    return 'a docs or beads-only push runs its lane on the commit checked out with a clean tracked tree, and this is '
      + 'not one: check it out, or stamp it'
  }
  const plan = planAffected(root, paths, false, base, env)
  log(`${short(sha)} changes only docs or beads: running their lane`)
  return await execute(root, plan.checks, plan.e2e, plan.notes, false, env) === 0 ? undefined : 'its docs or beads lane is red'
}

async function judge(root: string, sha: string, remoteRef: string, remoteSha: string, env: NodeJS.ProcessEnv) {
  if (ZERO.test(sha)) return undefined
  if (remoteRef.startsWith('refs/tags/')) {
    let commit = ''
    try {
      commit = git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], env).trim()
    } catch {
      // a tag of no commit is refused below
    }
    return commit && isAncestor(root, commit, 'origin/main', env) ? undefined
      : 'a tag is pushed only once its commit is on origin/main (a release tag: scripts/promote-release.sh)'
  }
  let known = false
  try {
    known = !ZERO.test(remoteSha) && git(root, ['cat-file', '-t', remoteSha], env).trim() === 'commit'
  } catch {
    // the remote holds a commit this repository lacks: the range starts at origin/main
  }
  let base
  try {
    base = git(root, ['merge-base', known ? remoteSha : 'origin/main', sha], env).trim()
  } catch (error) {
    return `its range cannot be read (${error instanceof GateError ? error.message : String(error)}): fetch origin`
  }
  const paths = git(root, ['diff', '--name-only', '-z', base, sha], env).split('\0').filter((path) => path !== '')
  if (!paths.length) return undefined
  const fault = stampFault(root, sha, base, paths, env)
  if (!fault || !docsOnly(paths)) return fault
  return await cheapLane(root, sha, base, paths, env)
}

/** The hook's exit code for git's ref lines `input`: 0 when every pushed ref may go, else 1 naming each refusal. */
export async function verifyPush(root: string, input: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let refused = 0
  for (const line of input.split('\n').map((text) => text.trim()).filter((text) => text !== '')) {
    const [, sha, remoteRef, remoteSha, extra] = line.split(/\s+/)
    const fault = sha && remoteRef && remoteSha && extra === undefined
      ? await judge(root, sha, remoteRef, remoteSha, env) : `git's ref line cannot be read ("${line}")`
    if (fault) {
      log(`${remoteRef ?? line} at ${short(sha ?? '')}: ${fault}`)
      refused += 1
    }
  }
  if (refused) log(`run \`${PUSH_COMMAND}\` on the commit you push, then push again; refusing`)
  return refused ? 1 : 0
}
