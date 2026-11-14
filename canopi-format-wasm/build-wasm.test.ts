// The format module's build (Step 2.0.4 R1-1, canopi-f47t.52.270): the CLI that binds it must be the version Cargo.lock
// pins for the wasm-bindgen crate, and the build refuses any other with the install command, as every workflow installs
// that version; the builder's paths are remapped out of the module. web-build-configuration.test.ts holds the Web
// build to building it first.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BIND_ARGS, CRATE_DIR, MODULE_PROFILE, cliVersion, lockedVersion, moduleRustflags, versionRefusal } from './build-wasm.mjs'

const LOCK = [
  'version = 4',
  '',
  '[[package]]',
  'name = "wasm-bindgen"',
  'version = "0.2.130"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  '',
  '[[package]]',
  'name = "wasm-bindgen-shared"',
  'version = "0.2.130"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  '',
].join('\n')

describe('canopi-f47t.52.270: the wasm-bindgen CLI pin', () => {
  it('reads the one wasm-bindgen version the lock pins, never a crate whose name it prefixes', () => {
    expect(lockedVersion(LOCK, 'wasm-bindgen')).toBe('0.2.130')
    expect(lockedVersion(`${LOCK}\n[[package]]\nname = "wasm-bindgen"\nversion = "0.2.114"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`, 'wasm-bindgen')).toBeUndefined()
    expect(lockedVersion('version = 4\n', 'wasm-bindgen')).toBeUndefined()
  })

  it('refuses a wasm-bindgen CLI whose version differs from the lock, naming the install command', () => {
    expect(versionRefusal('0.2.130', cliVersion('wasm-bindgen 0.2.114\n'))).toBe(
      'the wasm-bindgen CLI is 0.2.114 and Cargo.lock pins the wasm-bindgen crate at 0.2.130; install it with `cargo install --locked wasm-bindgen-cli --version 0.2.130`',
    )
    expect(versionRefusal('0.2.130', cliVersion(''))).toMatch(/not installed; install it with `cargo install --locked wasm-bindgen-cli --version 0\.2\.130`/)
    expect(versionRefusal(undefined, '0.2.130')).toBe('Cargo.lock pins no single wasm-bindgen version')
    expect(versionRefusal('0.2.130', cliVersion('wasm-bindgen 0.2.130'))).toBeUndefined()
  })

  it("holds the repository's own lock to one wasm-bindgen version", () => {
    const lock = fs.readFileSync(path.join(CRATE_DIR, '..', 'Cargo.lock'), 'utf8')
    expect(lockedVersion(lock, 'wasm-bindgen')).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('canopi-f47t.52.270: the module names no builder path', () => {
  // The home remaps to `~`, never `/home`, so a home path left unremapped (`/home/ana/...`) cannot pass for a remapped one.
  const remaps = ['--remap-path-prefix=/home/ana=~','--remap-path-prefix=/home/ana/.cargo=/cargo', '--remap-path-prefix=/src/canopi=/canopi']
  const places = { home: '/home/ana', cargoHome: '/home/ana/.cargo', root: '/src/canopi' }

  it('remaps the home, Cargo home and repository paths, the most specific last, so rustc applies it', () => {
    expect(moduleRustflags({ env: {}, ...places, mvp: false }).split('\x1f')).toEqual(remaps)
  })

  it("keeps the caller's flags first, from CARGO_ENCODED_RUSTFLAGS over RUSTFLAGS as Cargo reads them, and MVP last", () => {
    expect(moduleRustflags({ env: { RUSTFLAGS: '-C debuginfo=0  -C opt-level=3' }, ...places, mvp: true }).split('\x1f'))
      .toEqual(['-C', 'debuginfo=0', '-C', 'opt-level=3', ...remaps, '-C', 'target-cpu=mvp'])
    expect(moduleRustflags({ env: { RUSTFLAGS: '-C debuginfo=0', CARGO_ENCODED_RUSTFLAGS: '-Cfoo=1\x1f-Cbar=2' }, ...places, mvp: false }).split('\x1f'))
      .toEqual(['-Cfoo=1', '-Cbar=2', ...remaps])
  })
})

describe('canopi-f47t.52.270: the module is built for size', () => {
  it('builds with the measured size settings through Cargo profile variables, so the root release profile Desktop uses stays as it is', () => {
    expect(MODULE_PROFILE).toEqual({
      CARGO_PROFILE_RELEASE_OPT_LEVEL: 's',
      CARGO_PROFILE_RELEASE_LTO: 'true',
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
    })
    const manifest = fs.readFileSync(path.join(CRATE_DIR, '..', 'Cargo.toml'), 'utf8')
    expect(manifest).not.toMatch(/opt-level\s*=\s*"s"/u)
  })

  it('binds without the name section, which only names functions for a debugger', () => {
    expect(BIND_ARGS).toEqual(['--target', 'web', '--no-typescript', '--remove-name-section'])
  })
})

/** The jobs of a workflow that run a Web build (`npm run build:web`, `build:web:bundle`) with no wasm32 target or no
 * wasm-bindgen CLI installed before it. */
function webBuildsWithoutModuleTools(workflow: string): string[] {
  const jobs = workflow.split(/\njobs:\n/u)[1]?.split(/\n(?= {2}[a-z][\w-]*:\n)/u) ?? []
  return jobs.flatMap((job) => {
    const build = job.search(/npm run build:web(?::bundle)?\b/u)
    if (build < 0) return []
    const before = job.slice(0, build)
    return /targets: wasm32-unknown-unknown/u.test(before) && /tool: wasm-bindgen@/u.test(before) ? [] : [job.trim().split(':')[0]!]
  })
}

describe('canopi-f47t.52.270: every CI Web build has the module tools', () => {
  it('names a job that builds the Web edition before installing the wasm32 target and the wasm-bindgen CLI', () => {
    const planted = ['on: push', 'jobs:', '  ready:', '    steps:', '      - uses: dtolnay/rust-toolchain@1.97.1', '        with:',
      '          targets: wasm32-unknown-unknown', '      - uses: taiki-e/install-action@v2', '        with:', '          tool: wasm-bindgen@0.2.130',
      '      - run: npm run build:web', '  bare:', '    steps:', '      - run: npm run build:web:bundle', '  other:', '    steps:', '      - run: npm test', ''].join('\n')
    expect(webBuildsWithoutModuleTools(planted)).toEqual(['bare'])
  })

  it('installs both in every workflow job that builds the Web edition, the release candidate\'s included', () => {
    const workflows = path.join(CRATE_DIR, '..', '.github', 'workflows')
    const missing = fs.readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name)).flatMap((name) =>
      webBuildsWithoutModuleTools(fs.readFileSync(path.join(workflows, name), 'utf8')).map((job) => `${name} ${job}`))
    expect(missing).toEqual([])
  })
})

/** The one pin that is no literal: rollback.yml's reader-web builds an older reader tree and installs the version that
 * tree's own lock pins, which its reader-pins step reads (policy/gate/rollback-refs.test.ts runs the step). */
const READER_TREE_PIN = { workflow: 'rollback.yml', pin: '${{ steps.reader-pins.outputs.version }}' }

/** Each wasm-bindgen CLI pin in `workflows` (name, text) that is not `locked`, as `name: pin`; an expression or a tag
 * such as `latest` is a fault too, but for the reader tree's pin in rollback.yml. */
function pinFaults(workflows: readonly (readonly [string, string])[], locked: string | undefined): string[] {
  return workflows.flatMap(([name, text]) => [...text.matchAll(/\bwasm-bindgen(?:-cli)?@(\$\{\{[^}]*\}\}|[^\s,'"]+)/gu)]
    .map((match) => match[1]!)
    .filter((pin) => pin !== locked && !(name === READER_TREE_PIN.workflow && pin === READER_TREE_PIN.pin))
    .map((pin) => `${name}: ${pin}`))
}

describe('canopi-f47t.52.270: the wasm-bindgen CLI pinned in CI is the lock version', () => {
  it('refuses any other version, a tag or an expression, but the reader tree\'s own pin in rollback.yml', () => {
    const tool = (pin: string) => `          tool: wasm-bindgen@${pin}\n`
    expect(pinFaults([
      ['build.yml', tool('0.2.130') + tool('0.2.114') + tool('latest') + tool('${{ env.WASM_BINDGEN }}')],
      ['rollback.yml', tool(READER_TREE_PIN.pin) + tool('${{ steps.other.outputs.version }}')],
      ['other.yml', tool(READER_TREE_PIN.pin) + '        run: cargo install wasm-bindgen-cli@0.2.99\n'],
    ], '0.2.130')).toEqual(['build.yml: 0.2.114', 'build.yml: latest', 'build.yml: ${{ env.WASM_BINDGEN }}',
      'rollback.yml: ${{ steps.other.outputs.version }}', `other.yml: ${READER_TREE_PIN.pin}`, 'other.yml: 0.2.99'])
  })

  it('installs, in every workflow, the wasm-bindgen CLI at the version Cargo.lock pins for the crate', () => {
    const repo = path.join(CRATE_DIR, '..')
    const locked = lockedVersion(fs.readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'wasm-bindgen')
    const workflows = path.join(repo, '.github', 'workflows')
    const texts = fs.readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => [name, fs.readFileSync(path.join(workflows, name), 'utf8')] as const)
    expect(texts.flatMap(([, text]) => [...text.matchAll(/\bwasm-bindgen(?:-cli)?@[0-9]/gu)]).length).toBeGreaterThan(0)
    expect(pinFaults(texts, locked)).toEqual([])
    expect(texts.find(([name]) => name === READER_TREE_PIN.workflow)?.[1]).toContain(`wasm-bindgen@${READER_TREE_PIN.pin}`)
  })
})
