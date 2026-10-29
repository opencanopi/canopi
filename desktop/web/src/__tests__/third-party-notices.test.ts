import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// One generated file at the repository root (2.1-Q221, 2.1-M216): scripts/generate_notices.mjs merges the npm
// packages both editions bundle (rollup-plugin-license, written by each build), the crates the Desktop binary links
// (cargo-about) and the hand rows of scripts/notices-hand-rows.json. Keyed by name and licence, never by version
// (2.1-M239): a bump passes, a new package or a changed licence fails until the file is regenerated.
// Tests run from desktop/web.
const root = resolve(process.cwd(), '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const notices = read('THIRD_PARTY_NOTICES.md')
const handRows = JSON.parse(read('scripts/notices-hand-rows.json')) as HandRows

interface Row { readonly name: string; readonly license: string | null; readonly version?: string; readonly texts?: readonly string[] }
interface Clarification { readonly license?: string; readonly text?: readonly string[]; readonly reason: string }
interface HandRows { readonly clarifications: { readonly npm: Record<string, Clarification> } }
interface Generator {
  renderNotices(input: { handRows: unknown; npm: readonly Row[]; crates: readonly Row[] }): string
  parseNotices(text: string): { npm: Row[]; crates: Row[] }
  npmLicenceTexts(options: { webDir: string; rows: readonly Row[]; clarifications: Record<string, Clarification> }): Row[]
  cratesFromAbout(output: string): Row[]
  crateTexts(rows: readonly Row[], clarifications: Record<string, Clarification>): Row[]
  missingFromNotices(text: string, bundled: readonly Row[]): string[]
  writeNotices(target: string, text: string, options: { check: boolean }): boolean
  bundledPackages(options: { dir: string; run(edition: string): void }): Row[]
  CARGO_ABOUT_VERSION: string
  cargoAboutVersionProblem(versionOutput: string): string | null
}
const generator = (await import(pathToFileURL(resolve(root, 'scripts/generate_notices.mjs')).href)) as Generator

const mit = (holder: string) => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge.\n`
const npmFixture: Row[] = [
  { name: 'preact', license: 'MIT', version: '11.0.1', texts: [mit('2015-present Jason Miller')] },
  { name: '@duckdb/duckdb-wasm', license: 'MIT', version: '1.33.1', texts: [mit('2018-2025 Stichting DuckDB Foundation')] },
  { name: 'png-js', license: null, version: '1.0.0', texts: [mit('2017 Devon Govett')] },
]
const crateFixture: Row[] = [
  { name: 'serde', license: 'MIT OR Apache-2.0', version: '1.0.0', texts: ['Permission is hereby granted, free of charge.\n'] },
  { name: 'proj4rs', license: 'MIT OR Apache-2.0', version: '0.2.0', texts: ['Permission is hereby granted, free of charge.\n'] },
]

// The hand rows with only the clarification the fixtures bundle a package for (png-js declares no licence).
const fixtureHand = { ...handRows, clarifications: { npm: { 'png-js': handRows.clarifications.npm['png-js']! }, crates: {} } }

describe('the notices generator', () => {
  it('lists every bundled npm package and every linked crate with its licence, in no version', () => {
    const text = generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates: crateFixture })
    expect(text).toContain('| `preact` | MIT |')
    expect(text).toContain('| `@duckdb/duckdb-wasm` | MIT |')
    expect(text).toContain(`| \`png-js\` | ${fixtureHand.clarifications.npm['png-js'].license} |`)
    expect(text).toContain('| `serde` | MIT OR Apache-2.0 |')
    for (const row of [...npmFixture, ...crateFixture]) expect(text).not.toContain(row.version)
    expect(generator.parseNotices(text).npm.map((row) => row.name)).toEqual(['@duckdb/duckdb-wasm', 'png-js', 'preact'])
  })

  // MIT, BSD, ISC and Apache binary copies carry the licence text and its copyright notice (2.1-Q221); a text many
  // packages share is written once, under an id each row names.
  it('writes each package\'s licence text with its copyright line, identical texts once (canopi-f47t.52.228 open item 8)', () => {
    const shared = mit('2015-present Jason Miller')
    const text = generator.renderNotices({
      handRows: fixtureHand,
      npm: [...npmFixture, { name: 'preact-render-to-string', license: 'MIT', texts: [shared.replace('free of charge.', 'free\r\nof   charge.')] }],
      crates: crateFixture,
    })
    expect(text).toContain('Copyright (c) 2015-present Jason Miller')
    expect(text).toContain('Copyright (c) 2018-2025 Stichting DuckDB Foundation')
    expect(text.split('Copyright (c) 2015-present Jason Miller').length).toBe(2)
    // serde and proj4rs share one text.
    expect(text).toMatch(/^\| `proj4rs` \| MIT OR Apache-2\.0 \| ([0-9a-f]{8}) \|\n\| `serde` \| MIT OR Apache-2\.0 \| \1 \|$/m)
    const id = /^\| `preact` \| MIT \| ([0-9a-f]{8}) \|$/m.exec(text)?.[1]
    expect(id).toBeDefined()
    expect(text).toContain(`| \`preact-render-to-string\` | MIT | ${id} |`)
    expect(text).toMatch(new RegExp(`^### ${id}\\n\\n\`\`\`\\nMIT License\\n\\nCopyright \\(c\\) 2015-present Jason Miller\\n`, 'm'))
    const parsed = generator.parseNotices(text)
    expect(parsed.npm.find((row) => row.name === 'preact')?.texts).toEqual([shared])
    expect(generator.renderNotices({ handRows: fixtureHand, npm: parsed.npm, crates: parsed.crates })).toBe(text)
  })

  it('refuses a package or crate with no licence text, and fences a text holding a fence', () => {
    expect(() => generator.renderNotices({ handRows: fixtureHand, npm: [...npmFixture, { name: 'mute', license: 'MIT', texts: [] }], crates: [] }))
      .toThrow(/mute.*no licence text/)
    expect(() => generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates: [{ name: 'quiet', license: 'MIT' }] })).toThrow(/quiet.*no licence text/)
    const fenced = generator.renderNotices({ handRows: fixtureHand, npm: [...npmFixture, { name: 'md', license: 'MIT', texts: ['Copyright (c) md\n\n```\ncode\n```\n'] }], crates: [] })
    expect(fenced).toContain('````\nCopyright (c) md\n\n```\ncode\n```\n````')
    expect(generator.parseNotices(fenced).npm.find((row) => row.name === 'md')?.texts).toEqual(['Copyright (c) md\n\n```\ncode\n```\n'])
  })

  // The licence and notice files of the installed copies package-lock.json names; a package that ships none gets the
  // upstream text as a hand clarification, which goes stale (and is refused) once the package ships its own.
  it('reads each npm package\'s licence and notice files, or its hand text when it ships none (canopi-f47t.52.228 open item 8)', () => {
    const webDir = mkdtempSync(join(tmpdir(), 'canopi-notices-web-'))
    try {
      const files: Record<string, string> = {
        'node_modules/a/LICENSE': mit('2020 A'),
        'node_modules/a/NOTICE.txt': 'A\nCopyright 2020 The A Foundation\n',
        'node_modules/a/LICENSE.spdx': 'SPDX-License-Identifier: MIT\n',
        'node_modules/a/README.md': 'Copyright nobody\n',
        'node_modules/b/index.js': '',
        'node_modules/x/node_modules/c/licence.md': mit('2021 C'),
        'node_modules/d/LICENSE-MIT': mit('2022 D'),
        'node_modules/d/LICENSE-APACHE': 'Apache License\n',
      }
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(webDir, path)), { recursive: true })
        writeFileSync(join(webDir, path), body)
      }
      const packages = { '': {}, 'node_modules/a': {}, 'node_modules/b': {}, 'node_modules/x/node_modules/c': {}, 'node_modules/d': {}, 'node_modules/e': { dev: true } }
      writeFileSync(join(webDir, 'package-lock.json'), JSON.stringify({ packages }))
      const clarifications = { b: { text: ['MIT License', '', 'Copyright (c) B'], reason: 'ships no licence file' } }
      const rows = generator.npmLicenceTexts({
        webDir, clarifications,
        rows: [{ name: 'a', license: 'MIT' }, { name: 'b', license: 'MIT' }, { name: 'c', license: 'MIT' }, { name: 'd', license: 'MIT OR Apache-2.0' }],
      })
      expect(rows.map((row) => [row.name, row.texts])).toEqual([
        ['a', [mit('2020 A'), 'A\nCopyright 2020 The A Foundation\n']],
        ['b', ['MIT License\n\nCopyright (c) B\n']],
        ['c', [mit('2021 C')]],
        ['d', ['Apache License\n', mit('2022 D')]],
      ])
      expect(() => generator.npmLicenceTexts({ webDir, clarifications: {}, rows: [{ name: 'b', license: 'MIT' }] }))
        .toThrow(/b ships no licence file.*scripts\/notices-hand-rows\.json/)
      expect(() => generator.npmLicenceTexts({ webDir, clarifications: { a: { text: ['x'], reason: '' } }, rows: [{ name: 'a', license: 'MIT' }] }))
        .toThrow(/a ships its own licence file.*delete/)
    } finally {
      rmSync(webDir, { recursive: true, force: true })
    }
  })

  // about.hbs writes the crates and the licence texts cargo-about found in each crate's source, with the crates using each.
  it('reads each crate\'s licence texts from cargo-about, leaving out Canopi\'s own crates (canopi-f47t.52.228 open item 8)', () => {
    const registry = 'registry+https://github.com/rust-lang/crates.io-index'
    const output = JSON.stringify({
      crates: [
        { name: 'serde', license: 'MIT OR Apache-2.0', source: registry },
        { name: 'serde', license: 'MIT OR Apache-2.0', source: registry },
        { name: 'ring', license: 'Apache-2.0 AND ISC', source: registry },
        { name: 'canopi-desktop', license: 'AGPL-3.0-or-later', source: '' },
      ],
      licenses: [
        { text: 'Apache\n', used_by: [{ name: 'ring', source: registry }] },
        { text: mit('serde'), used_by: [{ name: 'serde', source: registry }, { name: 'ring', source: registry }] },
        { text: 'AGPL\n', used_by: [{ name: 'canopi-desktop', source: '' }] },
      ],
    })
    expect(generator.cratesFromAbout(output)).toEqual([
      { name: 'serde', license: 'MIT OR Apache-2.0', texts: [mit('serde')] },
      { name: 'serde', license: 'MIT OR Apache-2.0', texts: [mit('serde')] },
      { name: 'ring', license: 'Apache-2.0 AND ISC', texts: ['Apache\n', mit('serde')] },
    ])
  })

  // cargo-about falls back to the SPDX template when it finds no licence file in a crate's source; the template's
  // placeholders are no copyright notice, so the crate's upstream text comes from a hand clarification instead.
  it('refuses a licence text still holding an SPDX template placeholder, and takes a crate\'s upstream text from its clarification (canopi-f47t.52.228 open item 8)', () => {
    const template = 'MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission is hereby granted.\n'
    for (const placeholder of ['<year> <owner>', '<copyright holders>', '<year>']) {
      const text = template.replace('<year> <copyright holders>', placeholder)
      expect(() => generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates: [{ name: 'objc2', license: 'MIT', texts: [text] }] }))
        .toThrow(/objc2.*template placeholder.*scripts\/notices-hand-rows\.json/)
      expect(() => generator.renderNotices({ handRows: fixtureHand, npm: [...npmFixture, { name: 'tmpl', license: 'MIT', texts: [text] }], crates: [] }))
        .toThrow(/tmpl.*template placeholder/)
    }
    const clarifications = { objc2: { text: ['MIT License', '', 'Copyright (c) Steven Sheldon'], reason: 'ships no licence file' } }
    const rows = generator.crateTexts([
      { name: 'objc2', license: 'MIT', texts: [template] },
      { name: 'objc2', license: 'MIT', texts: [template] },
      { name: 'dpi', license: 'Apache-2.0 AND MIT', texts: ['Apache License\n', template] },
      { name: 'serde', license: 'MIT', texts: [mit('serde')] },
    ], { ...clarifications, dpi: { text: ['Copyright (c) 2018 Jorge Aparicio'], reason: 'its MIT file is not matched' } })
    expect(rows.map((row) => [row.name, row.texts])).toEqual([
      ['objc2', ['MIT License\n\nCopyright (c) Steven Sheldon\n']],
      ['objc2', ['MIT License\n\nCopyright (c) Steven Sheldon\n']],
      ['dpi', ['Apache License\n', 'Copyright (c) 2018 Jorge Aparicio\n']],
      ['serde', [mit('serde')]],
    ])
    expect(generator.crateTexts([{ name: 'objc2', license: 'MIT', texts: [template] }], {})[0]?.texts).toEqual([template])
    expect(() => generator.crateTexts([{ name: 'objc2', license: 'MIT', texts: [mit('Mads Marquart')] }], clarifications))
      .toThrow(/objc2 ships its own licence text now.*delete/)
  })

  // Two linked versions of one crate share its clarification: the hand text is stale only once no version needs it.
  it('keeps a crate\'s clarification while one linked version still ships no licence text (canopi-f47t.52.228 open item 8)', () => {
    const template = 'MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission is hereby granted.\n'
    const clarifications = { objc2: { text: ['MIT License', '', 'Copyright (c) Steven Sheldon'], reason: 'objc2 0.5 ships no licence file' } }
    const rows = generator.crateTexts([
      { name: 'objc2', license: 'MIT', texts: [template] },
      { name: 'objc2', license: 'MIT', texts: [mit('Mads Marquart')] },
    ], clarifications)
    expect(rows.map((row) => row.texts)).toEqual([['MIT License\n\nCopyright (c) Steven Sheldon\n'], [mit('Mads Marquart')]])
    expect(() => generator.crateTexts([
      { name: 'objc2', license: 'MIT', texts: [mit('Steven Sheldon')] },
      { name: 'objc2', license: 'MIT', texts: [mit('Mads Marquart')] },
    ], clarifications)).toThrow(/objc2 ships its own licence text now.*delete/)
  })

  // The GNU licences end with a "How to Apply These Terms" appendix whose sample notice reads "Copyright (C) <year>
  // <name of author>": a complete GNU text, not a template, so it ships whole and needs no clarification.
  it('keeps a complete GNU licence text, whose appendix holds a sample copyright line (canopi-f47t.52.228 open item 8)', () => {
    const gnu = [
      'GNU LESSER GENERAL PUBLIC LICENSE', 'Version 2.1, February 1999', '',
      'Copyright (C) 1991, 1999 Free Software Foundation, Inc.', '', 'TERMS AND CONDITIONS', '', 'END OF TERMS AND CONDITIONS', '',
      'How to Apply These Terms to Your New Libraries', '',
      '    <one line to give the library\'s name and a brief idea of what it does.>',
      '    Copyright (C) <year>  <name of author>', '',
      '  <signature of Ty Coon>, 1 April 1990', '',
    ].join('\n')
    const crates = [{ name: 'wbspatialstats', license: 'AGPL-3.0-or-later', texts: [gnu] }]
    expect(generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates })).toContain('    Copyright (C) <year>  <name of author>')
    expect(() => generator.crateTexts(crates, { wbspatialstats: { text: ['hand'], reason: '' } }))
      .toThrow(/wbspatialstats ships its own licence text now.*delete/)
    const templated = gnu.replace('Copyright (C) 1991, 1999', 'Copyright (C) <year>')
    expect(() => generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates: [{ ...crates[0]!, texts: [templated] }] }))
      .toThrow(/wbspatialstats.*template placeholder/)
  })

  it('refuses a package with no licence and no clarification, and a clarification for a package not bundled', () => {
    expect(() => generator.renderNotices({ handRows: fixtureHand, npm: [{ name: 'mystery', license: null }], crates: [] })).toThrow(/mystery/)
    expect(() => generator.renderNotices({ handRows: fixtureHand, npm: [], crates: [] })).toThrow(/png-js.*not bundled/)
  })

  it('--check fails, never writing, on an added package or a changed licence, and passes a version bump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-notices-'))
    const target = join(dir, 'THIRD_PARTY_NOTICES.md')
    const render = (npm: Row[], crates = crateFixture) => generator.renderNotices({ handRows: fixtureHand, npm, crates })
    expect(generator.writeNotices(target, render(npmFixture), { check: false })).toBe(true)
    const written = readFileSync(target, 'utf8')
    const bumped = npmFixture.map((row) => ({ ...row, version: '99.0.0' }))
    expect(generator.writeNotices(target, render(bumped), { check: true })).toBe(true)
    expect(generator.writeNotices(target, render([...npmFixture, { name: 'left-pad', license: 'WTFPL', texts: ['DO WHAT THE FUCK YOU WANT TO\n'] }]), { check: true })).toBe(false)
    expect(generator.writeNotices(target, render(npmFixture, [{ ...crateFixture[0]!, license: 'GPL-3.0-only' }, crateFixture[1]!]), { check: true })).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(written)
    rmSync(dir, { recursive: true })
  })

  it('writes the file through a temporary name and a rename, byte-identical on a rerun', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-notices-'))
    const target = join(dir, 'THIRD_PARTY_NOTICES.md')
    writeFileSync(target, 'old')
    const text = generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates: crateFixture })
    expect(generator.writeNotices(target, text, { check: false })).toBe(true)
    expect(generator.writeNotices(target, generator.renderNotices({ handRows: fixtureHand, npm: npmFixture, crates: crateFixture }), { check: true })).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(text)
    rmSync(dir, { recursive: true })
  })

  // A build that refuses a package the file does not name still writes its list first, so regenerating goes on past
  // that refusal; a list the build did not write this run (an earlier run's, or none) is never read.
  it('builds both editions for their lists, reading only lists this run wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopi-notices-'))
    const list = (edition: string, rows: Row[]) => writeFileSync(join(dir, `${edition}.json`), JSON.stringify(rows))
    const built: string[] = []
    expect(generator.bundledPackages({ dir, run: (edition) => { built.push(edition); list(edition, [{ name: edition, license: 'MIT' }]) } }))
      .toEqual([{ name: 'desktop', license: 'MIT' }, { name: 'web', license: 'MIT' }])
    expect(built).toEqual(['desktop', 'web'])
    // The web build stops before its bundle: the desktop list and the earlier web list are both left.
    expect(() => generator.bundledPackages({ dir, run: (edition) => { if (edition === 'desktop') list(edition, []) } }))
      .toThrow(/web\.json.*not written/)
    rmSync(dir, { recursive: true })
  })

  // A crate table from another cargo-about differs from CI's for a reason the line diff never names.
  it('refuses a cargo-about other than the pinned one, naming both versions', () => {
    const pinned = generator.CARGO_ABOUT_VERSION
    expect(generator.cargoAboutVersionProblem(`cargo-about ${pinned}\n`)).toBeNull()
    const problem = generator.cargoAboutVersionProblem('cargo-about 0.8.1\n')
    expect(problem).toContain('0.8.1')
    expect(problem).toContain(`cargo install --locked --version ${pinned} --features cli cargo-about`)
    expect(generator.cargoAboutVersionProblem(`cargo-about ${pinned}1\n`)).not.toBeNull()
    expect(read('.github/workflows/build.yml')).toContain(`tool: cargo-about@${pinned}\n`)
  })

  // Both edition builds take over a minute; a wrong local cargo-about fails before the first one starts.
  // Fake cargo and npm on PATH: the real script runs, and npm leaves a mark if a build was started.
  it.skipIf(process.platform === 'win32')('refuses a wrong cargo-about before it builds either edition', () => {
    const bin = mkdtempSync(join(tmpdir(), 'notices-bin-'))
    try {
      const built = join(bin, 'built')
      writeFileSync(join(bin, 'cargo'), '#!/bin/sh\necho "cargo-about 0.8.1"\n', { mode: 0o755 })
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\ntouch '${built}'\n`, { mode: 0o755 })
      const run = spawnSync(process.execPath, [resolve(root, 'scripts/generate_notices.mjs'), '--check'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain(`The notices need cargo-about ${generator.CARGO_ABOUT_VERSION}, found "cargo-about 0.8.1"`)
      expect(existsSync(built)).toBe(false)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('fails a build that bundles a package the file does not name with that licence', () => {
    expect(generator.missingFromNotices(notices, [{ name: 'preact', license: 'MIT' }])).toEqual([])
    expect(generator.missingFromNotices(notices, [{ name: 'left-pad', license: 'WTFPL' }, { name: 'preact', license: 'GPL-3.0-only' }]))
      .toEqual(['left-pad (WTFPL)', 'preact (GPL-3.0-only)'])
  })

  it('reads the file as a Windows checkout writes it, with CRLF line ends (canopi-f47t.52.228.46)', () => {
    expect(generator.missingFromNotices(notices.replaceAll('\n', '\r\n'), [{ name: 'preact', license: 'MIT' }])).toEqual([])
  })
})

describe('THIRD_PARTY_NOTICES.md', () => {
  const rows = generator.parseNotices(notices)

  it('is the one file, exactly as the generator renders it from its hand rows and lists', () => {
    expect(existsSync(resolve(root, 'desktop/THIRD_PARTY_NOTICES.md'))).toBe(false)
    expect(generator.renderNotices({ handRows, npm: rows.npm, crates: rows.crates })).toBe(notices)
  })

  it('gives every npm package and crate a licence text, an MIT one with its copyright line (canopi-f47t.52.228 open item 8)', () => {
    for (const row of [...rows.npm, ...rows.crates]) expect(row.texts?.length, row.name).toBeGreaterThan(0)
    expect(rows.npm.find((row) => row.name === 'preact')?.texts?.join('\n')).toContain('Copyright (c) 2015-present Jason Miller')
    expect(rows.npm.find((row) => row.name === 'apache-arrow')?.texts?.join('\n')).toMatch(/Apache Arrow[\s\S]*Copyright/)
  })

  it('holds no SPDX template placeholder in place of a copyright line (canopi-f47t.52.228 open item 8)', () => {
    for (const row of [...rows.npm, ...rows.crates]) {
      // A GNU text's "How to Apply These Terms" appendix holds a sample copyright line, not a placeholder for its own.
      for (const text of row.texts ?? []) {
        expect(text.split(/^\s*How to Apply These Terms/im)[0], row.name).not.toMatch(/^\s*Copyright\b.*<(?:year|owner|copyright holders)>/im)
      }
    }
    expect(rows.crates.find((row) => row.name === 'minisign-verify')?.texts?.join('\n')).toContain('Copyright (c) 2019-2025 Frank Denis')
  })

  // The lockfile is the pin: a licence change there without a regenerated file fails here, without a build.
  it('names each npm package with the licence package-lock.json records, and every runtime dependency', () => {
    const lock = JSON.parse(read('desktop/web/package-lock.json')) as { packages: Record<string, { license?: string; dev?: boolean }> }
    const locked = Object.entries(lock.packages).filter(([path, entry]) => path !== '' && !entry.dev)
      .map(([path, entry]) => ({ name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), license: entry.license ?? null }))
    for (const row of rows.npm) {
      const licenses = locked.filter((entry) => entry.name === row.name).map((entry) => entry.license ?? handRows.clarifications.npm[row.name]?.license)
      expect(licenses, row.name).toContain(row.license)
    }
    const { dependencies } = JSON.parse(read('desktop/web/package.json')) as { dependencies: Record<string, string> }
    for (const name of Object.keys(dependencies)) {
      expect(rows.npm.some((row) => row.name === name) || notices.includes(`\`${name}\``), name).toBe(true)
    }
  })

  it('names only crates Cargo.lock pins, and every runtime dependency of the Desktop crate', () => {
    const lock = new Set([...read('Cargo.lock').matchAll(/\[\[package\]\]\nname = "([^"]+)"/g)].map((match) => match[1]))
    for (const row of rows.crates) expect(lock, row.name).toContain(row.name)
    const manifest = read('desktop/Cargo.toml')
    const runtime = [...manifest.matchAll(/^\[(?:target\.[^\]]+\.)?dependencies\]\n([\s\S]*?)(?=^\[)/gm)].flatMap((section) =>
      section[1]!.split('\n').filter((line) => /^[\w-]+ = /.test(line) && !/optional = true|path = /.test(line)).map((line) => line.split(' ')[0]!))
    expect(runtime).toContain('wbgeotiff')
    for (const name of runtime) expect(rows.crates.map((row) => row.name), name).toContain(name)
  })

  it('carries the hand rows: copied code, the GeoLibre CLI sidecar, the CRS data, fonts and map data', () => {
    const revision = /GEOLIBRE_REVISION: &str = "([0-9a-f]{40})"/.exec(read('desktop/src/services/lidar/geolibre.rs'))?.[1]
    expect(revision).toBeDefined()
    expect(notices).toContain(revision!)
    // wbspatialstats declares AGPL-3.0-or-later; it ships in the sidecar and the whitebox-wasm module, not the binary.
    expect(notices).toMatch(/\| wbspatialstats \| [^|]+not the Canopi binary \| https:\/\/github\.com\/opengeos\/whitebox-wasm \| AGPL-3\.0-or-later \|/)
    expect(notices).toMatch(/Corresponding Source/)
    expect(notices).toMatch(/EPSG Geodetic Parameter Dataset[\s\S]*IOGP/)
    expect(notices).toMatch(/crs_table\.rs[\s\S]*proj4rs/)
    // Every copied file the GeoLibre table names still exists.
    const geolibre = notices.slice(notices.indexOf('## GeoLibre'), notices.indexOf('\n## ', notices.indexOf('## GeoLibre') + 1))
    const copied = [...geolibre.matchAll(/^\| `(desktop\/[^`]+)`/gm)].map((match) => match[1]!)
    expect(copied.length).toBeGreaterThan(4)
    for (const path of copied) expect(existsSync(resolve(root, path)), path).toBe(true)
    // Each pinned PDF font's upstream revision, and the licence of every bundled font.
    const fonts = JSON.parse(read('desktop/web/src/app/canvas-pdf/font-assets.json')) as { url: string }[]
    for (const { url } of fonts) {
      const [, repo, commit] = /^https:\/\/raw\.githubusercontent\.com\/notofonts\/([\w-]+)\/([0-9a-f]{40})\//.exec(url)!
      expect(notices, url).toContain(`https://github.com/notofonts/${repo}/tree/${commit}`)
    }
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(notices).toContain('OpenFreeMap')
  })

  // A new transitive crate or a removed package shows only in the full regeneration, so one package script runs the
  // lane and CI's notices job runs that same script. Its gate row (AGENTS.md, scripts/gate.py) is the merge agent's.
  it('is regenerated and checked by package scripts, the check being the one CI runs', () => {
    const { scripts } = JSON.parse(read('desktop/web/package.json')) as { scripts: Record<string, string> }
    expect(scripts['generate:notices']).toBe('node ../../scripts/generate_notices.mjs')
    expect(scripts['check:notices']).toBe('node ../../scripts/generate_notices.mjs --check')
    const workflow = read('.github/workflows/build.yml')
    expect(workflow).toContain('run: npm run check:notices --prefix desktop/web\n')
    expect(workflow).not.toMatch(/node \S*generate_notices\.mjs|build:(desktop|web):bundle --prefix/)
  })

  // A lane is real only when a gate row runs it too, so the regeneration runs before a push and not first in CI.
  it('runs in the Frontend gate before a push (merge agent applies the gate row, canopi-f47t.52.228.11)', () => {
    const frontendRow = read('AGENTS.md').split('\n').find(line => line.startsWith('| Frontend |'))
    expect(frontendRow).toContain('npm run check:notices')
  })

  // The policy checker's coverage and bundle-size adapters load the config from wherever `node policy/check.mjs` runs.
  it('loads the Vite config that collects the bundled packages from any working directory', () => {
    const vite = pathToFileURL(resolve(root, 'desktop/web/node_modules/vite/dist/node/index.js')).href
    const config = resolve(root, 'desktop/web/vite.config.ts')
    const load = `const { loadConfigFromFile } = await import(${JSON.stringify(vite)});
      await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(config)}, undefined, 'silent');`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', load], { cwd: tmpdir(), encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  }, 60_000)

  // Desktop ships it as a Tauri resource from the root, with or without the bundled plant DB; Web as a build file.
  it('ships in both editions from the root file', () => {
    const resources = (JSON.parse(read('desktop/tauri.conf.json')) as { bundle: { resources: Record<string, string> } }).bundle.resources
    expect(resources['../THIRD_PARTY_NOTICES.md']).toBe('THIRD_PARTY_NOTICES.md')
    const buildScript = read('desktop/build.rs')
    expect(buildScript).toContain('"../THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md"')
    expect(buildScript).toContain('cargo:rerun-if-changed=../THIRD_PARTY_NOTICES.md')
  })
})
