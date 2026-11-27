// Probe first (2c-1): select, polygon, and stamp tools as descriptor rows in app/command-table/tools.ts.
import { describe, expect, it } from 'vitest'
import { isToolId, TOOL_IDS, TOOL_ROWS } from './tools'

describe('tool descriptor rows (2c-1 probe, contracts §18 F29)', () => {
  it('declares select, polygon, saved-object-stamp, and profile with read traits, constraints, and Esc steps', () => {
    const select = TOOL_ROWS.select
    expect(select.readOnly).toBe(true)
    expect(select.cursor).toBe('default')
    expect(select.shiftConstrains).toBeFalsy()
    expect(select.escSteps).toEqual(['gesture', 'nudge-series', 'tool-transient', 'selection'])

    const polygon = TOOL_ROWS.polygon
    expect(polygon.readOnly).toBe(false)
    expect(polygon.needsSpatialEditing).toBe(true)
    expect(polygon.shiftConstrains).toBe(true)
    expect(polygon.zoneDraft).toBe(true)
    expect(polygon.cursor).toBe('crosshair')
    expect(polygon.escSteps).toEqual(['gesture', 'tool-transient', 'tool'])

    const stamp = TOOL_ROWS['saved-object-stamp']
    expect(stamp.readOnly).toBe(false)
    expect(stamp.requires).toEqual(['saved-stamps'])
    expect(stamp.requiresSource).toBe('saved-stamp')
    expect(stamp.escSteps).toEqual(['gesture', 'tool'])

    const profile = TOOL_ROWS.profile
    expect(profile.readOnly).toBe(true)
    expect(profile.needsCanvas).toBe(true)
    expect(profile.requires).toEqual(['site-data-below-limit'])
    expect(profile.escSteps).toEqual(['gesture', 'tool-transient', 'tool'])
  })

  it('recognises every declared ToolId via isToolId and rejects unknown strings', () => {
    expect(TOOL_IDS.length).toBe(Object.keys(TOOL_ROWS).length)
    for (const id of TOOL_IDS) {
      expect(isToolId(id)).toBe(true)
      expect(TOOL_ROWS[id].id).toBe(id)
    }
    expect(isToolId('not-a-tool')).toBe(false)
    expect(isToolId('')).toBe(false)
  })
})
