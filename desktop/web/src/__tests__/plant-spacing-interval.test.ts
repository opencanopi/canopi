import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatPlantSpacingIntervalInput,
  parsePlantRowCountInput,
  parsePlantSpacingIntervalInput,
} from '../canvas/plant-spacing-interval'
import { DEFAULT_SETTINGS } from '../generated/settings'
import { createPlantRowTool } from '../canvas/runtime/tools/plant-row'
import { createToolHarness, plantEntity, useStubTools, type ToolHarness } from './support/tool-harness'

vi.mock('../canvas/runtime/tools/registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []

afterEach(() => {
  for (const h of harnesses.splice(0)) h.dispose()
})

/** The length chip Plant a row shows for a row from (0, 0) to (`lengthM`, 0). */
function rowLengthChip(lengthM: number): string | undefined {
  useStubTools(createPlantRowTool())
  const h = createToolHarness({
    viewport: { x: 0, y: 0, scale: 1 },
    scene: { plants: [plantEntity('source', 'Malus domestica', { x: 0, y: 0 })] },
    settings: { plantSpacingIntervalM: () => 0.5, commitPlantSpacingIntervalM: () => {} },
  })
  harnesses.push(h)
  h.arm('plant-spacing')
  h.click({ x: 0, y: 0 })
  h.hover({ x: lengthM, y: 0 })
  const shapes = h.renderer.lastDraft()?.shapes ?? []
  const chip = shapes.find((shape) => shape.kind === 'label' && shape.tone === 'hint-primary')
  return chip?.kind === 'label' ? chip.text : undefined
}

describe('Plant Spacing interval parsing', () => {
  it('accepts positive finite metric distances and normalizes them to meters', () => {
    expect(DEFAULT_SETTINGS.plant_spacing_interval_m).toBe(0.5)
    expect(parsePlantSpacingIntervalInput('0.5')).toEqual({ valid: true, meters: 0.5 })
    expect(parsePlantSpacingIntervalInput('0.5m')).toEqual({ valid: true, meters: 0.5 })
    expect(parsePlantSpacingIntervalInput('50cm')).toEqual({ valid: true, meters: 0.5 })
    expect(parsePlantSpacingIntervalInput('25 cm')).toEqual({ valid: true, meters: 0.25 })
    expect(parsePlantSpacingIntervalInput('0,5m')).toEqual({ valid: true, meters: 0.5 })
  })

  it('rejects blank, zero, negative, NaN, infinite, and unknown-unit inputs', () => {
    expect(parsePlantSpacingIntervalInput('')).toEqual({ valid: false })
    expect(parsePlantSpacingIntervalInput('0')).toEqual({ valid: false })
    expect(parsePlantSpacingIntervalInput('-1m')).toEqual({ valid: false })
    expect(parsePlantSpacingIntervalInput('NaN')).toEqual({ valid: false })
    expect(parsePlantSpacingIntervalInput('Infinity')).toEqual({ valid: false })
    expect(parsePlantSpacingIntervalInput('10mm')).toEqual({ valid: false })
  })

  it('formats the fallback and stored meter values for the compact HUD input', () => {
    expect(formatPlantSpacingIntervalInput(DEFAULT_SETTINGS.plant_spacing_interval_m)).toBe('50 cm')
    expect(formatPlantSpacingIntervalInput(1.5)).toBe('1.5 m')
    expect(formatPlantSpacingIntervalInput(0.25)).toBe('25 cm')
    expect(formatPlantSpacingIntervalInput(0)).toBe('50 cm')
  })
})

describe('Plant a row count parsing', () => {
  // The most a row plants is Plant a row's own guard (plant-row.ts), not the parser's.
  it('accepts a whole number of plants from 2, the picked plant counted', () => {
    expect(parsePlantRowCountInput('2')).toEqual({ valid: true, count: 2 })
    expect(parsePlantRowCountInput(' 12 ')).toEqual({ valid: true, count: 12 })
    expect(parsePlantRowCountInput('5000')).toEqual({ valid: true, count: 5000 })
    expect(parsePlantRowCountInput('5001')).toEqual({ valid: true, count: 5001 })
  })

  it('rejects blank, fewer than 2, fractional, non-numeric and unsafe counts', () => {
    for (const text of ['', ' ', '0', '1', '2.5', '3,0', '-4', '1e3', 'ten', '12 plants', '9007199254740993']) {
      expect(parsePlantRowCountInput(text), text).toEqual({ valid: false })
    }
  })
})

describe('Plant a row length chip', () => {
  it('a 27.6 m row reads 28 m', () => {
    expect(rowLengthChip(27.6)).toBe('28 m')
  })

  it('reads one decimal below 10 m and centimetres below 1 m, like the zone chips', () => {
    expect(rowLengthChip(9.66)).toBe('9.7 m')
    expect(rowLengthChip(0.25)).toBe('25 cm')
  })
})
