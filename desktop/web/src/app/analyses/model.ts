import {
  ANALYSIS_GROUPS,
  ANALYSIS_REGISTRY,
  type AnalysisEntry,
  type AnalysisGroup,
  type AnalysisParamSpec,
  type ParamUnit,
} from '../../generated/analysis-registry'
import type {
  AnalysisOffer,
  AnalysisParamValue,
  AnalysisRequest,
  AnalysisUnavailable,
  ParamValue,
  Provenance,
} from '../../generated/contracts'
import type { LocaleKey } from '../../generated/locale-keys'

/**
 * The Analyze dialog as a pure model, generated from the analysis registry.
 *
 * Availability merges the native offers (the authority on catalogue, grid and
 * engine facts) with the reasons only the frontend knows: the edition and the
 * current Design's references. Validation mirrors the registry so the form can
 * explain itself inline; the native side validates every request again and
 * stays authoritative.
 */

type Edition = 'desktop' | 'web'

/** Why an analysis cannot run from one item, native or frontend. */
export type AnalysisAvailability =
  | AnalysisUnavailable
  | { readonly reason: 'NeedsDesktop' }
  | { readonly reason: 'AlreadyInSiteData'; readonly itemId: string }

/** What the model reads from the item the dialog analyses. */
export interface AnalysisSubject {
  readonly id: string
  readonly name: string
  readonly offers: readonly AnalysisOffer[]
}

/** A derived library item that may duplicate a request. */
interface ExistingResult {
  readonly id: string
  readonly provenance: Provenance | null
}

export interface AnalysisContext {
  readonly edition: Edition
  /** Every derived item in the library. */
  readonly results: readonly ExistingResult[]
  /** Item ids the current Design references. */
  readonly inDesign: ReadonlySet<string>
}

interface AnalysisOption {
  readonly entry: AnalysisEntry
  readonly unavailable: AnalysisAvailability | null
}

export interface AnalysisOptionGroup {
  readonly key: AnalysisGroup
  readonly labelKey: LocaleKey
  readonly options: readonly AnalysisOption[]
}

/** Raw form values: a choice option, the typed text of a number, or a boolean. */
export type FormValue = string | boolean | null

export interface AnalysisForm {
  readonly values: Readonly<Record<string, FormValue>>
  /** Selection of the optional outputs; required outputs are always produced. */
  readonly outputs: Readonly<Record<string, boolean>>
  readonly name: string
}

export type ParamError =
  | { readonly code: 'required' }
  | { readonly code: 'number' }
  | { readonly code: 'integer' }
  | { readonly code: 'range'; readonly min: number; readonly max: number }
  | { readonly code: 'step'; readonly step: number }

export interface FormValidation {
  readonly params: Readonly<Record<string, ParamError>>
  readonly noOutputs: boolean
  readonly valid: boolean
}

/** A duplicate of the request the form describes. */
export interface ExistingMatch {
  readonly id: string
  readonly inDesign: boolean
}

/**
 * Every registry entry for one item, in registry group order. Entries the
 * item cannot feed stay listed with their reason, so the dialog says why
 * rather than hiding the analysis.
 */
export function analysisOptions(
  subject: AnalysisSubject,
  context: AnalysisContext,
  locale: string,
  registry: readonly AnalysisEntry[] = ANALYSIS_REGISTRY,
  groups: readonly { readonly key: AnalysisGroup; readonly labelKey: LocaleKey }[] = ANALYSIS_GROUPS,
): AnalysisOptionGroup[] {
  return groups.flatMap((group) => {
    const options = registry
      .filter((entry) => entry.group === group.key)
      .map((entry) => ({ entry, unavailable: entryAvailability(entry, subject, context, initialForm(entry, subject.name, '', locale), locale) }))
    return options.length > 0 ? [{ key: group.key, labelKey: group.labelKey, options }] : []
  })
}

/**
 * Why one entry cannot run from this item with these settings, or null.
 *
 * The edition comes first (nothing runs on Web), then the native offer; a run
 * that would duplicate a result the Design already shows is refused last, as
 * "Show in Site data" rather than a second identical calculation.
 */
export function entryAvailability(
  entry: AnalysisEntry,
  subject: AnalysisSubject,
  context: AnalysisContext,
  form: AnalysisForm,
  locale: string,
): AnalysisAvailability | null {
  if (context.edition === 'web') return { reason: 'NeedsDesktop' }
  const offer = subject.offers.find((candidate) => candidate.analysis_id === entry.id)
  // An entry native does not offer cannot be run from this snapshot.
  if (!offer) return { reason: 'NotReady' }
  if (offer.unavailable) return offer.unavailable
  const existing = findExistingResult(entry, subject.id, form, context, locale)
  if (existing?.inDesign) return { reason: 'AlreadyInSiteData', itemId: existing.id }
  return null
}

/**
 * Whether an analysis accepts this item as its input: some offer is not
 * refused for the item's kind or readiness. Analyze lists these items as its
 * Source; an engine or grid problem still shows its reason there.
 */
export function acceptsAnalysis(subject: Pick<AnalysisSubject, 'offers'>): boolean {
  return subject.offers.some((offer) => offer.unavailable?.reason !== 'WrongInput' && offer.unavailable?.reason !== 'NotReady')
}

/**
 * The Source Analyze opens with: the open item when an analysis accepts it,
 * else the open result's input, else the first eligible item in list order.
 * `sources` are the eligible items; `items` every item, with a result's input.
 */
export function defaultAnalysisSource(
  sources: readonly { readonly id: string }[],
  items: readonly { readonly id: string; readonly inputId: string | null }[],
  openId: string | null,
): string | null {
  const eligible = new Set(sources.map((source) => source.id))
  if (openId !== null && eligible.has(openId)) return openId
  const input = items.find((item) => item.id === openId)?.inputId ?? null
  if (input !== null && eligible.has(input)) return input
  return sources[0]?.id ?? null
}

/** The form an entry opens with: registry defaults and the default outputs. */
export function initialForm(entry: AnalysisEntry, subjectName: string, title: string, locale: string): AnalysisForm {
  const values: Record<string, FormValue> = {}
  for (const param of entry.params) values[param.key] = defaultValue(param, locale)
  const outputs: Record<string, boolean> = {}
  for (const output of entry.outputs) {
    if (output.optional) outputs[output.key] = output.defaultSelected
  }
  return { values, outputs, name: title ? suggestedResultName(subjectName, title) : '' }
}

/**
 * The form "Run again with changes" opens with: an earlier run's parameters
 * and outputs, so the user edits them rather than starting over. Parameters
 * the current recipe no longer has are dropped and unrecorded ones take their
 * default; the request it builds is a new definition, never a refresh.
 */
export function formFromProvenance(
  entry: AnalysisEntry,
  provenance: Pick<Provenance, 'parameters'>,
  outputKeys: readonly string[],
  subjectName: string,
  title: string,
  locale: string,
): AnalysisForm {
  const form = initialForm(entry, subjectName, title, locale)
  const values: Record<string, FormValue> = { ...form.values }
  for (const param of entry.params) {
    const recorded = provenance.parameters.find((candidate) => candidate.key === param.key)?.value
    if (recorded) values[param.key] = formValue(recorded, locale)
  }
  const outputs: Record<string, boolean> = {}
  for (const output of entry.outputs) {
    if (output.optional) outputs[output.key] = outputKeys.includes(output.key)
  }
  return { ...form, values, outputs }
}

function formValue(value: ParamValue, locale: string): FormValue {
  if ('Choice' in value) return value.Choice
  if ('Boolean' in value) return value.Boolean
  if ('Number' in value) return formatLocaleNumber(value.Number, locale)
  return formatLocaleNumber(value.Integer, locale)
}

function defaultValue(param: AnalysisParamSpec, locale: string): FormValue {
  const value = param.default
  switch (param.kind.type) {
    case 'choice':
      return typeof value === 'string' ? value : null
    case 'number':
    case 'integer':
      return typeof value === 'number' ? formatLocaleNumber(value, locale) : ''
    case 'boolean':
      return typeof value === 'boolean' ? value : false
  }
}

function suggestedResultName(subjectName: string, title: string): string {
  return `${subjectName} · ${title}`
}

/** Whether a parameter applies under the current values (`visibleWhen`, transitively). */
export function isParamVisible(
  entry: AnalysisEntry,
  values: Readonly<Record<string, FormValue>>,
  key: string,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const param = entry.params.find((candidate) => candidate.key === key)
  if (!param?.visibleWhen || seen.has(key)) return param !== undefined
  const { param: controller, equals } = param.visibleWhen
  const value = values[controller]
  return value !== null && value !== undefined && String(value) === equals
    && isParamVisible(entry, values, controller, new Set([...seen, key]))
}

export function validateForm(entry: AnalysisEntry, form: AnalysisForm, locale: string): FormValidation {
  const params: Record<string, ParamError> = {}
  for (const param of entry.params) {
    if (!isParamVisible(entry, form.values, param.key)) continue
    const error = paramError(param, form.values[param.key] ?? null, locale)
    if (error) params[param.key] = error
  }
  const noOutputs = requestedOutputs(entry, form).length === 0
  return { params, noOutputs, valid: !noOutputs && Object.keys(params).length === 0 }
}

function paramError(param: AnalysisParamSpec, value: FormValue, locale: string): ParamError | null {
  const kind = param.kind
  switch (kind.type) {
    case 'choice':
      return typeof value === 'string' && kind.options.includes(value) ? null : { code: 'required' }
    case 'boolean':
      return null
    case 'number':
    case 'integer': {
      const number = typeof value === 'string' ? parseLocaleNumber(value, locale) : null
      if (number === null) return { code: kind.type === 'integer' ? 'integer' : 'number' }
      if (kind.type === 'integer' && !Number.isInteger(number)) return { code: 'integer' }
      if (number < kind.min || number > kind.max) return { code: 'range', min: kind.min, max: kind.max }
      if (kind.type === 'number' && kind.step > 0) {
        const steps = (number - kind.min) / kind.step
        if (Math.abs(steps - Math.round(steps)) > 1e-9) return { code: 'step', step: kind.step }
      }
      return null
    }
  }
}

/** Typed values of the parameters that apply; hidden ones are omitted so native defaults apply. */
function requestParameters(entry: AnalysisEntry, form: AnalysisForm, locale: string): AnalysisParamValue[] {
  const parameters: AnalysisParamValue[] = []
  for (const param of entry.params) {
    if (!isParamVisible(entry, form.values, param.key)) continue
    const value = paramValue(param, form.values[param.key] ?? null, locale)
    if (value) parameters.push({ key: param.key, value })
  }
  return parameters
}

function paramValue(param: AnalysisParamSpec, value: FormValue, locale: string): ParamValue | null {
  switch (param.kind.type) {
    case 'choice':
      return typeof value === 'string' ? { Choice: value } : null
    case 'boolean':
      return { Boolean: value === true }
    case 'number':
    case 'integer': {
      const number = typeof value === 'string' ? parseLocaleNumber(value, locale) : null
      if (number === null) return null
      return param.kind.type === 'integer' ? { Integer: number } : { Number: number }
    }
  }
}

/** Keys of the outputs to produce, in registry order: required ones plus the selected optional ones. */
function requestedOutputs(entry: AnalysisEntry, form: AnalysisForm): string[] {
  return entry.outputs
    .filter((output) => !output.optional || form.outputs[output.key] === true)
    .map((output) => output.key)
}

/** The native request for a valid form; null while the form is invalid. */
export function buildAnalysisRequest(
  entry: AnalysisEntry,
  subject: Pick<AnalysisSubject, 'id'>,
  form: AnalysisForm,
  locale: string,
): AnalysisRequest | null {
  if (!validateForm(entry, form, locale).valid) return null
  const input = entry.inputs[0]
  if (!input) return null
  return {
    analysis_id: entry.id,
    inputs: [{ key: input.key, item_id: subject.id }],
    parameters: requestParameters(entry, form, locale),
    outputs: requestedOutputs(entry, form),
    name: form.name.trim() || null,
  }
}

/**
 * A derived item already calculated by the same analysis from the same item
 * with the same effective settings, preferring one the Design shows.
 *
 * Settings compare after registry defaults fill omitted parameters and
 * parameters that do not apply are dropped, so an explicit default and an
 * omitted one are the same request.
 */
export function findExistingResult(
  entry: AnalysisEntry,
  subjectId: string,
  form: AnalysisForm,
  context: AnalysisContext,
  locale: string,
): ExistingMatch | null {
  if (!validateForm(entry, form, locale).valid) return null
  const wanted = effectiveParameters(entry, requestParameters(entry, form, locale))
  const inputKey = entry.inputs[0]?.key
  let match: ExistingMatch | null = null
  for (const result of context.results) {
    const provenance = result.provenance
    if (!provenance || provenance.analysis_id !== entry.id) continue
    if (provenance.inputs.length !== 1 || provenance.inputs[0]!.key !== inputKey || provenance.inputs[0]!.item_id !== subjectId) continue
    if (effectiveParameters(entry, provenance.parameters) !== wanted) continue
    const inDesign = context.inDesign.has(result.id)
    if (inDesign) return { id: result.id, inDesign }
    match ??= { id: result.id, inDesign }
  }
  return match
}

function effectiveParameters(entry: AnalysisEntry, parameters: readonly AnalysisParamValue[]): string {
  const values: Record<string, ParamValue> = {}
  for (const param of entry.params) {
    const given = parameters.find((candidate) => candidate.key === param.key)?.value
    const fallback = registryDefault(param)
    const value = given ?? fallback
    if (value) values[param.key] = value
  }
  const formValues: Record<string, FormValue> = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(Object.values(value)[0])]),
  )
  return JSON.stringify(entry.params
    .filter((param) => values[param.key] && isParamVisible(entry, formValues, param.key))
    .map((param) => [param.key, values[param.key]]))
}

function registryDefault(param: AnalysisParamSpec): ParamValue | null {
  const value = param.default
  if (value === null) return null
  switch (param.kind.type) {
    case 'choice': return typeof value === 'string' ? { Choice: value } : null
    case 'number': return typeof value === 'number' ? { Number: value } : null
    case 'integer': return typeof value === 'number' ? { Integer: value } : null
    case 'boolean': return typeof value === 'boolean' ? { Boolean: value } : null
  }
}

/** The unit written after a number parameter's field. */
export function paramUnitSuffix(unit: ParamUnit): string {
  switch (unit) {
    case 'metre': return 'm'
    case 'square-metre': return 'm²'
    case 'degree': return '°'
  }
}

/** A number as a field shows it in this locale: no grouping, locale decimal mark. */
export function formatLocaleNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 6 }).format(value)
}

/**
 * Parse a number typed in this locale. Spaces are ignored and either the
 * locale's decimal mark or a point is accepted; anything else is refused
 * rather than guessed.
 */
export function parseLocaleNumber(text: string, locale: string): number | null {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.'
  let normalised = text.replace(/[\s  ]/g, '')
  if (decimal !== '.') normalised = normalised.split(decimal).join('.')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(normalised)) return null
  const value = Number(normalised)
  return Number.isFinite(value) ? value : null
}
