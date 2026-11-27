// Tool rail and action glyphs on the 20×20 grid: 1.6 stroke, round caps, currentColor.

import type { ToolId } from '../../app/command-table'

interface IconProps {
  className?: string
}

export type ToolIconName = ToolId | 'undo' | 'redo'

const OBJECT_STAMP_PATH = 'M8 3.5h4v4l3.5 1.2V11h-11V8.7L8 7.5zM3.5 13.5h13v2.5h-13z'

const TOOL_ICON_PATHS: Record<ToolIconName, string> = {
  select: 'M5 3l10.5 6.6-4.7 1.3-2.1 4.6z',
  hand: 'M7 11V5.2a1.3 1.3 0 0 1 2.6 0V10M9.6 9.6V4a1.3 1.3 0 0 1 2.6 0v5.6M12.2 9.6V5.4a1.3 1.3 0 0 1 2.6 0V12c0 3.6-2.3 6-5.6 6-2.6 0-3.8-1.2-4.8-3.2L3 11.6a1.3 1.3 0 0 1 2.2-1.3L7 12.4',
  'plant-stamp': 'M10 17.5v-7M10 10.5C10 7 7.7 5 4 5c0 3.5 2.3 5.5 6 5.5zM10 10.5c0-3.5 2.3-5.5 6-5.5 0 3.5-2.3 5.5-6 5.5z',
  'plant-spacing': 'M2.5 16.5h15M4 16.5l1.5-1.5M4 16.5l1.5 1.5M16 16.5l-1.5-1.5M16 16.5l-1.5 1.5M5 11V8M5 8c0-1.7 1-2.8 2.6-2.8 0 1.7-1 2.8-2.6 2.8zM10 11V8M10 8c0-1.7 1-2.8 2.6-2.8 0 1.7-1 2.8-2.6 2.8zM15 11V8M15 8c0-1.7 1-2.8 2.6-2.8 0 1.7-1 2.8-2.6 2.8z',
  'object-stamp': OBJECT_STAMP_PATH,
  // A saved stamp armed from Favorites places as Place a stamp does.
  'saved-object-stamp': OBJECT_STAMP_PATH,
  polygon: 'M4 7l6-4 6 4.5-2.2 8H6.2z',
  rectangle: 'M3.5 5.5h13v9h-13z',
  ellipse: 'M17 10c0 3-3.1 5.5-7 5.5S3 13 3 10s3.1-5.5 7-5.5S17 7 17 10z',
  line: 'M4 16L16 4',
  text: 'M4.5 6V4.5h11V6M10 4.5v11M7.5 15.5h5',
  'measurement-guide': 'M3 13.5L13.5 3l3.5 3.5L6.5 17zM6.5 10l1.6 1.6M9 7.5l1.6 1.6M11.5 5l1.6 1.6',
  // A terrain section over its baseline: the Site data toolbar's Profile.
  profile: 'M2.5 16.5h15M2.5 13l3.5-4.5 3 3L12.5 5l5 7',
  undo: 'M7.5 12L3.5 8l4-4M3.5 8h8.5a4.5 4.5 0 0 1 0 9H9',
  redo: 'M12.5 12l4-4-4-4M16.5 8H8a4.5 4.5 0 0 0 0 9h3',
}

export function ToolIcon({ name, className }: IconProps & { readonly name: ToolIconName }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d={TOOL_ICON_PATHS[name]} />
    </svg>
  )
}
