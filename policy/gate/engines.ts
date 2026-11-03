// policy/gate/engines.ts: the Node the gate runs on (design check A9, AR24). desktop/web/package.json's engines range
// names the major Canopi needs. A gate entry on an older major runs itself again on nvm's newest install of that major
// (NVM_DIR, else ~/.nvm), so a shell, hook or script whose default Node is older still runs the gate; with none, it
// refuses in one line before it loads anything else, so the wrong Node says so instead of failing inside a check.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ENGINES_FILE = 'desktop/web/package.json'

/** The engines major for the repository at `root`, or the refusal naming why it cannot be read. */
function enginesMajor(root: string): { readonly major: number } | { readonly refusal: string } {
  let range: unknown
  try {
    range = (JSON.parse(readFileSync(join(root, ENGINES_FILE), 'utf8')) as { engines?: { node?: unknown } }).engines?.node
  } catch (error) {
    return { refusal: `${ENGINES_FILE} cannot be read for the engines Node (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})` }
  }
  const want = typeof range === 'string' ? /(\d+)/.exec(range)?.[1] : undefined
  return want === undefined ? { refusal: `${ENGINES_FILE} names no engines.node major` } : { major: Number(want) }
}

/** The one-line refusal for Node `version` under the repository at `root`, or undefined when it may run. */
export function engineRefusal(version: string, root: string): string | undefined {
  const engines = enginesMajor(root)
  if ('refusal' in engines) return engines.refusal
  const have = /^v?(\d+)/.exec(version)?.[1]
  return have !== undefined && Number(have) >= engines.major ? undefined : `Node ${engines.major} is required (engines); found ${version}`
}

/**
 * nvm's newest install of the engines major to run the gate again on, or undefined: none, an unreadable engines file,
 * or the install is the running Node itself (an older one there refuses rather than running itself again).
 */
export function enginesNode(root: string, env: NodeJS.ProcessEnv): string | undefined {
  const engines = enginesMajor(root)
  if ('refusal' in engines) return undefined
  const versions = join(env['NVM_DIR'] || join(homedir(), '.nvm'), 'versions/node')
  const parts = (name: string) => name.slice(1).split('.').map(Number)
  const newer = (a: string, b: string) => parts(a).reduce((order, part, index) => order || part - (parts(b)[index] ?? 0), 0)
  let installs: string[]
  try {
    installs = readdirSync(versions).filter((name) => name.startsWith(`v${engines.major}.`)
      && existsSync(join(versions, name, 'bin/node'))).sort(newer)
  } catch {
    return undefined
  }
  const newest = installs.at(-1)
  const node = newest === undefined ? undefined : join(versions, newest, 'bin/node')
  return node === undefined || realpathSync(node) === realpathSync(process.execPath) ? undefined : node
}
