import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Tests run from desktop/web.
const desktop = resolve(process.cwd(), '..')
const notices = readFileSync(resolve(desktop, 'THIRD_PARTY_NOTICES.md'), 'utf8')
// The lockfile is the pin. A package's own package.json may spell its version
// differently (geotiff-geokeys-to-proj4 2026.8.16 said 2026.08.16, which npm resolved as 2026.8.16).
const lockfile = JSON.parse(readFileSync(resolve(desktop, 'web/package-lock.json'), 'utf8')) as {
  packages: Record<string, { version: string }>
}
const installed = (name: string): string => lockfile.packages[`node_modules/${name}`]!.version

describe('third-party notices', () => {
  it.each([
    'maplibre-gl-raster',
    'cog-tiler-wasm',
    'whitebox-wasm',
    '@deck.gl/core',
    '@luma.gl/core',
    'geotiff',
    'proj4',
    'geotiff-geokeys-to-proj4',
    'maplibre-gl',
  ])('names the installed version of %s', (name) => {
    expect(notices).toContain(`| ${name} | ${installed(name)} |`)
  })

  it('names the GeoLibre revision the app records as provenance', () => {
    const geolibre = readFileSync(resolve(desktop, 'src/services/lidar/geolibre.rs'), 'utf8')
    const revision = /GEOLIBRE_REVISION: &str = "([0-9a-f]{40})"/.exec(geolibre)?.[1]
    expect(revision).toBeDefined()
    expect(notices).toContain(revision!)
  })

  // wbspatialstats declares AGPL-3.0-or-later in its own Cargo.toml. It is not linked into
  // the Canopi binary: it ships in the GeoLibre CLI sidecar and the whitebox-wasm module,
  // whatever the package-level labels say.
  it('names the AGPL-3.0-or-later component, that the binary does not link it, and where its source is offered', () => {
    expect(notices).toMatch(/\| wbspatialstats \| [^|]+not the Canopi binary \| https:\/\/github\.com\/opengeos\/whitebox-wasm \| AGPL-3\.0-or-later \|/)
    expect(notices).toContain('9c0ff4fdf3513f27b89c78e294610c3b418b3a4f')
    expect(notices).toMatch(/Corresponding Source/)
  })

  // proj4rs is the raster engine's one CRS authority (U31); its row names the version
  // Cargo.lock pins.
  it('names the proj4rs version Cargo.lock pins', () => {
    const lock = readFileSync(resolve(desktop, '../Cargo.lock'), 'utf8')
    const version = /\[\[package\]\]\nname = "proj4rs"\nversion = "([^"]+)"/.exec(lock)?.[1]
    expect(version).toBeDefined()
    expect(notices).toContain(`| proj4rs | ${version} | https://github.com/3liz/proj4rs | MIT OR Apache-2.0 |`)
  })

  // crs_table.rs carries rows derived from the EPSG Geodetic Parameter Dataset, whose terms
  // of use require the IOGP attribution, in both notices: the shipped one and the one for
  // copied code.
  it('attributes the EPSG Geodetic Parameter Dataset to IOGP in both notices', () => {
    const copied = readFileSync(resolve(desktop, '../THIRD_PARTY_NOTICES.md'), 'utf8')
    for (const text of [notices, copied]) {
      expect(text).toMatch(/EPSG Geodetic Parameter Dataset[\s\S]*IOGP/)
      expect(text).toContain('crs_table.rs')
    }
  })

  // Every Whitebox or GeoLibre crate compiled into the Canopi binary has a row naming the
  // pinned version and revision, so a new git dependency cannot ship without a notice.
  it('names every opengeos and whitebox crate Cargo.lock pins, at its exact version and revision', () => {
    const lock = readFileSync(resolve(desktop, '../Cargo.lock'), 'utf8')
    const compiledIn = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = "git\+https:\/\/github\.com\/opengeos\/([^?#"]+)[^"#]*#([0-9a-f]{40})"/g)]
      .map(([, name, version, repo, revision]) => ({ name, version, repo, revision }))
    expect(compiledIn.map((crate) => crate.name)).toContain('wbgeotiff')
    for (const crate of compiledIn) {
      expect(notices, crate.name).toContain(`| ${crate.name} | ${crate.version} at ${crate.revision} | https://github.com/opengeos/${crate.repo} |`)
    }
  })
})
