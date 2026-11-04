// policy/gate/oldest-engine.ts: the oldest engine's parse check (design check A15; 2.1-Q267). The oldest WebKit Canopi
// runs on is Debian 12's WebKitGTK (the Linux floor, linux-floor in build.yml). Debian 12 ships no `jsc` binary
// (libjavascriptcoregtk-4.1-bin is gone from bookworm), so the check asks that engine itself: gjs loads Debian 12's
// JavaScriptCore 4.1 through GObject introspection and runs `jsc_context_check_syntax` over every chunk of both builds
// (desktop/web/dist and dist-web) as a module, in the digest-pinned debian:12 image. Each run also checks one planted
// chunk the engine cannot parse (explicit resource management) and fails unless the engine refuses it, so a check that
// parses nothing never passes. A missing image that cannot be pulled fails naming its digest; no host engine stands in.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GateError } from './plan.ts'
import { WEB } from './table.ts'

/** debian:12 by digest, as `docker image inspect debian:12` names it; a bump changes the digest. */
export const OLDEST_ENGINE_IMAGE = 'debian@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858'
/** The builds whose chunks the oldest engine parses, repository-relative. */
export const BUILDS = [`${WEB}/dist`, `${WEB}/dist-web`] as const
/** The chunk every run plants: syntax Debian 12's JavaScriptCore refuses. */
export const PLANTED_CHUNK = 'planted/using-declaration.js'

/** The gjs program the container runs: each listed file checked as a module, one `FAIL <file>: <why>` line per refusal. */
const CHECK = `imports.gi.versions.JavaScriptCore = '4.1'
const JSC = imports.gi.JavaScriptCore
const GLib = imports.gi.GLib
const context = new JSC.Context()
const [, list] = GLib.file_get_contents(ARGV[0])
let checked = 0
for (const file of new TextDecoder().decode(list).split('\\n').filter((line) => line !== '')) {
  const [, bytes] = GLib.file_get_contents(file)
  const [result, exception] = context.check_syntax(new TextDecoder().decode(bytes), -1, JSC.CheckSyntaxMode.MODULE, file, 1)
  checked++
  if (result !== JSC.CheckSyntaxResult.SUCCESS) {
    print('FAIL ' + file + ': ' + (exception ? exception.get_message() + ' (line ' + exception.get_line_number() + ')' : 'result ' + result))
  }
}
print('checked ' + checked)
`
const INSTALL = 'apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends gjs gir1.2-javascriptcoregtk-4.1 >/dev/null'

const log = (line: string) => process.stderr.write(`gate: ${line}\n`)

/** The .js and .mjs files under `dir`, repository-relative. */
function chunks(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((name) => `${dir}/${name.split(/[\\/]/u).join('/')}`)
    .filter((name) => /\.m?js$/.test(name) && statSync(join(root, name)).isFile()).sort()
}

/** The pinned image, pulled when missing; a missing image that cannot be pulled refuses naming the digest. */
function ensureImage(image: string, env: NodeJS.ProcessEnv): void {
  const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore', env })
  if (inspect.error) throw new GateError(`docker is not installed: the oldest-engine check runs only in ${image}`)
  if (inspect.status === 0) return
  const pulled = spawnSync('docker', ['pull', image], { encoding: 'utf8', env })
  if (pulled.status !== 0) {
    throw new GateError(`the oldest-engine image ${image} is missing and could not be pulled `
      + `(${(pulled.stderr ?? '').trim().slice(0, 200)}); the check runs only in that image`)
  }
}

/** Every chunk of both builds parsed by Debian 12's JavaScriptCore: 0 when each parses and the planted chunk does not. */
export function runOldestEngine(root: string, env: NodeJS.ProcessEnv = process.env): number {
  const missing = BUILDS.filter((dir) => !existsSync(join(root, dir)))
  if (missing.length) throw new GateError(`${missing.join(' and ')} missing: run npm run build and npm run build:web in ${WEB} first`)
  const files = BUILDS.flatMap((dir) => chunks(root, dir))
  ensureImage(OLDEST_ENGINE_IMAGE, env)
  const work = mkdtempSync(join(tmpdir(), 'canopi-oldest-engine-'))
  try {
    writeFileSync(join(work, 'check.js'), CHECK)
    const planted = `/check/${PLANTED_CHUNK}`
    mkdirSync(join(work, 'planted'))
    writeFileSync(join(work, PLANTED_CHUNK), 'using held = null\nexport { held }\n')
    writeFileSync(join(work, 'files.txt'), [...files.map((file) => `/work/${file}`), planted].join('\n'))
    log(`oldest engine: ${files.length} chunks in ${OLDEST_ENGINE_IMAGE}`)
    const run = spawnSync('docker', ['run', '--rm', '-v', `${root}:/work:ro`, '-v', `${work}:/check:ro`, OLDEST_ENGINE_IMAGE,
      'sh', '-c', `${INSTALL} && dpkg-query -W -f='engine: WebKitGTK \${Version}\\n' gir1.2-javascriptcoregtk-4.1 && gjs /check/check.js /check/files.txt`],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
    if (run.error || run.status !== 0) {
      log(`FAIL the oldest-engine container did not run (exit ${run.status}): ${(run.stderr ?? run.error?.message ?? '').trim().slice(-400)}`)
      return 1
    }
    const lines = run.stdout.split('\n')
    for (const line of lines.filter((text) => text.startsWith('engine: '))) log(line)
    const refused = lines.filter((line) => line.startsWith('FAIL '))
    const real = refused.filter((line) => !line.startsWith(`FAIL ${planted}:`))
    for (const line of real) log(`${line.replace('FAIL /work/', 'FAIL ')}`)
    if (refused.length === real.length) {
      log(`FAIL the oldest engine accepted the planted chunk ${PLANTED_CHUNK}: the check parsed nothing`)
      return 1
    }
    if (real.length) return 1
    log(`oldest engine: every chunk parses`)
    return 0
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
