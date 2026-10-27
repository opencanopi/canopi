// canvas/runtime/tool-id.ts  (types; a leaf: no imports)
// Owner of the tool ids (tool-id-literal-only-in-rows, ADR 0018; §18 F29) until 2c moves them to the command table's tool
// rows. Invariant: ToolId is the one list; a tool id literal elsewhere goes through it.
//
// The one tool-id union. The interaction types re-export it; the canvas
// commands, the tool card's titles and the rail's icon names read it, so a new
// tool fails `tsc` until each of them names it.

export type ToolId =
  | 'select' | 'hand' | 'plant-stamp' | 'text' | 'line' | 'measurement-guide' | 'rectangle' | 'ellipse'
  | 'polygon' | 'object-stamp' | 'saved-object-stamp' | 'plant-spacing'
  | 'profile'                                                   // Desktop, from canopi-f47t.42 (U49, spec §1.10): no key, not on the rail
// 'hand' is the Pan tool (label "Pan", key H). It stays in every phase (user).
