import { render } from 'preact'
import { PdfPagePreview } from '../../src/components/canvas-pdf/PdfPagePreview'
import { preparePdfJob } from '../../src/app/canvas-pdf/job'
import { pdfFontUrls } from '../../src/app/canvas-pdf/font-urls'
import type { PdfInput, PdfSetup, PdfLabels, PreparedPdf } from '../../src/app/canvas-pdf/types'
import { fixture, fixtureNames, type FixtureName } from './fixtures'

let result: PreparedPdf | null = null
let controller: AbortController | null = null
const root = document.querySelector<HTMLDivElement>('#preview')!
const reportElement = document.querySelector<HTMLPreElement>('#report')!
async function run(name: string, custom?: { input: PdfInput; setup: PdfSetup; labels: PdfLabels }) {
  controller?.abort(); render(null, root); result = null
  controller = new AbortController()
  performance.clearResourceTimings()
  const started = performance.now()
  const input = custom ?? fixture(name as FixtureName)
  result = await preparePdfJob(input, pdfFontUrls(location.href), controller.signal)
  if (!result.bytes || result.plan.blocked) throw new Error(result.plan.blocked ?? 'Missing PDF')
  const generationMs = performance.now() - started
  const content = JSON.stringify(result.plan)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const report = { fixture: name, pages: result.plan.pages.length, plants: input.input.canvas.plants.length,
    actualSizeLabel: input.labels.actualSize, bytes: result.bytes.byteLength, planBytes: new TextEncoder().encode(content).length, generationMs,
    planSha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
    userAgent: navigator.userAgent, pageSizes: result.plan.pages.map((page) => [page.width, page.height]),
    legends: result.plan.pages.map((page) => ({ number: page.number, detailNumber: page.detailNumber, annotationIds: page.annotationIds, measurementIds: page.measurementIds, kind: page.kind, sourceId: page.sourceId, id: page.id,
      links: page.links, destinations: page.destinations, identifiedPlants: page.identifiedPlants,
      names: page.legend.map((entry) => entry.name), scale: page.pointsPerMeter })),
  }
  reportElement.textContent = JSON.stringify(report, null, 2)
  showPage(0)
  return report
}
function showPage(index: number) {
  if (!result) throw new Error('Generate a sample first')
  const page = result.plan.pages[index]
  if (!page) throw new Error('Missing page')
  render(<PdfPagePreview page={page} plan={result.plan} zoom={100} />, root)
}
async function png(index: number): Promise<string> {
  showPage(index)
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const svg = root.querySelector('svg')!
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const page = result!.plan.pages[index]!
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(page.width * 1.5); canvas.height = Math.ceil(page.height * 1.5)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png').split(',')[1]!
  } finally { URL.revokeObjectURL(url) }
}
const api = { names: fixtureNames, run, showPage, png, bytes: () => Array.from(result?.bytes ?? []),
  clear() { controller?.abort(); controller = null; result = null; render(null, root); reportElement.textContent = '' } }
Object.assign(window, { pdfValidation: api })
for (const name of fixtureNames) {
  const button = document.createElement('button'); button.textContent = name
  button.onclick = () => { void run(name).catch((error) => { reportElement.textContent = String(error) }) }
  document.querySelector('#controls')!.append(button)
}
