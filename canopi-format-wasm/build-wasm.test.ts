// The wasm-bindgen pin (Step 2.0.4 R1-1, canopi-f47t.52.270): the CLI that binds the format worker's module must be the
// version Cargo.lock pins for the wasm-bindgen crate, and the build refuses any other with the install command.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRATE_DIR, cliVersion, lockedVersion, versionRefusal } from './build-wasm.mjs'

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
