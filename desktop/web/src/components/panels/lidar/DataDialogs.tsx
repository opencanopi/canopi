import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { currentDesign } from '../../../app/document-session/store'
import { addToDesign, runAnalysis } from '../../../app/lidar/actions'
import {
  acceptsAnalysis,
  defaultAnalysisSource,
  formFromProvenance,
  type AnalysisContext,
  type AnalysisForm,
} from '../../../app/analyses/model'
import { findAnalysis, registryText } from '../../../app/analyses/registry'
import { libraryItems, type LibraryItem } from '../../../app/lidar/library-items'
import { lidarLibrary, readCurrentLidarPresentation } from '../../../app/lidar/library-store'
import { referenceRows } from '../../../app/lidar/reference-tree'
import {
  closeDataDialog,
  dataDialog,
  libraryView,
  revealInSiteData,
  type DataDialog,
} from '../../../app/lidar/library-navigation'
import { locale } from '../../../app/settings/state'
import { AnalyzeDialog } from '../analyze/AnalyzeDialog'
import { DataLibraryView } from './DataLibraryView'
import { ImportDataDialog } from './ImportDataDialog'

/**
 * The Desktop data workflow's modal surfaces: the Data library sheet, and
 * Import or Analyze over it. While a dialog is open the sheet under it is
 * inert, and it returns unchanged (search, filter, scroll, selection) when the
 * dialog closes; focus goes back to what opened the dialog.
 */
export function DataDialogs() {
  const library = libraryView.value
  const dialog = dataDialog.value
  const covered = library !== null && dialog !== null
  // The sheet turns inert as the dialog mounts, and the browser drops focus from it before the dialog can read its
  // opener, so the opener is read here, while rendering, and focused again once the sheet is live.
  const opener = useRef<HTMLElement | null>(null)
  if (covered && opener.current === null && document.activeElement instanceof HTMLElement) opener.current = document.activeElement
  // When the opener is gone (the empty library's Import… once the import lists an item), the sheet's selected row, or
  // its first control, takes focus, so the keyboard and Esc stay in the sheet.
  const sheet = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (covered) return
    if (opener.current?.isConnected) opener.current.focus()
    else if (opener.current) {
      const target = sheet.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
        ?? sheet.current?.querySelector<HTMLElement>('[role="dialog"] button:not([disabled])')
      target?.focus()
    }
    opener.current = null
  }, [covered])
  return <>
    {library && (
      <div ref={sheet} inert={covered ? true : undefined} data-library-sheet="true">
        <DataLibraryView key={`library-${library.focusId ?? ''}`} focusId={library.focusId} />
      </div>
    )}
    {dialog?.kind === 'import' && <ImportDataDialog paths={dialog.paths} onClose={closeDataDialog} />}
    {dialog?.kind === 'analyze' && <AnalyzeRequest key={`${dialog.itemId ?? ''}-${dialog.from ?? ''}`} request={dialog} />}
  </>
}

/** A ready item an analysis accepts, as Analyze's Source lists it. */
function isSource(item: LibraryItem | undefined): item is LibraryItem {
  return item !== undefined && item.status === 'ready' && acceptsAnalysis(item)
}

function AnalyzeRequest({ request }: { readonly request: Extract<DataDialog, { kind: 'analyze' }> }) {
  const snapshot = lidarLibrary.value
  const items = useMemo(() => libraryItems(snapshot), [snapshot, locale.value])
  // Site data's list order, front first (the presentation itself is in drawing order).
  const design = referenceRows(readCurrentLidarPresentation())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const context = useMemo<AnalysisContext>(() => ({
    edition: 'desktop',
    results: items.filter((candidate) => candidate.role === 'Derived'),
    inDesign: new Set(design.map((entry) => entry.id)),
  }), [items, design.map((entry) => entry.id).join(',')])
  const byId = new Map(items.map((item) => [item.id, item]))
  // "Run again with changes…" analyzes the result's input again; otherwise Source lists this Design's items in list order.
  const from = request.from ? byId.get(request.from) : undefined
  const fixedInput = from?.provenance ? byId.get(from.provenance.inputs[0]?.item_id ?? '') : undefined
  const eligible = from
    ? (isSource(fixedInput) ? [fixedInput] : [])
    : design.map((entry) => byId.get(entry.id)).filter(isSource)
  // With nothing eligible, the item asked for still opens alone, so Analyze says why each analysis cannot run.
  const asked = from ? fixedInput : byId.get(request.itemId ?? '')
  const sources = eligible.length > 0 ? eligible : asked?.status === 'ready' ? [asked] : []
  const sourceId = from
    ? sources[0]?.id ?? null
    : defaultAnalysisSource(sources, design.map((entry) => ({ id: entry.id, inputId: byId.get(entry.id)?.parentId ?? null })), request.itemId)
  // The prefill is read once, when the dialog opens: the settings and outputs of the run that produced the result.
  const [prefill] = useState((): AnalysisForm | null => {
    const provenance = from?.provenance
    const entry = provenance ? findAnalysis(provenance.analysis_id) : null
    if (!provenance || !entry || !fixedInput) return null
    const outputs = items
      .filter((candidate) => candidate.provenance?.definition_id === provenance.definition_id)
      .map((candidate) => candidate.provenance!.output_key)
    return formFromProvenance(entry, provenance, outputs, fixedInput.name, registryText(entry.titleKey), locale.value)
  })
  // Nothing to analyze once the library has loaded: the request closes rather than stay open unseen, which would leave
  // the library under it inert. Before the first snapshot it waits.
  const nothingToAnalyze = sourceId === null && snapshot !== null
  useEffect(() => {
    if (nothingToAnalyze) closeDataDialog()
  }, [nothingToAnalyze])
  if (sourceId === null) return null
  return (
    <AnalyzeDialog
      sources={sources}
      sourceId={sourceId}
      sourceFixed={from !== undefined}
      context={context}
      canAddToDesign={currentDesign.value !== null}
      initialAnalysisId={request.analysisId}
      prefill={prefill}
      busy={busy}
      error={error}
      onCancel={closeDataDialog}
      onRun={(analysis) => {
        setBusy(true)
        setError(null)
        void runAnalysis(analysis)
          .then(() => closeDataDialog())
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }}
      onShowInSiteData={revealInSiteData}
      onAddExisting={(id) => {
        addToDesign('Derived', id)
        revealInSiteData(id)
      }}
    />
  )
}
