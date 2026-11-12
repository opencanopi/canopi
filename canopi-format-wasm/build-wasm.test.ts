// The format module's build (Step 2.0.4 R1-1, canopi-f47t.52.270): the CLI that binds it must be the version Cargo.lock
// pins for the wasm-bindgen crate, and the build refuses any other with the install command, as every workflow installs
// that version; the builder's paths are remapped out of the module. web-build-configuration.test.ts holds the Web
// build to building it first.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRATE_DIR, cliVersion, lockedVersion, moduleRustflags, versionRefusal } from './build-wasm.mjs'

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

describe('canopi-f47t.52.270: the wasm-bindgen CLI pinned in CI is the lock version', () => {
  it('installs, in every workflow, the wasm-bindgen CLI at the version Cargo.lock pins for the crate', () => {
    const repo = path.join(CRATE_DIR, '..')
    const locked = lockedVersion(fs.readFileSync(path.join(repo, 'Cargo.lock'), 'utf8'), 'wasm-bindgen')
    const workflows = path.join(repo, '.github', 'workflows')
    const pins = fs.readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name)).flatMap((name) =>
      [...fs.readFileSync(path.join(workflows, name), 'utf8').matchAll(/\bwasm-bindgen(?:-cli)?@([^\s,'"]+)/gu)].map((m) => `${name}: ${m[1]}`))
    expect(pins.length).toBeGreaterThan(0)
    expect(pins.filter((pin) => !pin.endsWith(`: ${locked}`))).toEqual([])
  })
})
