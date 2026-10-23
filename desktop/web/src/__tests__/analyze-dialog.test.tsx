// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisEntry, AnalysisGroup } from '../generated/analysis-registry'
import type { AnalysisOffer, AnalysisRequest } from '../generated/contracts'
import type { AnalysisContext } from '../app/analyses/model'
import { AnalyzeDialog } from '../components/panels/analyze/AnalyzeDialog'
import { locale } from '../app/settings/state'
import { slopeProvenance } from './support/library-fixtures'
import { dropdownTrigger } from './support/dropdown-trigger'
import { beforePaint, holdAfterPaint } from './support/before-paint'

const water = 'water' as unknown as AnalysisGroup

/** Every parameter type, an advanced disclosure, visibleWhen and optional outputs. */
const FLOW: AnalysisEntry = {
  id: 'hydrology.flow',
  version: 1,
  group: water,
  titleKey: 'fixture.flow.title',
  summaryKey: 'fixture.flow.summary',
  lane: { kind: 'geolibre-windowed', halo: 0 },
  inputs: [{ key: 'dem', accepts: [{ kind: 'Raster', quantity: 'GroundElevation' }], requires: [] }],
  params: [
    {
      key: 'depressions', labelKey: 'fixture.depressions', helpKey: 'fixture.depressionsHelp',
      kind: { type: 'choice', options: ['breach', 'fill'] }, default: 'breach', advanced: false, visibleWhen: null,
      optionLabelKeys: { breach: 'fixture.breach', fill: 'fixture.fill' },
    },
    {
      key: 'max_breach_m', labelKey: 'fixture.maxBreach', helpKey: 'fixture.maxBreachHelp',
      kind: { type: 'number', min: 1, max: 1000, step: 1, unit: 'metre' }, default: 50, advanced: true,
      visibleWhen: { param: 'depressions', equals: 'breach' }, optionLabelKeys: {},
    },
    {
      key: 'passes', labelKey: 'fixture.passes', helpKey: 'fixture.passesHelp',
      kind: { type: 'integer', min: 1, max: 5 }, default: 2, advanced: false, visibleWhen: null, optionLabelKeys: {},
    },
    {
      key: 'log', labelKey: 'fixture.log', helpKey: 'fixture.logHelp',
      kind: { type: 'boolean' }, default: true, advanced: false, visibleWhen: null, optionLabelKeys: {},
    },
  ],
  outputs: [
    { key: 'area', labelKey: 'fixture.area', item: { kind: 'Raster', quantity: 'OtherContinuous' }, units: { kind: 'fixed', value: 'm²' }, optional: true, defaultSelected: true, presentable: true },
    { key: 'wetness', labelKey: 'fixture.wetness', item: { kind: 'Raster', quantity: 'OtherContinuous' }, units: { kind: 'fixed', value: '' }, optional: true, defaultSelected: false, presentable: true },
  ],
}

const SLOPE: AnalysisEntry = {
  ...FLOW,
  id: 'terrain.slope',
  group: 'terrain',
  titleKey: 'analyses.terrain.slope.title',
  summaryKey: 'analyses.terrain.slope.summary',
  params: [{
    key: 'unit', labelKey: 'analyses.terrain.slope.params.unit.label', helpKey: 'analyses.terrain.slope.params.unit.help',
    kind: { type: 'choice', options: ['degrees', 'percent'] }, default: null, advanced: false, visibleWhen: null,
    optionLabelKeys: { degrees: 'analyses.terrain.slope.params.unit.options.degrees', percent: 'analyses.terrain.slope.params.unit.options.percent' },
  }],
  outputs: [{ key: 'slope', labelKey: 'analyses.terrain.slope.outputs.slope', item: { kind: 'Raster', quantity: 'Slope' }, units: { kind: 'by-param', param: 'unit', map: { degrees: '°', percent: '%' } }, optional: false, defaultSelected: true, presentable: true }],
}

const REGISTRY = [SLOPE, FLOW]
const GROUPS = [{ key: 'terrain' as AnalysisGroup, labelKey: 'analyses.groups.terrain' }, { key: water, labelKey: 'fixture.water' }]
const OFFERS: AnalysisOffer[] = [
  { analysis_id: 'terrain.slope', unavailable: null },
  { analysis_id: 'hydrology.flow', unavailable: null },
]

let container: HTMLDivElement
const onRun = vi.fn<(request: AnalysisRequest) => void>()
const onCancel = vi.fn()
const onShowInSiteData = vi.fn()
const onAddExisting = vi.fn()

const CANOPY_OFFERS: AnalysisOffer[] = [
  { analysis_id: 'terrain.slope', unavailable: { reason: 'WrongInput', expected: [{ kind: 'Raster', quantity: 'GroundElevation' }] } },
  { analysis_id: 'hydrology.flow', unavailable: null },
]

function mount(options: {
  context?: Partial<AnalysisContext>
  offers?: AnalysisOffer[]
  initial?: string | null
  sources?: { id: string; name: string; offers: AnalysisOffer[] }[]
  sourceId?: string
  sourceFixed?: boolean
} = {}): void {
  const context: AnalysisContext = { edition: 'desktop', results: [], inDesign: new Set(), ...options.context }
  const sources = options.sources ?? [{ id: 'ground', name: 'Ground', offers: options.offers ?? OFFERS }]
  act(() => {
    render(
      <AnalyzeDialog
        sources={sources}
        sourceId={options.sourceId ?? sources[0]!.id}
        sourceFixed={options.sourceFixed ?? false}
        context={context}
        canAddToDesign
        initialAnalysisId={options.initial ?? null}
        busy={false}
        error={null}
        onCancel={onCancel}
        onRun={onRun}
        onShowInSiteData={onShowInSiteData}
        onAddExisting={onAddExisting}
        registry={REGISTRY}
        groups={GROUPS}
      />,
      container,
    )
  })
}

function radio(label: string): HTMLInputElement {
  const found = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    .find((input) => input.closest('label')?.textContent?.includes(label))
  if (!found) throw new Error(`no radio ${label}`)
  return found
}

function field(label: string): HTMLInputElement {
  const target = Array.from(container.querySelectorAll('label')).find((node) => node.textContent === label)
  const input = target ? document.getElementById(target.htmlFor) as HTMLInputElement | null : null
  if (!input) throw new Error(`no field ${label}`)
  return input
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('Analyze dialog', () => {
  beforeEach(() => {
    locale.value = 'en'
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('is titled Analyze, says where results go and starts from the given source', () => {
    mount({ sources: [{ id: 'canopy', name: 'Canopy', offers: CANOPY_OFFERS }, { id: 'ground', name: 'Ground', offers: OFFERS }], sourceId: 'ground', context: { inDesign: new Set(['canopy', 'ground']) } })
    expect(container.querySelector('h2')?.textContent).toBe('Analyze')
    expect(container.textContent).toContain('Results are added under their source in Site data and kept in your library.')
    expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Ground')
  })

  it('recomputes the analyses and the result name when the Source changes', async () => {
    mount({ sources: [{ id: 'ground', name: 'Ground', offers: OFFERS }, { id: 'canopy', name: 'Canopy', offers: CANOPY_OFFERS }] })
    expect(container.textContent).not.toContain('Needs Ground elevation (DTM).')
    await act(async () => { dropdownTrigger(container, 'Source')!.click() })
    const canopy = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'Canopy')!
    await act(async () => { canopy.click() })
    expect(dropdownTrigger(container, 'Source')?.textContent).toContain('Canopy')
    expect(container.textContent).toContain('Needs Ground elevation (DTM).')
    // Slope cannot run from Canopy, so the first analysis that can is chosen and named after the new source.
    expect(radio('fixture.flow.title').checked).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe('Canopy · fixture.flow.title')
    await submit()
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ inputs: [{ key: 'dem', item_id: 'canopy' }] }))
  })

  it('starts the forms afresh when the Source changes back to the one it opened with', async () => {
    const both = [{ id: 'ground', name: 'Ground', offers: OFFERS }, { id: 'canopy', name: 'Canopy', offers: OFFERS }]
    mount({ sources: both, initial: 'hydrology.flow' })
    const chooseSource = async (name: string) => {
      await act(async () => { dropdownTrigger(container, 'Source')!.click() })
      const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((candidate) => candidate.textContent === name)!
      await act(async () => { option.click() })
    }
    await chooseSource('Canopy')
    await type(container.querySelector<HTMLInputElement>('input:not([type])')!, 'Canopy flow (fine)')
    await chooseSource('Ground')
    expect(container.querySelector<HTMLInputElement>('input:not([type])')!.value).toBe('Ground · fixture.flow.title')
  })

  it('keeps the source of Run again with changes fixed', () => {
    mount({ sources: [{ id: 'ground', name: 'Ground', offers: OFFERS }], sourceFixed: true })
    expect(dropdownTrigger(container, 'Source')).toBeNull()
    expect(container.querySelector('[data-analysis-source]')?.textContent).toBe('SourceGround')
  })

  it('lists the registry by group and focuses the chosen entry', async () => {
    mount({ initial: 'hydrology.flow' })
    await act(async () => {})
    expect(Array.from(container.querySelectorAll('legend')).slice(0, 2).map((node) => node.textContent)).toEqual(['Terrain', 'fixture.water'])
    expect(document.activeElement).toBe(radio('fixture.flow.title'))
    expect(radio('fixture.flow.title').checked).toBe(true)
  })

  // canopi-f47t.52.228.20: the chosen entry took focus after paint (Preact 11 useEffect), after the dialog shell had
  // focused its first control, so the dialog first showed with focus on the wrong control.
  it('canopi-f47t.52.228.20: the chosen entry has focus as the dialog shows, and an Esc at once cancels', async () => {
    const release = holdAfterPaint()
    try {
      render(
        <AnalyzeDialog
          sources={[{ id: 'ground', name: 'Ground', offers: OFFERS }]}
          sourceId="ground"
          context={{ edition: 'desktop', results: [], inDesign: new Set() }}
          canAddToDesign
          initialAnalysisId="hydrology.flow"
          busy={false}
          error={null}
          onCancel={onCancel}
          onRun={onRun}
          onShowInSiteData={onShowInSiteData}
          onAddExisting={onAddExisting}
          registry={REGISTRY}
          groups={GROUPS}
        />,
        container,
      )
      await beforePaint()
      expect(document.activeElement, 'the chosen entry has focus as it first shows').toBe(radio('fixture.flow.title'))
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(onCancel, 'Esc cancelled').toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
  })

  it('renders parameters by type, advanced ones in a disclosure, and honours visibleWhen', async () => {
    mount({ initial: 'hydrology.flow' })
    expect(radio('fixture.breach').checked).toBe(true)
    expect(field('fixture.passes').value).toBe('2')
    expect(container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true)
    const advanced = container.querySelector('details')!
    expect(advanced.querySelector('summary')?.textContent).toBe('Advanced settings')
    const max = field('fixture.maxBreach')
    expect(advanced.contains(max)).toBe(true)
    expect(max.value).toBe('50')
    expect(max.getAttribute('aria-describedby')).toContain(`${max.id}-unit`)
    expect(document.getElementById(`${max.id}-unit`)?.textContent).toBe('m')

    await act(async () => { radio('fixture.fill').click() })
    expect(container.querySelector('details')).toBeNull()
  })

  it('builds the request from the form: typed values, hidden parameters omitted, chosen outputs', async () => {
    mount({ initial: 'hydrology.flow' })
    await act(async () => { radio('fixture.fill').click() })
    await act(async () => { container.querySelector<HTMLInputElement>('input[role="switch"]')!.click() })
    const wetness = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role])'))
      .find((input) => input.closest('label')?.textContent === 'fixture.wetness')!
    await act(async () => { wetness.click() })
    const name = container.querySelector<HTMLInputElement>('input:not([type])')!
    await type(name, 'Flow paths')
    await submit()

    expect(onRun).toHaveBeenCalledWith({
      analysis_id: 'hydrology.flow',
      inputs: [{ key: 'dem', item_id: 'ground' }],
      parameters: [
        { key: 'depressions', value: { Choice: 'fill' } },
        { key: 'passes', value: { Integer: 2 } },
        { key: 'log', value: { Boolean: false } },
      ],
      outputs: ['area', 'wetness'],
      name: 'Flow paths',
    })
  })

  it('explains invalid values inline and does not run', async () => {
    mount({ initial: 'hydrology.flow' })
    const passes = field('fixture.passes')
    await type(passes, '9')
    expect(container.textContent).toContain('Enter a value from 1 to 5.')
    expect(passes.getAttribute('aria-invalid')).toBe('true')
    await submit()
    expect(onRun).not.toHaveBeenCalled()
  })

  it('names why each unavailable entry cannot run', () => {
    mount({ offers: [
      { analysis_id: 'terrain.slope', unavailable: { reason: 'ValuesNotMetres', units: 'ft' } },
      { analysis_id: 'hydrology.flow', unavailable: { reason: 'GridNotProjectedMetres' } },
    ] })
    expect(container.textContent).toContain('Needs values in metres; this data is in ft.')
    expect(container.textContent).toContain('Needs a projected grid in ground metres, not Web Mercator or longitude and latitude.')
    const run = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Run')!
    expect(run.disabled).toBe(true)
  })

  it('says every analysis needs Desktop on Web', () => {
    mount({ context: { edition: 'web' } })
    expect(container.querySelectorAll('[class*="reason"]')).toHaveLength(2)
    expect(container.textContent).toContain('Needs Canopi Desktop.')
  })

  it('offers Show in Site data instead of Run for a result the Design already shows', async () => {
    mount({ context: { results: [{ id: 'slope-1', provenance: slopeProvenance('slope-1', 'ground') }], inDesign: new Set(['slope-1']) } })
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Run')).toBe(true)
    await act(async () => { radio('Degrees').click() })

    expect(container.textContent).toContain('Already in Site data.')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Run')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Show in Site data')).toBe(true)
    await submit()
    expect(onShowInSiteData).toHaveBeenCalledWith('slope-1')
    expect(onRun).not.toHaveBeenCalled()
  })

  it('marks an entry already in Site data when its default settings match', () => {
    const results = [{ id: 'flow-1', provenance: slopeProvenance('flow-1', 'ground', { analysis_id: 'hydrology.flow', parameters: [] }) }]
    mount({ context: { results, inDesign: new Set(['flow-1']) } })
    expect(container.textContent).toContain('Already in Site data.')
  })

  it('cancels with Escape', async () => {
    mount()
    await act(async () => {
      radio('Slope').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
