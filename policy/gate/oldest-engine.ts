// policy/gate/oldest-engine.ts: the oldest engines' parse check (design check A15; 2.1-Q267, 2.1-M490; canopi-4kfl).
// Every chunk of both builds (desktop/web/dist and dist-web) is parsed as a module by two engines, each in its
// digest-pinned image, so a build whose syntax outgrows either fails here:
// - the Linux floor, Debian 12's WebKitGTK (linux-floor in build.yml). Debian 12 ships no `jsc` binary
//   (libjavascriptcoregtk-4.1-bin is gone from bookworm), so gjs loads its JavaScriptCore 4.1 through GObject
//   introspection and runs `jsc_context_check_syntax` over each chunk;
// - the engine floor, a WebKit of ENGINE_FLOOR's Safari (desktop/web/engine-floor.ts): Playwright 1.28.0's WebKit 16.4,
//   the image engine-floor-probe.yml boots the editions in. A page imports each chunk behind a module that throws
//   first, so the whole graph is fetched and parsed and nothing in it runs; a run whose engine is not the floor's
//   Safari fails, so a floor raised without re-pinning the image never passes.
// Each engine also checks one planted chunk it cannot parse (explicit resource management for Debian 12, the RegExp v
// flag of Safari 17 for the floor) and fails unless it refuses it, so a check that parses nothing never passes. A
// missing image that cannot be pulled fails naming its digest; no host engine stands in.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_FLOOR } from '../../desktop/web/engine-floor.ts'
import { GateError } from './plan.ts'
import { WEB } from './table.ts'

/** debian:12 by digest, as `docker image inspect debian:12` names it; a bump changes the digest. */
export const OLDEST_ENGINE_IMAGE = 'debian@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858'
/** Playwright 1.28.0's image (WebKit 16.4, the floor) by digest, as engine-floor-probe.yml pins it. */
export const FLOOR_ENGINE_IMAGE = 'mcr.microsoft.com/playwright@sha256:005384a627bd71a0791e993d017907d31c9798e6b082d794a36e80213520c0a9'
/** The runner that drives the floor image's WebKit: an image's browsers speak only their own Playwright's protocol. */
export const FLOOR_ENGINE_PLAYWRIGHT = '1.28.0'
/** The builds whose chunks the oldest engines parse, repository-relative. */
export const BUILDS = [`${WEB}/dist`, `${WEB}/dist-web`] as const
/** The chunk the Debian 12 run plants: syntax its JavaScriptCore refuses. */
export const PLANTED_CHUNK = 'planted/using-declaration.js'
/** The chunk the floor run plants: syntax too new for the floor (Safari 17's RegExp v flag), a chunk the build must never emit. */
export const FLOOR_PLANTED_CHUNK = 'planted/regexp-v-flag.js'

/** The gjs program the Debian 12 container runs: each listed file checked as a module, one `FAIL <file>: <why>` line per refusal. */
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

/**
 * The Node program the floor container runs (CommonJS for the image's Node 16): it serves the mounted files and a page
 * that imports each listed file behind `/__stop.js`, a module that throws when evaluated. The engine fetches and parses
 * the whole graph before evaluating any of it and evaluates the stop module first, so nothing listed runs: a probe that
 * rejects with the stop error parsed, any other rejection is a `FAIL <file>: <why>` line.
 */
const FLOOR_CHECK = `const http = require('http')
const fs = require('fs')
const path = require('path')
const { webkit } = require('playwright-core')
const STOP = 'canopi-parsed'
const files = fs.readFileSync(process.argv[2], 'utf8').split('\\n').filter((line) => line !== '')
const served = (file) => (file.startsWith('/work/') || file.startsWith('/check/')) && fs.existsSync(file) && fs.statSync(file).isFile()
const script = (response, body) => { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(body) }
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>engine floor</title>'); return }
  if (url.pathname === '/__stop.js') { script(response, 'throw new Error(' + JSON.stringify(STOP) + ')\\n'); return }
  if (url.pathname === '/__probe.js') {
    const file = url.searchParams.get('file')
    script(response, 'import "/__stop.js?for=' + encodeURIComponent(file) + '"\\nimport ' + JSON.stringify(file) + '\\n')
    return
  }
  const file = path.posix.normalize(decodeURIComponent(url.pathname))
  if (!served(file)) { response.writeHead(404, { 'content-type': 'text/plain' }); response.end('Not Found'); return }
  script(response, fs.readFileSync(file))
})
server.listen(0, '127.0.0.1', async () => {
  let browser
  try {
    browser = await webkit.launch()
    console.log('engine: WebKit ' + browser.version())
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:' + server.address().port + '/')
    const refused = await page.evaluate('(async (files, stop) => {' +
      ' const out = [];' +
      ' for (const file of files) {' +
      '  try { await import("/__probe.js?file=" + encodeURIComponent(file)); out.push({ file, why: "it ran: the stop module did not throw" }) }' +
      '  catch (error) { const message = String(error && error.message); if (message !== stop) out.push({ file, why: String(error && error.name) + ": " + message }) }' +
      ' }' +
      ' return out' +
      '})(' + JSON.stringify(files) + ', ' + JSON.stringify(STOP) + ')')
    for (const { file, why } of refused) console.log('FAIL ' + file + ': ' + why)
    console.log('checked ' + files.length)
  } catch (error) {
    console.error('the floor engine stopped: ' + (error && error.message))
    process.exitCode = 1
  } finally {
    if (browser) await browser.close()
    server.close()
  }
})
`
const FLOOR_INSTALL = `mkdir -p /tmp/runner && cd /tmp/runner && npm install --no-save --no-audit --no-fund --loglevel=error playwright-core@${FLOOR_ENGINE_PLAYWRIGHT} >/dev/null`

/** One engine of the check: its image, its planted chunk and the container command that reads the file list. */
interface Engine {
  readonly label: string
  readonly image: string
  readonly planted: string
  readonly plantedSource: string
  readonly list: string
  readonly command: string
  /** The `engine:` line a run must print, when the engine itself is pinned (the floor's Safari). */
  readonly expect?: string
}

const ENGINES: readonly Engine[] = [
  {
    label: 'oldest engine (Debian 12)', image: OLDEST_ENGINE_IMAGE, planted: PLANTED_CHUNK, plantedSource: 'using held = null\nexport { held }\n',
    list: 'files.txt',
    command: `${INSTALL} && dpkg-query -W -f='engine: WebKitGTK \${Version}\\n' gir1.2-javascriptcoregtk-4.1 && gjs /check/check.js /check/files.txt`,
  },
  {
    label: `engine floor (Safari ${ENGINE_FLOOR.safari})`, image: FLOOR_ENGINE_IMAGE, planted: FLOOR_PLANTED_CHUNK,
    plantedSource: 'export const letters = /[\\p{L}--[a-z]]/v\n', list: 'floor-files.txt',
    command: `${FLOOR_INSTALL} && NODE_PATH=/tmp/runner/node_modules node /check/floor-check.cjs /check/floor-files.txt`,
    expect: `engine: WebKit ${ENGINE_FLOOR.safari}`,
  },
]

/** How long one engine's container may run before the check fails naming it. */
const ENGINE_TIMEOUT_MS = 20 * 60_000

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

/** One engine over every chunk plus its planted one: true when each chunk parses and the planted one does not. */
function checkEngine(engine: Engine, root: string, work: string, files: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const planted = `/check/${engine.planted}`
  writeFileSync(join(work, engine.list), [...files.map((file) => `/work/${file}`), planted].join('\n'))
  log(`${engine.label}: ${files.length} chunks in ${engine.image}`)
  const run = spawnSync('docker', ['run', '--rm', '-v', `${root}:/work:ro`, '-v', `${work}:/check:ro`, engine.image, 'sh', '-c', engine.command],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: ENGINE_TIMEOUT_MS })
  if (run.error || run.status !== 0) {
    log(`FAIL the ${engine.label} container did not run (exit ${run.status}): ${(run.stderr ?? run.error?.message ?? '').trim().slice(-400)}`)
    return false
  }
  const lines = run.stdout.split('\n')
  const engines = lines.filter((text) => text.startsWith('engine: '))
  for (const line of engines) log(line)
  if (engine.expect && !engines.includes(engine.expect)) {
    log(`FAIL the ${engine.label} image runs ${engines.join(', ') || 'no engine it named'}, not ${engine.expect.slice('engine: '.length)}: `
      + `pin the image whose WebKit is ENGINE_FLOOR's Safari (desktop/web/engine-floor.ts)`)
    return false
  }
  const refused = lines.filter((line) => line.startsWith('FAIL '))
  const real = refused.filter((line) => !line.startsWith(`FAIL ${planted}:`))
  for (const line of real) log(`${line.replace('FAIL /work/', 'FAIL ')}`)
  if (refused.length === real.length) {
    log(`FAIL the ${engine.label} accepted the planted chunk ${engine.planted}: the check parsed nothing`)
    return false
  }
  if (real.length) return false
  log(`${engine.label}: every chunk parses`)
  return true
}

/** Every chunk of both builds parsed by each oldest engine: 0 when each parses everywhere and every planted chunk is refused. */
export function runOldestEngine(root: string, env: NodeJS.ProcessEnv = process.env): number {
  const missing = BUILDS.filter((dir) => !existsSync(join(root, dir)))
  if (missing.length) throw new GateError(`${missing.join(' and ')} missing: run npm run build and npm run build:web in ${WEB} first`)
  const files = BUILDS.flatMap((dir) => chunks(root, dir))
  for (const engine of ENGINES) ensureImage(engine.image, env)
  const work = mkdtempSync(join(tmpdir(), 'canopi-oldest-engine-'))
  try {
    writeFileSync(join(work, 'check.js'), CHECK)
    writeFileSync(join(work, 'floor-check.cjs'), FLOOR_CHECK)
    mkdirSync(join(work, 'planted'))
    for (const engine of ENGINES) writeFileSync(join(work, engine.planted), engine.plantedSource)
    // Every engine runs, so one red names all the engines it reaches.
    const passed = ENGINES.map((engine) => checkEngine(engine, root, work, files, env))
    return passed.every(Boolean) ? 0 : 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
