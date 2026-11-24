import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { librarySnapshot, slopeItem, sourceItem } from '../../__tests__/support/library-fixtures'
import type { CanopiFile } from '../../types/design'
import { designSessionStore } from '../document-session/store'
import { activePanel, selectPanel, sidePanel } from '../shell/state'
import { lidarLibrary } from './library-store'
import { showInSiteData, siteDataViewFor } from './site-data-view'
import { endSiteDataTransients, pin, profileLine, setPin, setProfileLine } from './site-transients'

const LINE = [{ lon: 2.35, lat: 48.85 }, { lon: 2.36, lat: 48.86 }]

/** A Design showing ground `a`, its slope `s` and the slope's own slope `t`, nested a › s › t. */
function openOrchard(): void {
  const entry = (kind: 'Source' | 'Derived', id: string, order: number) =>
    ({ kind, id, name: id, order, visible: true, opacity: 1, ramp: null, reversed: false, range: null })
  designSessionStore.replaceCurrentDesignState({
    name: 'Orchard',
    lidar: { visible: true, entries: [entry('Source', 'a', 0), entry('Derived', 's', 1), entry('Derived', 't', 2)] },
  } as unknown as CanopiFile, null, 'Orchard')
}

function view() {
  return siteDataViewFor(designSessionStore.sessionIdentity.peek())
}

describe('the Site data view state (canopi-f47t.42)', () => {
  beforeEach(() => {
    lidarLibrary.value = librarySnapshot([sourceItem('a', 'Ground'), slopeItem('s', 'a'), slopeItem('t', 's')])
    openOrchard()
    selectPanel('site-data')
  })

  afterEach(() => {
    endSiteDataTransients()
    sidePanel.value = null
    activePanel.value = 'canvas'
  })

  it('is one owner per Design session, starting with nothing open, collapsed or filtered', () => {
    const state = view()

    expect(view()).toBe(state)
    expect(state.openItem.value).toBeNull()
    expect(state.collapsed.value.size).toBe(0)
    expect(state.filter.value).toBe('')
    expect(state.scrollTop).toBe(0)
  })

  it('Ctrl 1 then Ctrl 2 keeps the open item, collapse and filter, and ends the pin and the profile', () => {
    const state = view()
    state.openItem.value = 's'
    state.collapsed.value = new Set(['a'])
    state.filter.value = 'slo'
    state.scrollTop = 120
    setPin({ lon: 2.35, lat: 48.85 })
    setProfileLine(LINE)

    selectPanel('layers')
    selectPanel('site-data')

    expect(view()).toBe(state)
    expect(state.openItem.value).toBe('s')
    expect([...state.collapsed.value]).toEqual(['a'])
    expect(state.filter.value).toBe('slo')
    expect(state.scrollTop).toBe(120)
    expect(pin.value).toBeNull()
    expect(profileLine.value).toBeNull()
  })

  it('a Design replace yields a fresh view owner and no pin', () => {
    const state = view()
    state.openItem.value = 's'
    setPin({ lon: 2.35, lat: 48.85 })

    openOrchard()

    expect(view()).not.toBe(state)
    expect(view().openItem.value).toBeNull()
    expect(pin.value).toBeNull()
  })

  it('showInSiteData opens the panel, expands every ancestor, opens the item and asks the list to reveal it', () => {
    selectPanel('layers')
    view().collapsed.value = new Set(['a', 's', 'b'])

    showInSiteData('t')

    expect(sidePanel.value).toBe('site-data')
    expect([...view().collapsed.value]).toEqual(['b'])
    expect(view().openItem.value).toBe('t')
    expect(view().reveal.value).toEqual({ id: 't' })
  })

  it('showInSiteData expands the analysis group line its item sits under', () => {
    // The fixture's slope `s` belongs to definition `s-def`; its grandchild `t` sits under that line too.
    const group = 'analysis:s-def'
    view().collapsed.value = new Set([group])

    showInSiteData('t')

    expect(view().collapsed.value.has(group)).toBe(false)
  })
})
