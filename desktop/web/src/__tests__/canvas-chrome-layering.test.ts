import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCssDeclarations } from './support/architecture/css-facts'

function readCssSource(path: string): string {
  return readFileSync(`src/${path}`, 'utf8')
}

function classZIndex(path: string, className: string): number {
  const decl = parseCssDeclarations(`src/${path}`, readCssSource(path))
    .find((d) => d.rule === `.${className}` && d.property === 'z-index')
  if (!decl) throw new Error(`Missing .${className} z-index declaration in ${path}`)
  if (/^-?\d+$/.test(decl.value)) return Number.parseInt(decl.value, 10)
  const token = /^var\((--z-[a-z-]+)\)$/.exec(decl.value)?.[1]
  if (token) return scaleToken(token)
  throw new Error(`Missing .${className} z-index declaration`)
}

/** Resolves a stacking scale token from global.css. */
function scaleToken(name: string): number {
  const decl = parseCssDeclarations('src/styles/global.css', readCssSource('styles/global.css'))
    .find((d) => d.property === name)
  if (!decl || !/^-?\d+$/.test(decl.value)) throw new Error(`Missing ${name} in global.css`)
  return Number.parseInt(decl.value, 10)
}

function ruleBody(path: string, selector: string): string {
  const decls = parseCssDeclarations(`src/${path}`, readCssSource(path)).filter((d) => d.rule === selector)
  if (decls.length === 0) throw new Error(`Missing ${selector} CSS rule in ${path}`)
  return decls.map((d) => `${d.property}: ${d.value};`).join('\n')
}

describe('floating chrome layering', () => {
  it('lays app-wide notices over the map on the opaque surface, under their translucent error tint', () => {
    // The last background layer is the surface, so the map never shows through the tint.
    const onSurface = /background:\s*linear-gradient\(var\(--color-danger-bg\),\s*var\(--color-danger-bg\)\),\s*var\(--color-surface\)\s*;/
    // The Web shell keeps no notice row of its own: its notices are the one notice row's (2.1-Q290).
    expect(readCssSource('web/BrowserAppShell.module.css')).not.toMatch(/\.notice\b/)
    // The one notice row (Desktop's foot, Web's title-bar row) lays its error and warning tints on the surface too.
    expect(ruleBody('components/shared/NoticeRow.module.css', '.row [data-notice-tone="error"]')).toMatch(onSurface)
    expect(ruleBody('components/shared/NoticeRow.module.css', '.row [data-notice-tone="warning"]'))
      .toMatch(/background:\s*linear-gradient\(var\(--color-warning-bg\),\s*var\(--color-warning-bg\)\),\s*var\(--color-surface\)\s*;/)
  })

  // The one notice row in the Web shell, the New version: Reload notice among them (2.1-Q83, Q290): it takes its own row
  // under the title bar, so the bar draws over it; it draws over the phone sheet and context bar, and the phone search
  // card covers it.
  it('stacks the Web notice row under the title bar and phone search card and over the phone sheet', () => {
    const notice = classZIndex('components/shared/NoticeRow.module.css', 'belowTitleBar')
    expect(classZIndex('components/shared/WorkspaceTitleBar.module.css', 'titleBar')).toBeGreaterThan(notice)
    expect(classZIndex('web/BrowserAppShell.module.css', 'phoneSearch')).toBeGreaterThan(notice)
    expect(notice).toBeGreaterThan(classZIndex('components/shared/PhoneSheet.module.css', 'sheet'))
    expect(readCssSource('components/shared/NoticeRow.module.css')).toMatch(/\.belowTitleBar\s*\{[^}]*z-index:\s*var\(--z-shell-notice\)/)
  })

  it('stacks the title bar over the dock, the dock over the rails and chips, and all of them over map status', () => {
    const titleBar = classZIndex('components/shared/WorkspaceTitleBar.module.css', 'titleBar')
    const dock = classZIndex('components/shared/SidePanelDock.module.css', 'dock')
    const rails = [
      classZIndex('components/canvas/ToolRail.module.css', 'rail'),
      classZIndex('components/shared/PanelRail.module.css', 'rail'),
      classZIndex('components/canvas/ViewChip.module.css', 'chip'),
      classZIndex('components/canvas/ZoomControls.module.css', 'group'),
    ]
    const mapStatus = classZIndex('components/panels/Panels.module.css', 'basemapFeedback')

    expect(titleBar).toBeGreaterThan(dock)
    for (const rail of rails) {
      expect(dock).toBeGreaterThan(rail)
      expect(rail).toBeGreaterThan(mapStatus)
    }
  })

  it('stacks the phone sheet under the top bar and over the rails and status chips it can cover', () => {
    const sheet = classZIndex('components/shared/PhoneSheet.module.css', 'sheet')
    expect(classZIndex('components/shared/WorkspaceTitleBar.module.css', 'titleBar')).toBeGreaterThan(sheet)
    for (const [file, name] of [
      ['components/canvas/ToolRail.module.css', 'rail'],
      ['components/canvas/ZoomControls.module.css', 'group'],
      ['components/canvas/SelectionChip.module.css', 'chip'],
      // The top-centre slot holds the overview notice and the highlight and labels chips.
      ['components/canvas/SpeciesFocusChip.module.css', 'topSlot'],
    ] as const) {
      expect(sheet).toBeGreaterThan(classZIndex(file, name))
    }
  })

  it('stacks the inspection lens above the tool card that shares its slot, and the card above the rails beside it, under the dock, and both under the chips and phone sheet (canopi-n54g)', () => {
    // The user's call (2026-10-14) reverses U58's card-over-lens order: an open lens is never hidden by the armed tool's card.
    const toolCard = classZIndex('components/canvas/ToolCard.module.css', 'card')
    const lens = classZIndex('components/canvas/InspectionLens.module.css', 'panel')
    // Through the stacking scale: each layer is a token, not a number of its own.
    expect(ruleBody('components/canvas/ToolCard.module.css', '.card')).toMatch(/z-index:\s*var\(--z-canvas-tool-card\)/)
    expect(ruleBody('components/canvas/InspectionLens.module.css', '.panel')).toMatch(/z-index:\s*var\(--z-canvas-inspection-lens\)/)
    expect(lens).toBeGreaterThan(toolCard)
    // The lens's launcher floats with the rails.
    expect(classZIndex('components/canvas/InspectionLens.module.css', 'launcher')).toBeLessThan(toolCard)
    for (const [file, name] of [
      ['components/canvas/ToolRail.module.css', 'rail'],
      ['components/canvas/ZoomControls.module.css', 'group'],
    ] as const) {
      expect(toolCard).toBeGreaterThan(classZIndex(file, name))
    }
    for (const [file, name] of [
      ['components/shared/SidePanelDock.module.css', 'dock'],
      ['components/canvas/SelectionChip.module.css', 'chip'],
      ['components/canvas/SpeciesFocusChip.module.css', 'topSlot'],
      ['components/shared/PhoneSheet.module.css', 'sheet'],
    ] as const) {
      expect(classZIndex(file, name)).toBeGreaterThan(toolCard)
      if (name !== 'dock') expect(classZIndex(file, name)).toBeGreaterThan(lens)
    }
  })

  it('canopi-eon8.14.3: stacks the lock toast with the canvas chips, under the title bar, its menus and the phone sheet, over the tool card and map status', () => {
    // It is canvas chrome inside the canvas area, not a window-level toast: on --z-toast it drew over an open phone sheet
    // and the title bar's menus.
    const toast = classZIndex('components/canvas/LockedMoveToast.module.css', 'slot')
    expect(ruleBody('components/canvas/LockedMoveToast.module.css', '.slot')).not.toMatch(/var\(--z-(?:toast|full-window|dialog|popover)/)
    for (const [file, name] of [
      ['components/shared/WorkspaceTitleBar.module.css', 'titleBar'],
      ['components/shared/PhoneSheet.module.css', 'sheet'],
    ] as const) {
      expect(classZIndex(file, name)).toBeGreaterThan(toast)
    }
    for (const [file, name] of [
      ['components/canvas/ToolCard.module.css', 'card'],
      ['components/canvas/InspectionLens.module.css', 'panel'],
      ['components/canvas/SelectionChip.module.css', 'chip'],
      ['components/panels/Panels.module.css', 'basemapFeedback'],
    ] as const) {
      expect(toast).toBeGreaterThan(classZIndex(file, name))
    }
  })

  it('keeps plant styling popovers above the rail that opens them', () => {
    expect(classZIndex('components/canvas/appearance.module.css', 'menu'))
      .toBeGreaterThan(classZIndex('components/canvas/ToolRail.module.css', 'rail'))
  })
})
