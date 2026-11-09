import { describe, expect, it } from 'vitest'
import type { AnalysisEntry, AnalysisGroup } from '../generated/analysis-registry'
import { ANALYSIS_GROUPS, ANALYSIS_REGISTRY } from '../generated/analysis-registry'
import { FILTER_CATEGORIES, PLANT_FILTER_FIELDS, type PlantFilterFieldDef } from '../generated/plant-filter-fields'
import type { AnalysisOffer, Provenance } from '../generated/contracts'
import {
  analysisOptions,
  buildAnalysisRequest,
  defaultAnalysisSource,
  entryAvailability,
  findExistingResult,
  formFromProvenance,
  initialForm,
  isParamVisible,
  paramUnitSuffix,
  parseLocaleNumber,
  formatLocaleNumber,
  validateForm,
  type AnalysisContext,
  type AnalysisForm,
  type AnalysisSubject,
} from '../app/analyses/model'
import {
  activeChipFields,
  stripControls,
  type ActiveChipField,
  type StripChoiceField,
  type StripControlField,
} from '../app/plant-browser/species-catalog-filters'
import { analysisTitle, derivedItemName } from '../app/analyses/registry'
import { t } from '../i18n'

const water = 'water' as unknown as AnalysisGroup

/** One entry covering every parameter type, advanced disclosure, visibleWhen and optional outputs. */
// The model never reads its texts, so the fixture borrows Slope's keys.
const FLOW: AnalysisEntry = {
  id: 'hydrology.flow',
  version: 3,
  group: water,
  titleKey: 'analyses.terrain.slope.title',
  summaryKey: 'analyses.terrain.slope.summary',
  lane: { kind: 'geolibre-windowed', halo: 0 },
  inputs: [{ key: 'dem', accepts: [{ kind: 'Raster', quantity: 'GroundElevation' }], requires: [] }],
  params: [
    {
      key: 'depressions', labelKey: 'analyses.terrain.slope.params.unit.label', helpKey: 'analyses.terrain.slope.params.unit.help',
      kind: { type: 'choice', options: ['breach', 'fill'] }, default: 'breach', advanced: false, visibleWhen: null,
      optionLabelKeys: { breach: 'analyses.terrain.slope.params.unit.options.degrees', fill: 'analyses.terrain.slope.params.unit.options.percent' },
    },
    {
      key: 'max_breach_m', labelKey: 'analyses.terrain.slope.params.unit.label', helpKey: 'analyses.terrain.slope.params.unit.help',
      kind: { type: 'number', min: 1, max: 1000, step: 0.5, unit: 'metre' }, default: 50, advanced: true,
      visibleWhen: { param: 'depressions', equals: 'breach' }, optionLabelKeys: {},
    },
    {
      key: 'passes', labelKey: 'analyses.terrain.slope.params.unit.label', helpKey: 'analyses.terrain.slope.params.unit.help',
      kind: { type: 'integer', min: 1, max: 5 }, default: 2, advanced: true, visibleWhen: null, optionLabelKeys: {},
    },
    {
      key: 'log', labelKey: 'analyses.terrain.slope.params.unit.label', helpKey: 'analyses.terrain.slope.params.unit.help',
      kind: { type: 'boolean' }, default: null, advanced: false, visibleWhen: null, optionLabelKeys: {},
    },
  ],
  outputs: [
    { key: 'area', labelKey: 'analyses.terrain.slope.outputs.slope', item: { kind: 'Raster', quantity: 'OtherContinuous' }, units: { kind: 'fixed', value: 'm²' }, optional: true, defaultSelected: true, presentable: true },
    { key: 'wetness', labelKey: 'analyses.terrain.slope.outputs.slope', item: { kind: 'Raster', quantity: 'OtherContinuous' }, units: { kind: 'fixed', value: '' }, optional: true, defaultSelected: false, presentable: true },
  ],}

const SLOPE = ANALYSIS_REGISTRY.find((entry) => entry.id === 'terrain.slope')!
const REGISTRY = [SLOPE, FLOW]
const GROUPS = [{ key: 'terrain' as AnalysisGroup, labelKey: 'analyses.groups.terrain' }, { key: water, labelKey: 'analyses.groups.water' }]

function subject(offers: AnalysisOffer[] = [
  { analysis_id: 'terrain.slope', unavailable: null },
  { analysis_id: 'hydrology.flow', unavailable: null },
]): AnalysisSubject {
  return { id: 'ground', name: 'Ground', offers }
}

function context(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return { edition: 'desktop', results: [], inDesign: new Set(), ...overrides }
}

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    definition_id: 'def-1', analysis_id: 'terrain.slope', recipe_version: 1, output_key: 'slope',
    inputs: [{ key: 'dem', item_id: 'ground', generation_id: 'g1' }],
    parameters: [{ key: 'unit', value: { Choice: 'degrees' } }],
    tool: null, job_id: 'job-1', created_at: '0', ...overrides,
  }
}

function withValues(form: AnalysisForm, values: AnalysisForm['values']): AnalysisForm {
  return { ...form, values: { ...form.values, ...values } }
}

describe('Analyze dialog model', () => {
  it('lists every entry in registry group order with native reasons', () => {
    const groups = analysisOptions(subject([
      { analysis_id: 'terrain.slope', unavailable: { reason: 'WrongInput', expected: [{ kind: 'Raster', quantity: 'GroundElevation' }] } },
      { analysis_id: 'hydrology.flow', unavailable: null },
    ]), context(), 'en', REGISTRY, GROUPS)

    expect(groups.map((group) => group.key)).toEqual(['terrain', 'water'])
    expect(groups[0]!.options[0]!.unavailable).toEqual({ reason: 'WrongInput', expected: [{ kind: 'Raster', quantity: 'GroundElevation' }] })
    expect(groups[1]!.options[0]!.unavailable).toBeNull()
  })

  it('refuses every entry on Web, and an entry native did not offer', () => {
    expect(analysisOptions(subject(), context({ edition: 'web' }), 'en', REGISTRY, GROUPS)
      .flatMap((group) => group.options.map((option) => option.unavailable)))
      .toEqual([{ reason: 'NeedsDesktop' }, { reason: 'NeedsDesktop' }])
    expect(analysisOptions(subject([]), context(), 'en', REGISTRY, GROUPS)[0]!.options[0]!.unavailable)
      .toEqual({ reason: 'NotReady' })
  })

  it('starts from registry defaults, the default outputs and a suggested name', () => {
    const form = initialForm(FLOW, 'Ground', 'Water flow', 'fr')
    expect(form).toEqual({
      values: { depressions: 'breach', max_breach_m: '50', passes: '2', log: false },
      outputs: { area: true, wetness: false },
      name: 'Ground · Water flow',
    })
    expect(initialForm(SLOPE, 'Ground', 'Slope', 'en').values).toEqual({ unit: null })
  })

  it('honours visibleWhen and omits hidden parameters from the request', () => {
    const form = initialForm(FLOW, 'Ground', 'Flow', 'en')
    expect(isParamVisible(FLOW, form.values, 'max_breach_m')).toBe(true)
    const filled = withValues(form, { depressions: 'fill', max_breach_m: 'not a number' })
    expect(isParamVisible(FLOW, filled.values, 'max_breach_m')).toBe(false)
    expect(validateForm(FLOW, filled, 'en').valid).toBe(true)

    expect(buildAnalysisRequest(FLOW, { id: 'ground' }, filled, 'en')).toEqual({
      analysis_id: 'hydrology.flow',
      inputs: [{ key: 'dem', item_id: 'ground' }],
      parameters: [
        { key: 'depressions', value: { Choice: 'fill' } },
        { key: 'passes', value: { Integer: 2 } },
        { key: 'log', value: { Boolean: false } },
      ],
      outputs: ['area'],
      name: 'Ground · Flow',
    })
  })

  it('validates each parameter type like the registry, for inline errors', () => {
    const form = initialForm(FLOW, 'Ground', 'Flow', 'en')
    const errors = (values: AnalysisForm['values']) => validateForm(FLOW, withValues(form, values), 'en').params

    expect(errors({ depressions: null })).toEqual({ depressions: { code: 'required' } })
    expect(errors({ max_breach_m: 'abc' })).toEqual({ max_breach_m: { code: 'number' } })
    expect(errors({ max_breach_m: '2000' })).toEqual({ max_breach_m: { code: 'range', min: 1, max: 1000 } })
    expect(errors({ max_breach_m: '1.25' })).toEqual({ max_breach_m: { code: 'step', step: 0.5 } })
    expect(errors({ passes: '2.5' })).toEqual({ passes: { code: 'integer' } })
    expect(errors({ passes: '9' })).toEqual({ passes: { code: 'range', min: 1, max: 5 } })
    expect(errors({ max_breach_m: '1.5', passes: '5' })).toEqual({})
    expect(validateForm(SLOPE, initialForm(SLOPE, 'Ground', 'Slope', 'en'), 'en').params).toEqual({ unit: { code: 'required' } })
  })

  it('requires at least one output and sends required and selected optional outputs', () => {
    const none = { ...initialForm(FLOW, 'Ground', 'Flow', 'en'), outputs: { area: false, wetness: false } }
    expect(validateForm(FLOW, none, 'en')).toMatchObject({ noOutputs: true, valid: false })
    expect(buildAnalysisRequest(FLOW, { id: 'ground' }, none, 'en')).toBeNull()

    const both = { ...none, outputs: { area: true, wetness: true } }
    expect(buildAnalysisRequest(FLOW, { id: 'ground' }, both, 'en')?.outputs).toEqual(['area', 'wetness'])
    const slope = withValues(initialForm(SLOPE, 'Ground', 'Slope', 'en'), { unit: 'percent' })
    expect(buildAnalysisRequest(SLOPE, { id: 'ground' }, { ...slope, name: '  ' }, 'en')).toEqual({
      analysis_id: 'terrain.slope',
      inputs: [{ key: 'dem', item_id: 'ground' }],
      parameters: [{ key: 'unit', value: { Choice: 'percent' } }],
      outputs: ['slope'],
      name: null,
    })
  })

  it('reads and writes numbers in the user locale', () => {
    expect(parseLocaleNumber('1,5', 'fr')).toBe(1.5)
    expect(parseLocaleNumber('1.5', 'fr')).toBe(1.5)
    expect(parseLocaleNumber('10 000', 'fr')).toBe(10000)
    expect(parseLocaleNumber('1,5', 'en')).toBeNull()
    expect(parseLocaleNumber('0x10', 'en')).toBeNull()
    expect(parseLocaleNumber('', 'en')).toBeNull()
    expect(formatLocaleNumber(2.5, 'de')).toBe('2,5')
    expect(formatLocaleNumber(10000, 'en')).toBe('10000')
    expect(validateForm(FLOW, withValues(initialForm(FLOW, 'G', 'F', 'fr'), { max_breach_m: '2,5' }), 'fr').valid).toBe(true)
  })

  it('defaults the source to the open item, else the open result\'s input, else the first eligible item', () => {
    const accepts: AnalysisOffer[] = [{ analysis_id: 'terrain.slope', unavailable: null }]
    const wrong: AnalysisOffer[] = [{ analysis_id: 'terrain.slope', unavailable: { reason: 'WrongInput', expected: [{ kind: 'Raster', quantity: 'GroundElevation' }] } }]
    const sources = [
      { id: 'surface', name: 'Surface', offers: accepts, inputId: null },
      { id: 'ground', name: 'Ground', offers: accepts, inputId: null },
    ]
    const items = [...sources, { id: 'slope', name: 'Slope', offers: wrong, inputId: 'ground' }]
    expect(defaultAnalysisSource(sources, items, 'ground')).toBe('ground')
    // A result no analysis accepts: its input.
    expect(defaultAnalysisSource(sources, items, 'slope')).toBe('ground')
    // Nothing open: the first eligible item in list order.
    expect(defaultAnalysisSource(sources, items, null)).toBe('surface')
    expect(defaultAnalysisSource([], items, 'slope')).toBeNull()
  })

  it('names parameter units users see: metres, square metres and degrees', () => {
    expect(['metre', 'square-metre', 'degree'].map((unit) => paramUnitSuffix(unit as 'metre'))).toEqual(['m', 'm²', '°'])
  })

  it('shows an existing result in the Design instead of calculating it again', () => {
    const results = [
      { id: 'percent', provenance: provenance({ parameters: [{ key: 'unit', value: { Choice: 'percent' } }] }) },
      { id: 'other-input', provenance: provenance({ inputs: [{ key: 'dem', item_id: 'elsewhere', generation_id: 'g' }] }) },
      { id: 'library-copy', provenance: provenance() },
      { id: 'in-design', provenance: provenance() },
    ]
    const degrees = withValues(initialForm(SLOPE, 'Ground', 'Slope', 'en'), { unit: 'degrees' })
    const inDesign = context({ results, inDesign: new Set(['in-design']) })
    expect(findExistingResult(SLOPE, 'ground', degrees, inDesign, 'en')).toEqual({ id: 'in-design', inDesign: true })
    expect(entryAvailability(SLOPE, subject(), inDesign, degrees, 'en')).toEqual({ reason: 'AlreadyInSiteData', itemId: 'in-design' })

    const libraryOnly = context({ results })
    expect(findExistingResult(SLOPE, 'ground', degrees, libraryOnly, 'en')).toEqual({ id: 'library-copy', inDesign: false })
    expect(entryAvailability(SLOPE, subject(), libraryOnly, degrees, 'en')).toBeNull()

    const unchosen = initialForm(SLOPE, 'Ground', 'Slope', 'en')
    expect(findExistingResult(SLOPE, 'ground', unchosen, inDesign, 'en')).toBeNull()
  })

  it('matches duplicates on effective settings: defaults filled, hidden parameters ignored', () => {
    const form = withValues(initialForm(FLOW, 'Ground', 'Flow', 'en'), { depressions: 'fill' })
    const results = [{
      id: 'flow-1',
      provenance: provenance({
        analysis_id: 'hydrology.flow',
        // Stored with a hidden parameter and without the defaulted ones.
        parameters: [{ key: 'depressions', value: { Choice: 'fill' } }, { key: 'max_breach_m', value: { Number: 7 } }, { key: 'log', value: { Boolean: false } }],
      }),
    }]
    const inDesign = context({ results, inDesign: new Set(['flow-1']) })
    expect(findExistingResult(FLOW, 'ground', form, inDesign, 'en')).toEqual({ id: 'flow-1', inDesign: true })
    expect(analysisOptions(subject(), inDesign, 'en', REGISTRY, GROUPS)[1]!.options[0]!.unavailable).toBeNull()
    expect(findExistingResult(FLOW, 'ground', withValues(form, { passes: '3' }), inDesign, 'en')).toBeNull()
  })

  it('prefills "run again with changes" from an earlier run, in the user locale', () => {
    const earlier = provenance({
      analysis_id: 'hydrology.flow',
      parameters: [
        { key: 'depressions', value: { Choice: 'fill' } },
        { key: 'max_breach_m', value: { Number: 2.5 } },
        { key: 'passes', value: { Integer: 4 } },
        { key: 'log', value: { Boolean: true } },
        // A parameter a later recipe dropped is not carried over.
        { key: 'retired', value: { Number: 1 } },
      ],
    })
    expect(formFromProvenance(FLOW, earlier, ['wetness'], 'Ground', 'Water flow', 'de')).toEqual({
      values: { depressions: 'fill', max_breach_m: '2,5', passes: '4', log: true },
      outputs: { area: false, wetness: true },
      name: 'Ground · Water flow',
    })

    // A parameter the run did not record takes its registry default.
    const partial = provenance({ analysis_id: 'hydrology.flow', parameters: [{ key: 'depressions', value: { Choice: 'fill' } }] })
    expect(formFromProvenance(FLOW, partial, ['area'], 'Ground', 'Flow', 'en').values)
      .toEqual({ depressions: 'fill', max_breach_m: '50', passes: '2', log: false })

    const slope = formFromProvenance(SLOPE, provenance(), ['slope'], 'Ground', 'Slope', 'en')
    expect(buildAnalysisRequest(SLOPE, { id: 'ground' }, slope, 'en')?.parameters)
      .toEqual([{ key: 'unit', value: { Choice: 'degrees' } }])
  })
})

describe('generated registry texts', () => {
  it('canopi-f47t.52.228.48: registry keys are LocaleKeys: a misspelt one fails typecheck, and no shipped one shows raw', () => {
    // @ts-expect-error 'analyses.terrain.slope.titel' is no LocaleKey; this directive fails typecheck if the registry stops typing its keys
    const misspelt: AnalysisEntry['titleKey'] = 'analyses.terrain.slope.titel'
    const keys = [
      ...ANALYSIS_GROUPS.map((group) => group.labelKey),
      ...ANALYSIS_REGISTRY.flatMap((entry) => [
        entry.titleKey, entry.summaryKey,
        ...entry.params.flatMap((param) => [param.labelKey, param.helpKey, ...Object.values(param.optionLabelKeys)]),
        ...entry.outputs.map((output) => output.labelKey),
      ]),
    ]

    expect(keys.filter((key) => t(key) === key)).toEqual([])
    expect(t(misspelt)).toBe(misspelt)
  })

  it('canopi-f47t.52.228.48: filter keys are LocaleKeys: a misspelt one fails typecheck, and no shipped one shows raw', () => {
    // @ts-expect-error 'filters.heigth' is no LocaleKey; this directive fails typecheck if the registry stops typing its keys
    const misspelt: PlantFilterFieldDef['i18nKey'] = 'filters.heigth'
    const keys = [...FILTER_CATEGORIES.map((category) => category.i18nKey), ...PLANT_FILTER_FIELDS.map((field) => field.i18nKey)]

    expect(keys.filter((key) => t(key) === key)).toEqual([])
    expect(t(misspelt)).toBe(misspelt)
  })

  it('canopi-f47t.52.228.48: strip and chip fields carry typed keys and no fallback label, and none shows raw', () => {
    // @ts-expect-error 'filters.nitrogne' is no LocaleKey; this directive fails typecheck if the strip retypes its labels as string
    const misspeltLabel: StripControlField['labelI18nKey'] = 'filters.nitrogne'
    // @ts-expect-error 'filters.habbit_' starts no LocaleKey; this directive fails typecheck if the strip retypes its value families as string
    const misspeltFamily: StripChoiceField['valueI18nPrefix'] = 'filters.habbit_'
    const fields: readonly (StripControlField | ActiveChipField)[] = [...stripControls(), ...activeChipFields()]
    const labels = fields.flatMap((field) => ('labelI18nKey' in field ? [field.labelI18nKey] : []))

    expect(fields.filter((field) => 'fallbackLabel' in field).map((field) => field.filterKey)).toEqual([])
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.filter((key) => t(key) === key)).toEqual([])
    expect([misspeltLabel, misspeltFamily]).toEqual(['filters.nitrogne', 'filters.habbit_'])
  })

  it('names an analysis by its title, and one this build no longer knows by its id', () => {
    expect(analysisTitle('terrain.slope')).toBe('Slope')
    expect(analysisTitle('hydrology.retired')).toBe('hydrology.retired')
    expect(derivedItemName('Ground', 'terrain.slope')).toBe('Ground · Slope')
    expect(derivedItemName(null, 'terrain.slope')).toBe('Slope')
  })
})
