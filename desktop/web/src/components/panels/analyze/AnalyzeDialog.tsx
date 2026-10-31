import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'
import {
  ANALYSIS_GROUPS,
  ANALYSIS_REGISTRY,
  type AnalysisEntry,
  type AnalysisGroup,
  type AnalysisParamSpec,
} from '../../../generated/analysis-registry'
import type { AnalysisRequest } from '../../../generated/contracts'
import {
  analysisOptions,
  buildAnalysisRequest,
  entryAvailability,
  findExistingResult,
  initialForm,
  isParamVisible,
  paramUnitSuffix,
  validateForm,
  type AnalysisContext,
  type AnalysisForm,
  type AnalysisSubject,
  type FormValue,
} from '../../../app/analyses/model'
import { locale } from '../../../app/settings/state'
import { t } from '../../../i18n'
import { registryText } from '../../../app/analyses/registry'
import { Dropdown } from '../../shared/Dropdown'
import { Notice } from '../../shared/Notice'
import { Switch } from '../../shared/Switch'
import { WorkspaceDialog } from '../../shared/WorkspaceDialog'
import { paramErrorText, unavailableText } from './analysis-text'
import styles from './analyze-dialog.module.css'

/**
 * The Analyze dialog, generated from the analysis registry.
 *
 * Source comes first: one of this Design's items an analysis accepts, in list
 * order (fixed for "Run again with changes…"; the item asked for alone when no
 * item is accepted, so each entry says why); changing it recomputes the
 * analyses. Every entry is listed; one that cannot run says why by name. The
 * chosen entry's parameters render by type, advanced ones in a disclosure, and
 * a run that would duplicate a result this Design already shows becomes "Show
 * in Site data". The model mirrors native validation for inline errors only.
 */
export function AnalyzeDialog({
  sources,
  sourceId,
  sourceFixed = false,
  context,
  canAddToDesign,
  initialAnalysisId = null,
  prefill = null,
  busy,
  error,
  onCancel,
  onRun,
  onShowInSiteData,
  onAddExisting,
  registry = ANALYSIS_REGISTRY,
  groups = ANALYSIS_GROUPS,
}: {
  /** The items Analyze can start from, in Site data's list order. */
  sources: readonly AnalysisSubject[]
  /** The Source the dialog opens with (`defaultAnalysisSource`). */
  sourceId: string
  /** "Run again with changes…": the source is the result's input and cannot change. */
  sourceFixed?: boolean
  context: AnalysisContext
  /** Whether a Design is open to add an existing result to. */
  canAddToDesign: boolean
  initialAnalysisId?: string | null
  /** The opening form of `initialAnalysisId`, e.g. an earlier run's settings. */
  prefill?: AnalysisForm | null
  busy: boolean
  error: string | null
  onCancel(): void
  onRun(request: AnalysisRequest): void
  onShowInSiteData(itemId: string): void
  onAddExisting(itemId: string): void
  registry?: readonly AnalysisEntry[]
  groups?: readonly { readonly key: AnalysisGroup; readonly labelKey: string }[]
}) {
  const language = locale.value
  const titleId = useId()
  const formId = `${titleId}-form`
  const root = useRef<HTMLFormElement>(null)
  const [currentSourceId, setCurrentSourceId] = useState(sourceId)
  const item = sources.find((source) => source.id === currentSourceId) ?? sources[0]!
  const options = useMemo(
    () => analysisOptions(item, context, language, registry, groups),
    [item, context, language, registry, groups],
  )
  const flat = options.flatMap((group) => group.options)
  const firstChoice = (preferred: string | null) =>
    flat.find((option) => option.entry.id === preferred && option.unavailable === null)?.entry.id
    ?? flat.find((option) => option.entry.id === preferred)?.entry.id
    ?? flat.find((option) => option.unavailable === null)?.entry.id
    ?? flat[0]?.entry.id
    ?? null
  const [selectedId, setSelectedId] = useState<string | null>(() => firstChoice(initialAnalysisId))
  const [forms, setForms] = useState<Readonly<Record<string, AnalysisForm>>>(() =>
    initialAnalysisId && prefill ? { [initialAnalysisId]: prefill } : {})
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [attempted, setAttempted] = useState(false)

  // A new Source starts the forms afresh (their names follow it) and keeps the chosen analysis when it can run.
  const formsSourceId = useRef(sourceId)
  useEffect(() => {
    if (currentSourceId === formsSourceId.current) return
    formsSourceId.current = currentSourceId
    setForms({})
    setTouched(new Set())
    setAttempted(false)
    setSelectedId((previous) =>
      flat.find((option) => option.entry.id === previous && option.unavailable === null)?.entry.id ?? firstChoice(null))
  }, [currentSourceId])

  const entry = flat.find((option) => option.entry.id === selectedId)?.entry ?? null
  const form = entry ? forms[entry.id] ?? initialForm(entry, item.name, registryText(entry.titleKey), language) : null
  const unavailable = entry && form ? entryAvailability(entry, item, context, form, language) : null
  const blocked = unavailable !== null && unavailable.reason !== 'AlreadyInSiteData'
  const validation = entry && form ? validateForm(entry, form, language) : null
  const existing = entry && form ? findExistingResult(entry, item.id, form, context, language) : null

  const update = (next: AnalysisForm) => {
    if (entry) setForms({ ...forms, [entry.id]: next })
  }
  const setValue = (key: string, value: FormValue) => {
    if (!form) return
    update({ ...form, values: { ...form.values, [key]: value } })
    setTouched(new Set([...touched, key]))
  }
  const choose = (id: string) => {
    setSelectedId(id)
    setAttempted(false)
    setTouched(new Set())
  }
  const submit = () => {
    if (!entry || !form || busy || blocked) return
    if (existing?.inDesign) {
      onShowInSiteData(existing.id)
      return
    }
    const request = buildAnalysisRequest(entry, item, form, language)
    if (!request) {
      setAttempted(true)
      // Move to the first field that needs attention so the error is announced.
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    onRun(request)
  }

  const paramControl = (param: AnalysisParamSpec) => {
    if (!entry || !form || !isParamVisible(entry, form.values, param.key)) return null
    const problem = validation?.params[param.key]
    const shown = problem && (attempted || touched.has(param.key)) ? problem : null
    return (
      <ParamField
        key={param.key}
        param={param}
        value={form.values[param.key] ?? null}
        error={shown ? paramErrorText(shown, language) : null}
        onChange={(value) => setValue(param.key, value)}
      />
    )
  }
  const basic = entry?.params.filter((param) => !param.advanced) ?? []
  const advanced = entry?.params.filter((param) => param.advanced) ?? []
  const listOutputs = entry ? entry.outputs.length > 1 || entry.outputs.some((output) => output.optional) : false

  return (
    <WorkspaceDialog
      title={t('analyses.dialog.title')}
      onClose={onCancel}
      footer={<>
        <button type="button" className={styles.button} onClick={onCancel}>{t('canvas.lidar.library.cancel')}</button>
        {existing?.inDesign
          ? <button type="submit" form={formId} className={`${styles.button} ${styles.primary}`}>{t('analyses.dialog.showInSiteData')}</button>
          : (
            <button type="submit" form={formId} className={`${styles.button} ${styles.primary}`} disabled={busy || !entry || blocked}>
              {existing ? t('analyses.dialog.runAgain') : t('analyses.dialog.run')}
            </button>
          )}
      </>}
    >
    <form
      id={formId}
      ref={root}
      className={styles.dialog}
      noValidate
      onSubmit={(event) => { event.preventDefault(); submit() }}
    >
      {sourceFixed
        ? (
          <div className={styles.field} data-analysis-source>
            <span className={styles.label} aria-hidden="true">{t('analyses.dialog.source')}</span>
            <span>{item.name}</span>
          </div>
        )
        : (
          <div className={styles.field}>
            <span className={styles.label} aria-hidden="true">{t('analyses.dialog.source')}</span>
            <Dropdown<string>
              ariaLabel={t('analyses.dialog.source')}
              trigger={item.name}
              items={sources.map((source) => ({ value: source.id, label: source.name }))}
              value={item.id}
              onChange={setCurrentSourceId}
            />
          </div>
        )}
      {/* The one attach rule (`runAnalysis`): results join this Design only when it shows their source. */}
      <p className={styles.intro}>{t(context.inDesign.has(item.id) ? 'analyses.dialog.intro' : 'analyses.dialog.introLibraryOnly')}</p>
      {options.map((group) => (
        <fieldset key={group.key} className={styles.entries}>
          <legend>{registryText(group.labelKey)}</legend>
          {group.options.map((option) => {
            const checked = option.entry.id === selectedId
            const reasonId = `${titleId}-${option.entry.id}-reason`
            return (
              <label key={option.entry.id} className={styles.entry} data-checked={checked} data-unavailable={option.unavailable !== null}>
                <input
                  type="radio"
                  name={`${titleId}-analysis`}
                  checked={checked}
                  data-dialog-initial-focus={checked ? 'true' : undefined}
                  aria-describedby={option.unavailable ? reasonId : undefined}
                  onChange={() => choose(option.entry.id)}
                />
                <span>
                  <strong>{registryText(option.entry.titleKey)}</strong>
                  <small>{registryText(option.entry.summaryKey)}</small>
                  {option.unavailable && (
                    <small id={reasonId} className={styles.reason}>{unavailableText(option.unavailable)}</small>
                  )}
                </span>
              </label>
            )
          })}
        </fieldset>
      ))}

      {entry && form && blocked && unavailable && (
        <Notice tone="warning">{unavailableText(unavailable)}</Notice>
      )}
      {entry && form && !blocked && <>
        {basic.map(paramControl)}
        {advanced.some((param) => isParamVisible(entry, form.values, param.key)) && (
          <details className={styles.advanced}>
            <summary>{t('analyses.dialog.advanced')}</summary>
            <div className={styles.advancedBody}>{advanced.map(paramControl)}</div>
          </details>
        )}
        {listOutputs && (
          <fieldset className={styles.group}>
            <legend>{t('analyses.dialog.outputs')}</legend>
            {entry.outputs.map((output) => (
              <label key={output.key} className={styles.check}>
                <input
                  type="checkbox"
                  checked={!output.optional || form.outputs[output.key] === true}
                  disabled={!output.optional}
                  onChange={(event) => update({ ...form, outputs: { ...form.outputs, [output.key]: event.currentTarget.checked } })}
                />
                {registryText(output.labelKey)}
              </label>
            ))}
            {validation?.noOutputs && <small className={styles.error} role="alert">{t('analyses.dialog.errors.noOutputs')}</small>}
          </fieldset>
        )}
        <label className={styles.field}>
          <span>{t('analyses.dialog.name')}</span>
          <input value={form.name} onInput={(event) => update({ ...form, name: event.currentTarget.value })} />
        </label>
        {existing?.inDesign
          ? <Notice tone="info">{t('analyses.unavailable.AlreadyInSiteData')}</Notice>
          : existing && (
            <Notice
              tone="info"
              action={canAddToDesign
                ? <button type="button" onClick={() => onAddExisting(existing.id)}>{t('analyses.dialog.addExisting')}</button>
                : undefined}
            >
              {t('analyses.dialog.existingInLibrary')}
            </Notice>
          )}
      </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
    </WorkspaceDialog>
  )
}

function ParamField({ param, value, error, onChange }: {
  param: AnalysisParamSpec
  value: FormValue
  error: string | null
  onChange(value: FormValue): void
}) {
  const id = useId()
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const help = registryText(param.helpKey)
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  const kind = param.kind
  const messages = <>
    {help && <small id={helpId} className={styles.help}>{help}</small>}
    {error && <small id={errorId} className={styles.error}>{error}</small>}
  </>
  switch (kind.type) {
    case 'choice':
      return (
        <fieldset className={styles.group} aria-describedby={describedBy}>
          <legend>{registryText(param.labelKey)}</legend>
          {kind.options.map((option, index) => (
            <label key={option} className={styles.check}>
              <input
                type="radio"
                name={`${id}-${param.key}`}
                checked={value === option}
                aria-invalid={error && index === 0 ? 'true' : undefined}
                onChange={() => onChange(option)}
              />
              {param.optionLabelKeys[option] ? registryText(param.optionLabelKeys[option]!) : option}
            </label>
          ))}
          {messages}
        </fieldset>
      )
    case 'boolean':
      return (
        <div className={styles.group}>
          <Switch label={registryText(param.labelKey)} hint={help || undefined} checked={value === true} onChange={onChange} />
        </div>
      )
    case 'number':
    case 'integer': {
      const suffix = kind.type === 'number' ? paramUnitSuffix(kind.unit) : ''
      const unitId = `${id}-unit`
      return (
        <div className={styles.field}>
          <label for={id}>{registryText(param.labelKey)}</label>
          <span className={styles.numberField}>
            <input
              id={id}
              type="text"
              inputMode={kind.type === 'integer' ? 'numeric' : 'decimal'}
              value={typeof value === 'string' ? value : ''}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={[suffix ? unitId : null, describedBy].filter(Boolean).join(' ') || undefined}
              onInput={(event) => onChange(event.currentTarget.value)}
            />
            {suffix && <span id={unitId}>{suffix}</span>}
          </span>
          {messages}
        </div>
      )
    }
  }
}
