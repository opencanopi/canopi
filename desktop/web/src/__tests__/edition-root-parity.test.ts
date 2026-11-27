import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import viteConfig from '../../vite.config'
import tsconfig from '../../tsconfig.json'
import {
  capabilitiesForEdition,
  type EditionCapabilitySet,
  type RuntimeOs,
} from '../generated/edition-capabilities'
import type { EditionManifest } from '../platform/edition-manifest'
import { DESKTOP_EDITION_MANIFEST } from '../editions/desktop/manifest'
import { WEB_EDITION_MANIFEST } from '../editions/web/manifest'

const DELETED_ALIASES = [
  '#platform',
  '#species-catalog-live',
  '#canvas-pdf-platform',
  '#budget-export-platform',
  '#geocoding-transport',
] as const

const PARITY_DIMENSIONS = [
  'commands',
  'fileDelivery',
  'mapContributions',
  'panels',
  'settingsSlices',
  'keymap',
] as const

const ALL_RUNTIME_OS: readonly RuntimeOs[] = ['linux', 'linux-wayland', 'macos', 'windows']

interface EditionParityViolation {
  readonly dimension: (typeof PARITY_DIMENSIONS)[number]
  readonly id: string
  readonly presentIn: 'desktop' | 'web'
  readonly reason: string
}

function diffEditionManifests(
  desktop: EditionManifest,
  web: EditionManifest,
  desktopCaps: EditionCapabilitySet,
  webCaps: EditionCapabilitySet,
): EditionParityViolation[] {
  const violations: EditionParityViolation[] = []

  for (const dimension of PARITY_DIMENSIONS) {
    const desktopMap = new Map(desktop[dimension].map((e) => [e.id, e]))
    const webMap = new Map(web[dimension].map((e) => [e.id, e]))

    for (const [id, entry] of desktopMap) {
      if (webMap.has(id)) continue
      if (!entry.gatedBy) {
        violations.push({
          dimension,
          id,
          presentIn: 'desktop',
          reason: `present in desktop ${dimension} but missing in web with no gatedBy capability (ADR 0030)`,
        })
        continue
      }
      if (!(desktopCaps.has(entry.gatedBy) && !webCaps.has(entry.gatedBy))) {
        violations.push({
          dimension,
          id,
          presentIn: 'desktop',
          reason: `desktop-only ${dimension} entry cites '${entry.gatedBy}', which does not distinguish desktop from web`,
        })
      }
    }

    for (const [id, entry] of webMap) {
      if (desktopMap.has(id)) continue
      if (entry.insteadOf) {
        if (!(desktopCaps.has(entry.insteadOf) && !webCaps.has(entry.insteadOf))) {
          violations.push({
            dimension,
            id,
            presentIn: 'web',
            reason: `web-only ${dimension} entry cites insteadOf '${entry.insteadOf}', which Desktop does not uniquely hold`,
          })
        }
        continue
      }
      if (!entry.gatedBy) {
        violations.push({
          dimension,
          id,
          presentIn: 'web',
          reason: `present in web ${dimension} but missing in desktop with no gatedBy or insteadOf capability (ADR 0030)`,
        })
        continue
      }
      if (!(webCaps.has(entry.gatedBy) && !desktopCaps.has(entry.gatedBy))) {
        violations.push({
          dimension,
          id,
          presentIn: 'web',
          reason: `web-only ${dimension} entry cites '${entry.gatedBy}', which does not distinguish web from desktop`,
        })
      }
    }
  }

  return violations
}

interface PlantedDriftFixture {
  readonly plantedDrift: {
    readonly surface: (typeof PARITY_DIMENSIONS)[number]
    readonly entry: string
    readonly desktopOnly: boolean
  }
}

describe('edition-root-parity (design check A33, ADR 0022, ADR 0030, 2.1-M211)', () => {
  it('vite.config.ts and tsconfig.json declare zero deleted edition path aliases', async () => {
    const resolve = async (mode: string) =>
      typeof viteConfig === 'function' ? await viteConfig({ command: 'build', mode }) : viteConfig
    const desktop = await resolve('desktop')
    const web = await resolve('web')
    const gallery = await resolve('gallery')
    const tsconfigPaths = Object.keys(tsconfig.compilerOptions.paths ?? {})

    for (const alias of DELETED_ALIASES) {
      expect(tsconfigPaths, `tsconfig.json still defines ${alias}`).not.toContain(alias)
      for (const [name, cfg] of [['desktop', desktop], ['web', web], ['gallery', gallery]] as const) {
        const aliases = cfg.resolve?.alias ?? {}
        const keys = Array.isArray(aliases) ? aliases.map((entry) => entry.find) : Object.keys(aliases)
        expect(keys, `vite.config.ts (${name}) still defines ${alias}`).not.toContain(alias)
      }
    }
  })

  it('Desktop and Web roots both export their edition boot functions', async () => {
    const desktopBoot = await import('../editions/desktop/boot')
    const webBoot = await import('../editions/web/boot')
    expect(typeof desktopBoot.bootDesktopEdition).toBe('function')
    expect(typeof webBoot.bootWebEdition).toBe('function')
  })

  it('Desktop and Web manifests derive real registered commands and panels and differ only where EDITION_CAPABILITIES explains it on every OS', () => {
    const desktopCommandIds = DESKTOP_EDITION_MANIFEST.commands.map((c) => c.id)
    const webCommandIds = WEB_EDITION_MANIFEST.commands.map((c) => c.id)
    const desktopPanelIds = DESKTOP_EDITION_MANIFEST.panels.map((p) => p.id)
    const webPanelIds = WEB_EDITION_MANIFEST.panels.map((p) => p.id)

    expect(desktopCommandIds).toContain('file.saveAs')
    expect(desktopCommandIds).toContain('file.new')
    expect(desktopCommandIds).toContain('file.exportBudgetCsv')
    expect(webCommandIds).toContain('file.downloadCanopi')
    expect(desktopPanelIds).toContain('favorites')
    expect(desktopPanelIds).toContain('site-data')
    expect(webPanelIds).toContain('favorites')
    expect(webPanelIds).not.toContain('site-data')

    for (const os of ALL_RUNTIME_OS) {
      const desktopCaps = capabilitiesForEdition('desktop', os)
      const webCaps = capabilitiesForEdition('web', os)
      expect(
        diffEditionManifests(DESKTOP_EDITION_MANIFEST, WEB_EDITION_MANIFEST, desktopCaps, webCaps),
        `parity on ${os}`,
      ).toEqual([])
    }
  })

  it('fails red on the planted unexplained drift in fixtures/edition-root-parity-planted.json', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/edition-root-parity-planted.json', import.meta.url), 'utf8'),
    ) as PlantedDriftFixture
    const { surface, entry, desktopOnly } = fixture.plantedDrift
    const driftedDesktop: EditionManifest = desktopOnly
      ? { ...DESKTOP_EDITION_MANIFEST, [surface]: [...DESKTOP_EDITION_MANIFEST[surface], { id: entry }] }
      : DESKTOP_EDITION_MANIFEST
    const driftedWeb: EditionManifest = desktopOnly
      ? WEB_EDITION_MANIFEST
      : { ...WEB_EDITION_MANIFEST, [surface]: [...WEB_EDITION_MANIFEST[surface], { id: entry }] }

    const violations = diffEditionManifests(
      driftedDesktop,
      driftedWeb,
      capabilitiesForEdition('desktop', 'linux'),
      capabilitiesForEdition('web', 'linux'),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ dimension: surface, id: entry, presentIn: desktopOnly ? 'desktop' : 'web' })
  })
})
