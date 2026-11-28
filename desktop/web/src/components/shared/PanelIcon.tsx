import type { Panel } from '../../app/shell/state'

export type PanelIconName = Panel

// Panel glyphs on the 20×20 grid: 1.6 stroke, round caps, currentColor.
const PANEL_ICON_PATHS: Record<Panel, string> = {
  canvas: 'M3 4.5h14v11H3zM3 13l4-4 3 3 2.5-2.5L17 14',
  layers: 'M10 3l7.5 4-7.5 4-7.5-4zM2.5 11l7.5 4 7.5-4',
  // Site data: topographic rings (U49 Q2).
  'site-data': 'M10 3c4 0 7 2.6 7 6.6S14 17 9.6 17 3 14.2 3 10.2 6 3 10 3zM10 6.4c2.3 0 4 1.4 4 3.5s-1.8 4-4.2 4-3.8-1.6-3.8-3.6S7.8 6.4 10 6.4zM10 9.2c.6 0 1 .4 1 1s-.4.9-1 .9-1-.4-1-.9.4-1 1-1z',
  'species-key': 'M5.5 16.5v-3M5.5 13.5c-2 0-3.2-1.3-3.2-3S3.6 7.3 5.5 7.3s3.2 1.4 3.2 3.2-1.2 3-3.2 3zM11 7.5h6.5M11 11h6.5M11 14.5h4.5',
  'plant-db': 'M8.5 14.5a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM17.5 17.5l-4.8-4.8M8.5 12V8.4M8.5 8.4c0-2 1.3-3.3 3.3-3.4 0 2-1.3 3.3-3.3 3.4zM8.5 10c-.1-1.5-1-2.4-2.6-2.4 0 1.5.9 2.4 2.6 2.4z',
  favorites: 'M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.7 5.7 16l.9-4.7L3.1 8l4.8-.6z',
  calendar: 'M4 5.5h12v11H4zM4 9h12M7.5 3.5v3M12.5 3.5v3',
  budget: 'M10 7.5c3.6 0 6.5-1 6.5-2.3S13.6 3 10 3 3.5 4 3.5 5.2 6.4 7.5 10 7.5zM3.5 5.2v3.5c0 1.3 2.9 2.3 6.5 2.3s6.5-1 6.5-2.3V5.2M3.5 8.7v3.5c0 1.3 2.9 2.3 6.5 2.3s6.5-1 6.5-2.3V8.7M3.5 12.2v3.3c0 1.3 2.9 2.3 6.5 2.3s6.5-1 6.5-2.3v-3.3',
  consortium: 'M2.5 17h15M5 17v-2.5M5 14.5c-1.2 0-2-.8-2-1.8s.8-1.9 2-1.9 2 .9 2 1.9-.8 1.8-2 1.8zM10 17v-4M10 13c-1.6 0-2.6-1.1-2.6-2.5S8.4 7.9 10 7.9s2.6 1.2 2.6 2.6S11.6 13 10 13zM15 17V11.5M15 11.5c-1.9 0-3.1-1.3-3.1-3S13.1 5.3 15 5.3s3.1 1.4 3.1 3.2-1.2 3-3.1 3z',
  'design-notebook': 'M6 3h9.5v14H6zM6 3c-.8 0-1.5.7-1.5 1.5v11c0 .8.7 1.5 1.5 1.5M3.5 6h2M3.5 9h2M3.5 12h2M9 7h4M9 10h4',
  // A frame with a play mark over a row of step dots.
  stories: 'M3 3.5h14v10H3zM8.5 6.2v4.6l3.8-2.3zM5.5 16.8h.01M10 16.8h.01M14.5 16.8h.01',
}

export function PanelIcon({ panel }: { panel: Panel }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d={PANEL_ICON_PATHS[panel]} />
    </svg>
  )
}
