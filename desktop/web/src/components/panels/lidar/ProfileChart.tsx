import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { JSX, Ref, TargetedPointerEvent } from 'preact'
import { buildProfilePlot, curveStyle, distanceTicks, indexAtX, type PlotArea } from '../../../app/lidar/profile-chart'
import {
  profileCopyText,
  profileCursor,
  retrySiteProfile,
  setProfileCursor,
  siteProfile,
  type ProfileCurve,
  type SiteProfile,
} from '../../../app/lidar/profile'
import { unitSuffix } from '../../../app/lidar/item-types'
import { formatRowValue } from '../../../app/lidar/value-format'
import { clearProfile } from '../../../app/lidar/site-transients'
import { formatLength } from '../../../app/map-selection/zone-label'
import { locale } from '../../../app/settings/state'
import { t } from '../../../i18n'
import { ButtonTooltip } from '../../shared/ButtonTooltip'
import { ControlIcon } from '../../shared/ControlIcon'
import styles from './profile.module.css'

type ReadyProfile = Extract<SiteProfile, { status: 'ready' }>

/** The chart's drawing width in SVG units; it scales to the panel. */
const WIDTH = 408
/** The first plot (elevation, or height alone) and the height strip under elevation, in SVG units. */
const MAIN_PLOT = 106
const STRIP_PLOT = 48
const PLOT_GAP = 12
const AXIS = 22
/**
 * The value labels end 6 units left of the plot: the gutter fits "1,234.5 m" (50.3 units in Source Sans 3 at
 * --text-xs), and the SVG lets anything wider show into the panel's padding rather than cut it.
 */
const X0 = 60
const X1 = WIDTH - 6
/** Half the widest distance label ("12,345 m"): a tick nearer the right edge than this ends its label on the tick. */
const TICK_LABEL_HALF = 26
/** How long "Copied" or the copy error shows. */
const COPY_FEEDBACK_MS = 2000

/**
 * The Site data profile chart (canopi-f47t.42, spec §1.10 "Profile"), pinned to the bottom of the Site data panel, which
 * mounts it with no props: it reads the profile itself and draws nothing while no profile is shown. Header: "Profile",
 * the length, "At {distance}" while the cursor is on the chart, Copy values and ×. A failed read says so, with a Retry the
 * user presses (never retried by itself): the whole chart when no curve has a value, otherwise the legend line of each
 * curve that could not be read, with one Retry under the legend. Pressing Retry moves focus to the chart while it reads,
 * and back to Retry if the read fails again, so a keyboard user stays in the profile. Elevation curves share the first plot
 * and height curves a strip under it, sharing distance and cursor; hovering or scrubbing moves the cursor, which the map
 * shows as a ring on the line. The legend gives each curve's value at the cursor while the pointer is on the plots,
 * otherwise Rise and Steepest (a button that moves the cursor there until it loses focus) or Highest.
 */
export function ProfileChart() {
  const profile = siteProfile.value
  const section = useRef<HTMLElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  // After paint on purpose (focus-only-in-layout-effect entry): Retry takes focus back once a failed read offers it again.
  useEffect(() => {
    if (offersRetry(profile) && document.activeElement === section.current) retryButton.current?.focus()
  }, [profile])
  if (profile.status === 'none') return null
  const language = locale.value
  // Retry unmounts as the read starts: the section, which every state keeps, holds focus meanwhile.
  const retry = () => {
    section.current?.focus()
    retrySiteProfile()
  }
  return (
    <section ref={section} className={styles.profile} aria-label={t('siteData.profile')} tabIndex={-1}>
      <div className={styles.header}>
        <h3 className={styles.title}>{t('siteData.profile')}</h3>
        <span className={styles.length}>{formatLength(profile.lengthM, language)}</span>
        <span className={styles.at} role="status">{profile.status === 'ready' ? <CursorDistance profile={profile} language={language} /> : null}</span>
        {profile.status === 'ready' ? <CopyValues profile={profile} /> : null}
        <button type="button" className={styles.iconButton} aria-label={t('siteData.chart.close')} onClick={clearProfile}>
          <ControlIcon name="close" size={16} />
          <ButtonTooltip label={t('siteData.chart.close')} side="top" />
        </button>
      </div>
      {profile.status === 'ready'
        ? <ReadyChart profile={profile} language={language} retry={retry} retryButton={retryButton} />
        : profile.status === 'read-failed'
          ? (
              <div className={styles.failed}>
                <p className={styles.state}>{t('siteData.chart.readFailed')}</p>
                <button ref={retryButton} type="button" className={styles.textButton} onClick={retry}>{t('siteData.chart.retry')}</button>
              </div>
            )
          : <p className={styles.state}>{t(STATE_TEXT[profile.status])}</p>}
    </section>
  )
}

/** Whether the profile shows Retry: the read failed, or some curve's data could not be read. */
function offersRetry(profile: SiteProfile): boolean {
  return profile.status === 'read-failed' || (profile.status === 'ready' && profile.curves.some((curve) => curve.readFailed))
}

/** "At {distance}" while the cursor is on the chart. Only this, the cursor marks and the legend follow the cursor. */
function CursorDistance({ profile, language }: { readonly profile: ReadyProfile; readonly language: string }) {
  const cursor = profileCursor.value
  return cursor === null ? null : <>{t('siteData.chart.at', { distance: formatLength(profile.samples.distances[cursor]!, language) })}</>
}

/** One formatter per locale and options: the legend re-renders at scrub rate. */
const formatters = new Map<string, Intl.NumberFormat>()
function numberFormat(language: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${language}|${JSON.stringify(options)}`
  let format = formatters.get(key)
  if (!format) {
    format = new Intl.NumberFormat(language, options)
    formatters.set(key, format)
  }
  return format
}

const STATE_TEXT: Readonly<Record<'needs-layer' | 'reading' | 'no-values', string>> = {
  'needs-layer': 'siteData.chart.needsLayer',
  reading: 'siteData.chart.reading',
  'no-values': 'siteData.chart.noValues',
}

/** Copy values: the text is built and written inside the click, the user's activation; "Copied" or the error for 2 s. */
function CopyValues({ profile }: { readonly profile: ReadyProfile }) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const show = (next: 'copied' | 'failed') => {
    setFeedback(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setFeedback(null), COPY_FEEDBACK_MS)
  }
  const copy = () => {
    const text = profileCopyText(profile, locale.peek(), t)
    let written: Promise<void>
    try {
      written = navigator.clipboard.writeText(text)
    } catch (error) {
      written = Promise.reject(error)
    }
    written.then(() => show('copied'), () => show('failed'))
  }
  return (
    <>
      {feedback ? (
        <span className={feedback === 'failed' ? styles.copyFailed : styles.copied} role="status">
          {t(feedback === 'failed' ? 'siteData.chart.copyFailed' : 'siteData.chart.copied')}
        </span>
      ) : null}
      <button type="button" className={styles.textButton} onClick={copy}>
        <ControlIcon name="copy" size={16} />
        {t('siteData.chart.copyValues')}
      </button>
    </>
  )
}

interface PlotLayout {
  readonly role: 'elevation' | 'height'
  readonly area: PlotArea
  readonly curves: readonly { readonly curve: ProfileCurve; readonly index: number }[]
}

interface DrawnPlot {
  readonly plot: PlotLayout
  readonly geometry: ReturnType<typeof buildProfilePlot>
}

/** The plots' layout and geometry, which depend on the profile alone. */
function drawProfile(profile: ReadyProfile): { readonly drawn: readonly DrawnPlot[]; readonly bottom: number } {
  const indexed = profile.curves.map((curve, index) => ({ curve, index }))
  const plots: PlotLayout[] = []
  let top = 6
  for (const role of ['elevation', 'height'] as const) {
    const curves = indexed.filter(({ curve }) => curve.role === role)
    if (curves.length === 0) continue
    const height = plots.length === 0 ? MAIN_PLOT : STRIP_PLOT
    plots.push({ role, area: { x0: X0, x1: X1, top, bottom: top + height }, curves })
    top += height + PLOT_GAP
  }
  const drawn = plots.map((plot) => ({
    plot,
    geometry: buildProfilePlot({
      ...plot.area,
      distances: profile.samples.distances,
      series: plot.curves.map(({ curve }) => curve.values),
      fromZero: plot.role === 'height',
    }),
  }))
  return { drawn, bottom: plots[plots.length - 1]!.area.bottom }
}

/**
 * The plots and legend. The curves, axes and ticks are drawn once per profile and locale; a pointer move re-renders
 * only the cursor marks, the legend readings and "At …".
 */
function ReadyChart({ profile, language, retry, retryButton }: {
  readonly profile: ReadyProfile
  readonly language: string
  retry(): void
  readonly retryButton: Ref<HTMLButtonElement>
}) {
  const { drawn, bottom } = useMemo(() => drawProfile(profile), [profile])
  const { distances } = profile.samples
  // Readings replace the legend's Rise and Steepest only while the pointer is on the plots: a cursor Steepest set keeps
  // the legend, so its button stays in place and keeps focus.
  const [hovering, setHovering] = useState(false)
  // Read in events, before the render the state change asks for: pressing the plots blurs Steepest after the press.
  const pointerOnPlots = useRef(false)
  const pointerOn = (on: boolean) => {
    pointerOnPlots.current = on
    setHovering(on)
  }
  const leave = () => {
    pointerOn(false)
    setProfileCursor(null)
  }
  // Steepest's cursor lasts while its button has focus, unless the pointer took the cursor over on the plots.
  const releaseSteepest = () => {
    if (!pointerOnPlots.current) setProfileCursor(null)
  }
  const scrub = (event: TargetedPointerEvent<SVGSVGElement>) => {
    if (!pointerOnPlots.current) pointerOn(true)
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = rect.width > 0 ? WIDTH / rect.width : 1
    setProfileCursor(indexAtX((event.clientX - rect.left) * scale, distances, { x0: X0, x1: X1 }))
  }
  const x = drawn[0]!.geometry.x
  const axisLabel = (value: number | null, curve: ProfileCurve) => value === null
    ? ''
    : `${numberFormat(language, { maximumFractionDigits: 1 }).format(value)}${unitSuffix(curve.units)}`
  const plots = useMemo(() => (
    <>
      {drawn.map(({ plot, geometry }) => (
        <g key={plot.role}>
          <line className={styles.baseline} x1={X0} x2={X1} y1={plot.area.bottom} y2={plot.area.bottom} />
          <text className={styles.axisLabel} x={X0 - 6} y={plot.area.top + 9} text-anchor="end">{axisLabel(geometry.max, plot.curves[0]!.curve)}</text>
          <text className={styles.axisLabel} x={X0 - 6} y={plot.area.bottom} text-anchor="end">{axisLabel(geometry.min, plot.curves[0]!.curve)}</text>
          {plot.curves.map(({ curve, index }, position) => {
            const style = curveStyle(index)
            return (
              <path
                key={curve.id}
                className={styles.curve}
                data-curve={style.colour}
                data-dashed={style.dashed ? 'true' : undefined}
                d={geometry.paths[position]}
              />
            )
          })}
        </g>
      ))}
      {distanceTicks(profile.lengthM).map((tick) => (
        <g key={tick}>
          <line className={styles.baseline} x1={x(tick)} x2={x(tick)} y1={bottom} y2={bottom + 4} />
          <text className={styles.axisLabel} x={x(tick)} y={bottom + 17} text-anchor={tickAnchor(tick, x(tick))}>{formatLength(tick, language)}</text>
        </g>
      ))}
    </>
  ), [drawn, language])
  return (
    <>
      <svg
        className={styles.plot}
        viewBox={`0 0 ${WIDTH} ${bottom + AXIS}`}
        aria-hidden="true"
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={leave}
        onPointerCancel={leave}
      >
        {plots}
        <CursorMarks drawn={drawn} distances={distances} bottom={bottom} />
      </svg>
      <ul className={styles.legend}>
        {profile.curves.map((curve, index) => (
          <LegendLine key={curve.id} curve={curve} index={index} language={language} reading={hovering} releaseSteepest={releaseSteepest} />
        ))}
      </ul>
      {offersRetry(profile)
        ? (
            <div className={styles.failed}>
              <button ref={retryButton} type="button" className={styles.textButton} onClick={retry}>{t('siteData.chart.retry')}</button>
            </div>
          )
        : null}
    </>
  )
}

/** The first distance starts at the plot's left end; one whose centred label would pass the right edge ends there. */
function tickAnchor(tick: number, atX: number): 'start' | 'middle' | 'end' {
  if (tick === 0) return 'start'
  return atX + TICK_LABEL_HALF > WIDTH ? 'end' : 'middle'
}

/** The cursor line and one dot per curve with a value under it. */
function CursorMarks({ drawn, distances, bottom }: {
  readonly drawn: readonly DrawnPlot[]
  readonly distances: readonly number[]
  readonly bottom: number
}) {
  const cursor = profileCursor.value
  if (cursor === null) return null
  const atX = drawn[0]!.geometry.x(distances[cursor]!)
  return (
    <>
      {drawn.map(({ plot, geometry }) => plot.curves.map(({ curve, index }) => {
        const value = curve.values[cursor]
        if (value === null || value === undefined) return null
        return <circle key={curve.id} className={styles.cursorDot} data-curve={curveStyle(index).colour} cx={atX} cy={geometry.y(value)} r={3.5} />
      }))}
      <line className={styles.cursor} x1={atX} x2={atX} y1={drawn[0]!.plot.area.top} y2={bottom} />
    </>
  )
}

function LegendLine({ curve, index, language, reading: showsReading, releaseSteepest }: {
  readonly curve: ProfileCurve
  readonly index: number
  readonly language: string
  /** The pointer is on the plots: the line gives the curve's value at the cursor. */
  readonly reading: boolean
  releaseSteepest(): void
}) {
  const cursor = showsReading ? profileCursor.value : null
  const style = curveStyle(index)
  const one = numberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  let reading: JSX.Element
  if (curve.readFailed) {
    reading = <span className={styles.reading}>{t('siteData.chart.readFailed')}</span>
  } else if (cursor !== null) {
    const value = curve.values[cursor] ?? null
    reading = value === null
      ? <span className={styles.reading} aria-label={t('siteData.noData')}>—</span>
      : <span className={styles.reading}>{formatRowValue(value, curve.units, language)}</span>
  } else if (curve.stats.role === 'elevation') {
    const { rise, steepest } = curve.stats
    const signed = numberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' })
    reading = (
      <span className={styles.reading}>
        {rise === null ? null : t('siteData.chart.rise', { value: `${signed.format(rise)}${unitSuffix(curve.units)}` })}
        {rise !== null && steepest ? ' · ' : null}
        {steepest ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setProfileCursor(steepest.index)}
            onFocusOut={releaseSteepest}
          >
            {t('siteData.chart.steepest', {
              percent: numberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(steepest.percent / 100),
              run: formatLength(steepest.runM, language),
            })}
          </button>
        ) : null}
      </span>
    )
  } else {
    const { highest } = curve.stats
    reading = (
      <span className={styles.reading}>
        {highest === null ? null : t('siteData.chart.highest', { value: `${one.format(highest)}${unitSuffix(curve.units)}` })}
      </span>
    )
  }
  return (
    <li className={styles.legendLine}>
      <span className={styles.swatch} data-curve={style.colour} data-dashed={style.dashed ? 'true' : undefined} aria-hidden="true" />
      <span className={styles.name} title={curve.name}>{curve.name}</span>
      {reading}
    </li>
  )
}
