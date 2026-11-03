// policy/gate/engines.ts: the Node the gate runs on (design check A9, AR24). desktop/web/package.json's engines range
// names the major Canopi needs; a gate entry on an older major refuses in one line before it loads anything else, so a
// hook that found the wrong Node says so instead of failing somewhere inside a check. The hooks' prelude looks for that
// major in nvm first (C4); this is the refusal when none was found.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ENGINES_FILE = 'desktop/web/package.json'

/** The one-line refusal for Node `version` under the repository at `root`, or undefined when it may run. */
export function engineRefusal(version: string, root: string): string | undefined {
  let range: unknown
  try {
    range = (JSON.parse(readFileSync(join(root, ENGINES_FILE), 'utf8')) as { engines?: { node?: unknown } }).engines?.node
  } catch (error) {
    return `${ENGINES_FILE} cannot be read for the engines Node (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`
  }
  const want = typeof range === 'string' ? /(\d+)/.exec(range)?.[1] : undefined
  if (want === undefined) return `${ENGINES_FILE} names no engines.node major`
  const have = /^v?(\d+)/.exec(version)?.[1]
  return have !== undefined && Number(have) >= Number(want) ? undefined : `Node ${want} is required (engines); found ${version}`
}
