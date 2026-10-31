import type { ConfigEnv, UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import viteConfig from '../../vite.config'
import cargoManifestText from '../../../Cargo.toml?raw'
import mainWindowCapabilityText from '../../../capabilities/main-window.json?raw'
import tauriConfigText from '../../../tauri.conf.json?raw'
import releaseUpdaterOverlayText from '../../../../.github/tauri-release-updater.json?raw'

// The Desktop install identity and what the bundle registers, held over the config files (canopi-f47t.52.228.15).
// The identifier, product name and WebView scheme decide where the WebView keeps IndexedDB and localStorage, so a
// change loses every installed user's Drafts and settings (2.1-M82); the MSI UpgradeCode decides whether a new MSI
// replaces 2.0.3 or installs beside it (2.1-M205).

interface TauriConfig {
  readonly identifier: string
  readonly productName: string
  readonly app: { readonly windows: readonly { readonly label: string, readonly useHttpsScheme?: boolean }[] }
  readonly bundle: {
    readonly category?: string
    readonly createUpdaterArtifacts?: unknown
    readonly fileAssociations?: readonly Readonly<Record<string, unknown>>[]
    readonly linux: {
      readonly appimage?: Readonly<Record<string, unknown>>
      readonly deb: {
        readonly depends?: readonly string[]
        readonly desktopTemplate?: string
        readonly files?: Readonly<Record<string, string>>
        readonly postInstallScript?: string
      }
    }
    readonly windows?: {
      readonly signCommand?: unknown
      readonly allowDowngrades?: boolean
      readonly wix?: { readonly upgradeCode?: string }
      readonly nsis?: { readonly languages?: readonly string[], readonly displayLanguageSelector?: boolean }
    }
  }
  readonly plugins?: {
    readonly updater?: {
      readonly pubkey?: string
      readonly dangerousInsecureTransportProtocol?: unknown
      readonly allowDowngrades?: boolean
      readonly requireSignedVersion?: boolean
    }
  }
}

const tauriConfig = JSON.parse(tauriConfigText) as TauriConfig
/** desktop/tauri.macos.conf.json, the platform file the Tauri CLI merges into tauri.conf.json on macOS, when present. */
const macosConfigText = Object.values(import.meta.glob<string>('../../../tauri.macos.conf.json', { query: '?raw', import: 'default', eager: true }))[0]
/** desktop/linux/'s files by their path from desktop/ (tauri.conf.json's base), read as text. */
const linuxFiles = Object.fromEntries(Object.entries(import.meta.glob<string>('../../../linux/*', { query: '?raw', import: 'default', eager: true }))
  .map(([path, text]) => [path.replace(/^(?:\.\.\/)+/u, ''), text]))
const CANOPI_MIME_TYPE = 'application/x-canopi'

describe('Desktop install identity', () => {
  it('keeps the identifier, product name and WebView scheme 2.0.3 runs with, so installed data stays reachable', () => {
    expect({
      identifier: tauriConfig.identifier,
      productName: tauriConfig.productName,
      httpsScheme: tauriConfig.app.windows.map((window) => [window.label, window.useHttpsScheme ?? false]),
    }).toEqual({ identifier: 'com.canopi.app', productName: 'Canopi', httpsScheme: [['main', false]] })
  })

  // v2.0.3's MSI carries tauri's derived default, uuid5(DNS, "Canopi.exe.app.x64") (F6 probe 3): written out, so a
  // renamed binary or product never makes the next MSI install beside 2.0.3 instead of replacing it.
  it('pins the MSI UpgradeCode v2.0.3 shipped with', () => {
    expect(tauriConfig.bundle.windows?.wix?.upgradeCode?.toLowerCase()).toBe('eebf4ea9-a99e-5493-953a-aa0dbf45b8d5')
  })

  // Two separate keys (2.1-M64): the installers' bundle.windows.allowDowngrades (tauri defaults it to true) lets a user
  // leaving beta run the stable installer by hand over the newer beta, while the updater's own key keeps the in-app
  // check at must be newer and requireSignedVersion binds each signature to its version.
  it('lets the Windows installers take a by-hand rollback while the updater refuses any not-newer update (2.1-M64)', () => {
    expect({
      installer: tauriConfig.bundle.windows?.allowDowngrades ?? true,
      updater: tauriConfig.plugins?.updater?.allowDowngrades ?? false,
      signed: tauriConfig.plugins?.updater?.requireSignedVersion,
    }).toEqual({ installer: true, updater: false, signed: true })
  })

  // The NSIS language each app locale installs in: Canopi's Portuguese is Brazilian and its Chinese Simplified. Each
  // name has a translation of tauri's own installer messages in the bundler (tauri-cli 2.12.3). The installer follows
  // Windows' display language with no selector, which would stop every passive update on its dialog (2.1-Q260).
  it('offers the Windows installer in every app locale, in the Windows display language without a selector (2.1-Q260)', () => {
    const nsisLanguage: Readonly<Record<string, string>> = {
      de: 'German', en: 'English', es: 'Spanish', fr: 'French', it: 'Italian', ja: 'Japanese', ko: 'Korean', nl: 'Dutch',
      pt: 'PortugueseBR', ru: 'Russian', zh: 'SimpChinese',
    }
    const locales = Object.keys(import.meta.glob('../i18n/*.json')).map((path) => path.replace(/^.*\/(\w+)\.json$/u, '$1'))
    const nsis = tauriConfig.bundle.windows?.nsis

    expect({
      first: nsis?.languages?.[0],
      languages: [...(nsis?.languages ?? [])].sort(),
      selector: nsis?.displayLanguageSelector,
    }).toEqual({ first: 'English', languages: locales.map((locale) => nsisLanguage[locale] ?? `no NSIS language for ${locale}`).sort(), selector: false })
  })

  // The updater verifies every payload against this key, so an empty or malformed one refuses every update on every
  // installer (update_signature_refused). tauri's form: base64 of minisign's two-line public key file, whose key line
  // is base64 of "Ed", an 8-byte key id and the 32-byte Ed25519 key (2.1-Q230).
  it('ships the updater a minisign public key (2.1-Q230, 2.1-Q253, canopi-f47t.52.228.15)', () => {
    expect(minisignPublicKey(tauriConfig.plugins?.updater?.pubkey ?? '')).toBe(true)
  })

  // Updater artifacts come from the Release Candidate's overlay on Linux and Windows only, so a local or branch build
  // never asks for the signing key and macOS keeps its dmg (2.1-Q135, 2.1-M242); plain HTTP reaches the updater only
  // in the end-to-end lane's own overlay, never the shipped config.
  it('builds updater artifacts only through the release overlay and never lets the updater use plain HTTP', () => {
    expect({
      artifacts: tauriConfig.bundle.createUpdaterArtifacts,
      insecure: tauriConfig.plugins?.updater?.dangerousInsecureTransportProtocol,
      overlay: JSON.parse(releaseUpdaterOverlayText) as unknown,
    }).toEqual({ artifacts: undefined, insecure: undefined, overlay: { bundle: { createUpdaterArtifacts: true } } })
  })

  it('tells a minisign public key from an empty or malformed one', () => {
    const keyLine = btoa(`Ed${'\x01'.repeat(8)}${'\x02'.repeat(32)}`)
    const file = (comment: string, key: string) => btoa(`${comment}\n${key}\n`)

    expect({
      key: minisignPublicKey(file('untrusted comment: minisign public key: 0101010101010101', keyLine)),
      empty: minisignPublicKey(''),
      noComment: minisignPublicKey(file('a comment', keyLine)),
      shortKey: minisignPublicKey(file('untrusted comment: minisign public key', keyLine.slice(0, 20))),
    }).toEqual({ key: true, empty: false, noComment: false, shortKey: false })
  })

  it('never lets a TAURI_ variable, the updater signing key among them, reach the frontend bundle', async () => {
    const prefixes = await Promise.all(['production', 'web'].map(async (mode) => {
      const config = await resolveViteConfig(mode)
      return [config.envPrefix ?? 'VITE_'].flat()
    }))

    expect(prefixes.flat().filter((prefix) => 'TAURI_SIGNING_PRIVATE_KEY'.startsWith(prefix))).toEqual([])
  })
})

describe('Desktop host surface', () => {
  it('grants the webview no updater permission: updates run through the host commands only', () => {
    const capability = JSON.parse(mainWindowCapabilityText) as { readonly permissions: readonly string[] }

    expect(capability.permissions.filter((permission) => permission.startsWith('updater:'))).toEqual([])
  })

  it('depends only on the adopted Tauri plugins', () => {
    const adopted = ['tauri-plugin-dialog', 'tauri-plugin-mcp-bridge', 'tauri-plugin-opener', 'tauri-plugin-single-instance', 'tauri-plugin-updater']

    expect(tauriPluginsNamedIn(cargoManifestText).filter((plugin) => !adopted.includes(plugin))).toEqual([])
  })

  it('sees a Tauri plugin however the manifest declares it', () => {
    const manifest = [
      '[dependencies]',
      'tauri-plugin-dialog = "2"',
      'tauri-plugin-fs.workspace = true',
      'shell = { package = "tauri-plugin-shell", version = "2" }',
      '# tauri-plugin-commented-out = "2"',
      '[target.\'cfg(windows)\'.dependencies.tauri-plugin-deep-link]',
      'version = "2"',
    ].join('\n')

    expect(tauriPluginsNamedIn(manifest)).toEqual(['tauri-plugin-dialog', 'tauri-plugin-fs', 'tauri-plugin-shell', 'tauri-plugin-deep-link'])
  })

  it('signs no Windows artifact until the SignPath grant', () => {
    expect(tauriConfig.bundle.windows?.signCommand).toBeUndefined()
  })
})

// A .canopi opened from the file manager reaches Canopi as a launch argument, which F5 opens or forwards to the
// running window (2.1-Q145, 2.1-M85). Windows' NSIS and MSI register the type from bundle.fileAssociations; the .deb
// installs a desktop file passing the files and a shared-mime-info package; the AppImage stays unintegrated.
describe('.canopi file association', () => {
  it('registers .canopi with the Windows installers and the .deb, and gives the AppImage no system integration', () => {
    const { category, fileAssociations, linux } = tauriConfig.bundle

    expect({ category, fileAssociations, deb: linux.deb, appimage: linux.appimage }).toEqual({
      category: 'Education',
      fileAssociations: [{ ext: ['canopi'], name: 'Canopi Design', description: 'Canopi design', mimeType: CANOPI_MIME_TYPE, role: 'Editor' }],
      deb: {
        section: 'science',
        depends: ['libwebkit2gtk-4.1-0 | libwebkit2gtk-4.1-0t64', 'libgtk-3-0 | libgtk-3-0t64'],
        desktopTemplate: 'linux/canopi.desktop.hbs',
        files: { '/usr/share/mime/packages/canopi.xml': 'linux/canopi-mime.xml' },
        postInstallScript: 'linux/postinst.sh',
      },
      appimage: undefined,
    })
  })

  // macOS receives an opened document as an Apple Event, which no Canopi code reads, so a macOS bundle registering the
  // type would offer Canopi for a file it never opens (2.1-M85: no build registers the type without opening it; Q135).
  it('registers no file type in the macOS bundle (canopi-f47t.52.228)', () => {
    const macos = mergePatch(JSON.parse(tauriConfigText), macosConfigText === undefined ? {} : JSON.parse(macosConfigText)) as TauriConfig

    expect({ base: tauriConfig.bundle.fileAssociations?.length, macos: macos.bundle.fileAssociations }).toEqual({ base: 1, macos: undefined })
  })

  it('makes the .deb desktop file pass the opened files and name the type its MIME package declares', () => {
    const desktopFile = linuxFiles['linux/canopi.desktop.hbs'] ?? ''
    const mimePackage = linuxFiles['linux/canopi-mime.xml'] ?? ''
    const postInstall = linuxFiles['linux/postinst.sh'] ?? ''

    expect({
      exec: desktopFile.match(/^Exec=.*$/mu)?.[0],
      mimeType: desktopFile.match(/^MimeType=.*$/mu)?.[0],
      categories: desktopFile.match(/^Categories=.*$/mu)?.[0],
      declares: mimePackage.includes(`<mime-type type="${CANOPI_MIME_TYPE}">`) && mimePackage.includes('<glob pattern="*.canopi"/>'),
      refreshes: /^\s*update-mime-database \/usr\/share\/mime$/mu.test(postInstall),
    }).toEqual({
      exec: 'Exec={{exec}} %F',
      mimeType: `MimeType=${CANOPI_MIME_TYPE};`,
      categories: 'Categories={{categories}}Science;',
      declares: true,
      refreshes: true,
    })
  })
})

/** `target` with the JSON merge patch `patch` applied (RFC 7396), as the Tauri CLI merges a platform config file. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const merged: Record<string, unknown> = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = mergePatch(merged[key], value)
  }
  return merged
}

/** Whether `pubkey` is tauri's form of a minisign public key: base64 of an "untrusted comment:" line and a key line
 * that decodes to "Ed", an 8-byte key id and a 32-byte Ed25519 key. */
function minisignPublicKey(pubkey: string): boolean {
  const [comment, key] = decodeBase64(pubkey)?.split('\n') ?? []
  const bytes = decodeBase64(key?.trim() ?? '')
  return comment?.startsWith('untrusted comment:') === true && bytes?.length === 42 && bytes.startsWith('Ed')
}

/** `text`'s base64 decoded to a binary string, or undefined when it is not base64. */
function decodeBase64(text: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) return undefined
  try {
    return atob(text)
  } catch {
    return undefined
  }
}

/** Every Tauri plugin crate a Cargo manifest names outside comments: as a key, a dotted key, a table header or a renamed
 * dependency's `package`, in any dependency section. */
function tauriPluginsNamedIn(manifest: string): string[] {
  const code = manifest.split('\n').map((line) => line.replace(/^((?:[^"#]|"[^"]*")*)#.*$/u, '$1')).join('\n')
  return [...new Set([...code.matchAll(/(?<![\w-])tauri-plugin-[\w-]*\w/gu)].map((match) => match[0]))]
}

async function resolveViteConfig(mode: string): Promise<UserConfig> {
  if (typeof viteConfig !== 'function') return viteConfig
  const environment: ConfigEnv = { command: 'build', mode, isSsrBuild: false, isPreview: false }
  return Promise.resolve(viteConfig(environment))
}
