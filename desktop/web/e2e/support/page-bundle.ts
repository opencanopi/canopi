// The one bundler for specs that run a slice of the app's own source in a page (or in Node, to compare the two): Rolldown,
// the bundler Vite builds the app with, so a slice bundles as the app does (2.1 Phase 0, A3).
import { join } from 'node:path'
import { build } from 'rolldown'

/**
 * `source`, a module whose relative imports resolve from `dir`, bundled as one classic script that sets
 * `window[globalName]` (or the global of `new Function`) to its exports.
 */
export async function pageBundle(source: string, dir: string, globalName: string): Promise<string> {
  const entry = join(dir, '__page-bundle-entry__.ts')
  const { output } = await build({
    input: entry,
    platform: 'browser',
    logLevel: 'warn',
    plugins: [{
      name: 'canopi-page-bundle-entry',
      resolveId: (id) => (id === entry ? entry : null),
      load: (id) => (id === entry ? source : null),
    }],
    output: { format: 'iife', name: globalName },
    write: false,
  })
  if (output.length !== 1) throw new Error(`${globalName}: expected one script, got ${output.map((file) => file.fileName).join(', ')}`)
  return output[0].code
}
