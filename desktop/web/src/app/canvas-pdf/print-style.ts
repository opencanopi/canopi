import { CONVERSION_CONSTANTS } from '../../utils/format'

export const MM = 72 / (CONVERSION_CONSTANTS.mPerInch * 1000)
// Physical dimensions shared by preview and PDF output.
export const PRINT = { gutter: 5 * MM, legendRule: '#d8d2c8', marker: 1.5 * MM, stroke: .25 * MM, ink: '#24211c', paper: '#ffffff' } as const
