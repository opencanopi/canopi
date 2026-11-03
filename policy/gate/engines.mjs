// policy/gate/engines.mjs: the Node the gate runs on (design check A9, AR24). desktop/web/package.json's engines range
// names the major Canopi needs. The entry (cli.mjs) on an older major runs itself again on nvm's newest install of that
// major (NVM_DIR, else ~/.nvm), so a shell, hook or script whose default Node is older still runs the gate; with none, it
// refuses in one line. Plain JavaScript like the entry, so a Node that cannot strip types (20, 22 before 22.18) loads it.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ENGINES_FILE = 'desktop/web/package.json'

/**
 * The engines major for the repository at `root`, or the refusal naming why it cannot be read.
 * @param {string} root
 * @returns {{ readonly major: number } | { readonly refusal: string }}
 */
function enginesMajor(root) {
  /** @type {unknown} */
  let range
  try {
    range = JSON.parse(readFileSync(join(root, ENGINES_FILE), 'utf8'))?.engines?.node
  } catch (error) {
    const failure = /** @type {NodeJS.ErrnoException} */ (error)
    return { refusal: `${ENGINES_FILE} cannot be read for the engines Node (${failure.code ?? failure.message})` }
  }
  const want = typeof range === 'string' ? /(\d+)/.exec(range)?.[1] : undefined
  return want === undefined ? { refusal: `${ENGINES_FILE} names no engines.node major` } : { major: Number(want) }
}

/**
 * The one-line refusal for Node `version` under the repository at `root`, or undefined when it may run.
 * @param {string} version
 * @param {string} root
 * @returns {string | undefined}
 */
export function engineRefusal(version, root) {
  const engines = enginesMajor(root)
  if ('refusal' in engines) return engines.refusal
  const have = /^v?(\d+)/.exec(version)?.[1]
  return have !== undefined && Number(have) >= engines.major ? undefined : `Node ${engines.major} is required (engines); found ${version}`
}

/**
 * nvm's newest install of the engines major to run the gate again on, or undefined: none, an unreadable engines file,
 * or the install is the running Node itself (an older one there refuses rather than running itself again).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function enginesNode(root, env) {
  const engines = enginesMajor(root)
  if ('refusal' in engines) return undefined
  const versions = join(env['NVM_DIR'] || join(homedir(), '.nvm'), 'versions/node')
  /** @param {string} name */
  const parts = (name) => name.slice(1).split('.').map(Number)
  /** @param {string} a @param {string} b */
  const newer = (a, b) => parts(a).reduce((order, part, index) => order || part - (parts(b)[index] ?? 0), 0)
  /** @type {string[]} */
  let installs
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
