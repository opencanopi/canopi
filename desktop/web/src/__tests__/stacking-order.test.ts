// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { ButtonTooltip } from '../components/shared/ButtonTooltip'

// Popups portal to <body>, so only the z-index scale decides whether a menu
// opened inside a dialog shows above it. A raw number here once put the
// Settings language list behind the Settings dialog.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function token(css: string, name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+)`).exec(css)
  if (!match) throw new Error(`missing ${name}`)
  return Number(match[1])
}

const FILES = {
  dropdown: '../components/shared/Dropdown.module.css',
  datePicker: '../components/shared/DatePicker.module.css',
  actionMenu: '../components/shared/ActionMenu.module.css',
  appearance: '../components/canvas/appearance.module.css',
  workspaceDialog: '../components/shared/WorkspaceDialog.module.css',
  aboutDialog: '../components/shared/AboutCanopiDialog.module.css',
  savedViewDialogs: '../components/shared/SavedViewDialogs.module.css',
  saveProblem: '../components/shared/save-problem-dialog.module.css',
  problemReport: '../components/shared/ProblemReportDialog.module.css',
  commandPalette: '../components/shared/CommandPalette.module.css',
  pdfExport: '../components/canvas-pdf/canvas-pdf.module.css',
  storyPresenter: '../components/stories/StoryPresenter.module.css',
} as const

describe('stacking order', () => {
  const global = read('../styles/global.css')

  it('puts popups above every dialog and full-window surface, and tooltips above popups', () => {
    const fullWindow = token(global, '--z-full-window')
    const toast = token(global, '--z-toast')
    const dialog = token(global, '--z-dialog')
    const alert = token(global, '--z-dialog-alert')
    const popover = token(global, '--z-popover')
    const tooltip = token(global, '--z-tooltip')
    expect(fullWindow).toBeLessThan(toast)
    expect(toast).toBeLessThan(dialog)
    expect(dialog).toBeLessThan(alert)
    expect(alert).toBeLessThan(popover)
    expect(popover).toBeLessThan(tooltip)
  })

  // The canvas hover card names what the pointer rests on: its layer sits above the canvas chrome and under every
  // full-window surface, toast, dialog and popup (canopi-xpqt).
  it('puts the canvas hover card above the canvas chrome and under every full-window surface, toast, dialog and popup', () => {
    const card = token(global, '--z-hover-card')
    expect(token(global, '--z-canvas-inspection-lens')).toBeLessThan(card)
    expect(card).toBeLessThan(token(global, '--z-full-window'))
    expect(global).toMatch(/\[data-hover-card-layer\]\s*\{(?=[^}]*position:\s*fixed)(?=[^}]*z-index:\s*var\(--z-hover-card\))[^}]*\}/)
  })

  it('puts the Web shell notice row under the hover card, every full-window surface and dialog (2.1-Q83)', () => {
    const notice = token(global, '--z-shell-notice')
    expect(notice).toBeLessThan(token(global, '--z-hover-card'))
    expect(notice).toBeLessThan(token(global, '--z-full-window'))
    expect(notice).toBeLessThan(token(global, '--z-dialog'))
  })

  it('draws an open inspection lens above the tool card in its slot, and both under every popup (canopi-n54g)', () => {
    const card = token(global, '--z-canvas-tool-card')
    const lens = token(global, '--z-canvas-inspection-lens')
    expect(card).toBeLessThan(lens)
    expect(lens).toBeLessThan(token(global, '--z-full-window'))
  })

  it('layers dialogs, popups and full-window surfaces only through the scale tokens', () => {
    for (const [name, path] of Object.entries(FILES)) {
      const css = read(path)
      const raw = [...css.matchAll(/z-index:\s*(\d+)/g)].map((match) => Number(match[1]))
      // In-flow layers inside a surface may stay small; anything that competes
      // with dialogs must use a token.
      expect(raw.filter((value) => value > 40), name).toEqual([])
    }
  })

  it('floats portalled popups on the popover layer', () => {
    expect(read(FILES.dropdown)).toMatch(/\.menuFloating\s*\{[^}]*z-index:\s*var\(--z-popover\)/)
    expect(read(FILES.datePicker)).toMatch(/\.calendarFloating\s*\{[^}]*z-index:\s*var\(--z-popover\)/)
    expect(read(FILES.actionMenu)).toMatch(/\.menu\s*\{[^}]*z-index:\s*var\(--z-popover\)/)
    expect(read(FILES.appearance)).toMatch(/\.menu\s*\{[^}]*z-index:\s*var\(--z-popover\)/)
  })
})

// A tooltip drawn inside its frame is trapped in that frame's stacking context (a rail's z 30 and backdrop-filter, the
// map area's container-type) and clipped by its overflow, whatever its own z-index: the tool strip's, map controls' and
// panel rail's tooltips hid under the tool card and the dock (canopi-xpqt). Every tooltip is drawn in the one
// window-level layer (utils/tooltip-layer.ts), the only user of --z-tooltip.
describe('the tooltip layer', () => {
  const SRC = `${resolve('src')}/`
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'generated' ? [] : sources(path)
    return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
  const relative = (path: string) => path.slice(SRC.length)

  afterEach(() => { document.body.innerHTML = '' })

  it('is a fixed box on <body> at --z-tooltip, and nothing else uses --z-tooltip', () => {
    expect(read('../styles/global.css')).toMatch(
      /\[data-tooltip-layer\]\s*\{(?=[^}]*position:\s*fixed)(?=[^}]*z-index:\s*var\(--z-tooltip\))[^}]*\}/,
    )
    const users = sources(SRC).filter((path) => /var\(--z-tooltip\)/.test(readFileSync(path, 'utf8'))).map(relative)
    expect(users).toEqual(['styles/global.css'])
  })

  // A menu drawn inside a low stacking context (the title bar's menus at z 100, the map scale menu at z 60) sits under the
  // card's layer whatever its own z-index, so the card hides while any menu, dialog or popup is open (the user's decision
  // of 2026-10-14, canopi-xpqt). Every popup role and every popup a trigger announces (aria-haspopup) must count.
  it('hides the canvas hover card while any menu, dialog or popup in src is open', () => {
    const css = read('../styles/global.css')
    const rule = /body:has\(([^)]*)\)\s*\[data-hover-card-layer\]\s*\{[^}]*display:\s*none\s*!important[^}]*\}/.exec(css)
    expect(rule, 'the hide rule beside the card layer').not.toBeNull()
    const hides = rule![1]!.split(',').map((entry) => entry.trim().replace(/"/g, "'"))
    const covers = (role: string) => hides.includes(`[role='${role}']`)
    for (const required of ["[aria-modal='true']", '[data-popup]']) expect(hides).toContain(required)

    // Popup roles (WAI-ARIA aria-haspopup values and the dialogs): menu, dialog and alertdialog are only mounted while
    // open, so they count by role. A listbox, tree or grid may be a list that stays in a panel, so an open popup of
    // those carries data-popup, or lies in a file whose dialog or menu holds it.
    const POPUP_ROLES = ['menu', 'dialog', 'alertdialog', 'listbox', 'tree', 'grid']
    const INLINE_LISTS = new Map([
      ['components/panels/lidar/DataLibraryView.tsx', 'the data library\'s list stays in its panel'],
      ['components/panels/CalendarSpeciesPicker.tsx', 'drawn inside the calendar editor\'s role="dialog" (CalendarPanel.tsx)'],
    ])
    const missing: string[] = []
    for (const path of sources(SRC).filter((entry) => /\.tsx?$/.test(entry))) {
      const source = readFileSync(path, 'utf8')
      const file = relative(path)
      const roles = attributeValues(source, 'role')
      const announced = attributeValues(source, 'aria-haspopup')
      for (const role of new Set([...roles, ...announced])) {
        if (!POPUP_ROLES.includes(role) || covers(role)) continue
        const held = roles.some((entry) => entry !== role && covers(entry))
        if (!held && !/data-popup\b/.test(source) && !INLINE_LISTS.has(file)) missing.push(`${file}: role ${role}`)
      }
    }
    for (const role of ['menu', 'dialog', 'alertdialog']) expect(covers(role), `[role='${role}'] hides the card`).toBe(true)
    expect(missing, 'each popup hides the card by its role or data-popup').toEqual([])

    // Popups with no popup role, or a listbox mounted while closed, mark themselves while open.
    for (const file of ['components/plant-db/MoreFiltersPanel.tsx', 'components/canvas/PlaceSearch.tsx', 'components/shared/Dropdown.tsx']) {
      expect(read(`../${file}`), `${file} marks its open popup`).toMatch(/data-popup\b/)
    }
  })

  it('reads every literal value of a role or aria-haspopup attribute, whatever expression holds it', () => {
    const source = `<a role="menu" /><b role={ 'dialog' } /><c role={open ? "listbox" : undefined} />
      <d aria-haspopup={sub ? 'menu' : opens ? 'tree' : undefined} /><e role={role} /> css('[role="grid"]')`
    expect(attributeValues(source, 'role')).toEqual(['menu', 'dialog', 'listbox'])
    expect(attributeValues(source, 'aria-haspopup')).toEqual(['menu', 'tree'])
  })

  it('draws every role="tooltip" through ButtonTooltip, which portals into the layer, and the hover card in its own layer', () => {
    const owners = sources(SRC).filter((path) => /role=["{']+tooltip/.test(readFileSync(path, 'utf8'))).map(relative)
    expect(owners).toEqual(['components/shared/ButtonTooltip.tsx'])
    const tooltip = read('../components/shared/ButtonTooltip.tsx')
    expect(tooltip).toMatch(/createPortal\([\s\S]*tooltipLayer\(\)/)
    const hoverCard = read('../canvas/runtime/chrome/hover-tooltip.ts')
    expect(hoverCard).toMatch(/hoverCardLayer\(\)/)
    expect(hoverCard).not.toMatch(/container\.appendChild/)
  })

  it('puts a hovered or focused button\'s tooltip in the layer on <body>, not inside the button or its frame', async () => {
    const frame = document.createElement('div')
    frame.style.cssText = 'position:absolute;z-index:30;overflow:hidden;backdrop-filter:blur(8px)'
    document.body.append(frame)
    await act(async () => {
      render(h('button', { type: 'button', 'aria-label': 'Zoom in' }, h(ButtonTooltip, { label: 'Zoom in', shortcut: '+' })), frame)
    })
    const button = frame.querySelector('button')!
    expect(document.querySelector('[role="tooltip"]'), 'nothing shows before a hover').toBeNull()
    await act(async () => { button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })) })
    const shown = document.querySelector('[role="tooltip"]')!
    expect(shown.textContent).toBe('Zoom in+')
    expect(shown.parentElement?.hasAttribute('data-tooltip-layer')).toBe(true)
    expect(shown.parentElement?.parentElement).toBe(document.body)
    expect(frame.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => { button.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })) })
    expect(document.querySelector('[role="tooltip"]')).toBeNull()

    await act(async () => { button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' })) })
    expect(document.querySelector('[role="tooltip"]'), 'a finger\'s hover shows none').toBeNull()
    await act(async () => { button.focus() })
    expect(document.querySelector('[data-tooltip-layer] [role="tooltip"]')?.textContent, 'keyboard focus shows it').toBe('Zoom in+')
    await act(async () => { render(null, frame) })
    expect(document.querySelector('[role="tooltip"]'), 'it leaves with its button').toBeNull()
  })
})

/** Every literal value of a JSX attribute: a quoted value, or each quoted word in its `{…}` expression (a selector string
 *  such as '[role="menu"]' is not an attribute). */
function attributeValues(source: string, name: string): string[] {
  const attribute = new RegExp(`(?<![\\[\\w-])${name}=(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`, 'g')
  return [...source.matchAll(attribute)].flatMap((match) => match[3] === undefined
    ? [match[1] ?? match[2]!]
    : [...match[3].matchAll(/["']([a-z]+)["']/g)].map((literal) => literal[1]!))
}
