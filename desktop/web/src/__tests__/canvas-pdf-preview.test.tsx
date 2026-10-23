// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { expect, it, vi } from 'vitest'
import { PdfPageRail } from '../components/canvas-pdf/PdfPageRail'
import { PdfPagePreview } from '../components/canvas-pdf/PdfPagePreview'
import type { PdfPage } from '../app/canvas-pdf/types'

it('emits native SVG clipping and stroke attributes so the physical drawing matches PDF', async () => {
  const container = document.createElement('div')
  const frame = { x: 20, y: 20, width: 160, height: 100 }
  const page: PdfPage = { id: 'detail', kind: 'detail', number: 2, width: 200, height: 150, frame,
    ground: { x: 0, y: 0, width: 16, height: 10 }, pointsPerMeter: 10, legend: [],
    operations: [{ kind: 'clip', bounds: frame }, { kind: 'path', d: 'M0 0 H100 V100', matrix: [10, 0, 0, 10, 20, 20],
      fill: null, stroke: '#24211c', width: .025, opacity: 1 }, { kind: 'unclip' }] }
  try {
    await act(async () => { render(<PdfPagePreview page={page} plan={{ pages: [page], angleDeg: 0, outlines: {}, blocked: null }} />, container) })
    const path = container.querySelector('path')!
    expect(path.getAttribute('stroke-width')).toBe('0.025')
    expect(path.getAttribute('stroke-linecap')).toBe('round')
    expect(path.getAttribute('stroke-linejoin')).toBe('round')
    const clipId = container.querySelector('clipPath')!.id
    expect(path.closest('[clip-path]')!.getAttribute('clip-path')).toBe(`url(#${clipId})`)
  } finally { render(null, container) }
})

it('lists a single overview followed by adjacent detail/key pairs', async () => {
  const container = document.createElement('div')
  const frame = { x: 0, y: 0, width: 100, height: 100 }
  const make = (id: string, number: number, kind: PdfPage['kind'], sourceId?: string): PdfPage => ({ id, number, kind, sourceId, detailNumber: kind === 'overview' ? undefined : 1,
    width: 100, height: 100, frame, ground: frame, pointsPerMeter: 1, legend: [], operations: [] })
  const pages = [make('overview', 1, 'overview'), make('area:a', 2, 'detail'), make('area:a:legend:0', 3, 'legend', 'area:a')]
  try {
    await act(async () => { render(<PdfPageRail plan={{ pages, angleDeg: 0, outlines: {}, blocked: null }} setup={{ paper: 'A4', layers: [], areas: [{ id: 'a', name: 'Bed', bounds: frame }] }}
      selected="overview" disabled={false} onSelect={() => {}} onRemove={() => {}} onHover={() => {}} />, container) })
    const titles = [...container.querySelectorAll('button[aria-label^="View page"]')].map(button => button.getAttribute('aria-label'))
    expect(titles).toEqual(['View page: Overview', 'View page: Bed', 'View page: 1 · Key and notes · Page 3'])
  } finally { render(null, container) }
})

it('canopi-f47t.52.228.20: the page rail opens where it is and scrolls only to a page chosen after', async () => {
  const container = document.createElement('div')
  const frame = { x: 0, y: 0, width: 100, height: 100 }
  const make = (id: string, number: number): PdfPage => ({ id, number, kind: id === 'overview' ? 'overview' : 'detail', detailNumber: id === 'overview' ? undefined : 1,
    width: 100, height: 100, frame, ground: frame, pointsPerMeter: 1, legend: [], operations: [] })
  const plan = { pages: [make('overview', 1), make('area:a', 2)], angleDeg: 0, outlines: {}, blocked: null }
  const setup = { paper: 'A4' as const, layers: [], areas: [{ id: 'a', name: 'Bed', bounds: frame }] }
  const scrolled = vi.fn()
  Element.prototype.scrollIntoView = scrolled
  const rail = (selected: string) => <PdfPageRail plan={plan} setup={setup} selected={selected} disabled={false} onSelect={() => {}} onRemove={() => {}} onHover={() => {}} />
  try {
    // Opening keeps the panel at its top, with Back to the Design in view.
    await act(async () => { render(rail('overview'), container) })
    expect(scrolled).not.toHaveBeenCalled()
    await act(async () => { render(rail('area:a'), container) })
    expect(scrolled).toHaveBeenCalledTimes(1)
  } finally {
    render(null, container)
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  }
})
