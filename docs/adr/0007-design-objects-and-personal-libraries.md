# Design groups, symbols and saved stamps

Status: Accepted (2026-09-25, Canopi v2); amended 2026-10-17 (stamps and the Notebook on both editions, ledger 2.1-Q111, 2.1-Q112, 2.1-M49); amended 2026-10-19 (groups of any canvas object and stamps that keep planning data, 2.1 target built in Phase 2: ledger 2.1-Q154, 2.1-Q155, 2.1-Q158, 2.1-M88, 2.1-M89)

## Context

Design objects carry presentation and grouping choices that must survive editing, printing and reuse. Users also keep personal libraries (saved object stamps, the Design Notebook) that are not part of any one Design.

## Decision

- **Object groups** are flat, typed collections of any canvas design objects: plants, zones, notes and measurement guides, across their layers (2.1-Q154). Groups have no nesting and no group-level layer, position or rotation; visibility, editability, geometry and membership derive from typed members, and a group holding a locked member is never moved. Members are referenced by typed ids so plant, zone, note and guide ids cannot collide.
- **Plant symbols** are a fixed built-in set stored as ids in the Design: 29 plant symbols in three families (plant form, what it gives, what it does; [ADR 0010](0010-map-first-interface.md)) plus the abstract `round` (neutral fallback), square, triangle and cross. Unknown ids use the fallback. Symbols are user-chosen, scene-owned presentation, independent of catalog taxonomy. Native contour data feeds the picker, renderer, stamps and PDF without runtime SVG parsing or image textures.
- **Plant presentation** has one path: symbolic markers sized by the visual footprint curve and local spacing, coloured by explicit plant colour, species colour or stratum fallback, decorated by symbol. Automatic detail and the inspection lens are transient reading aids that never change the Design. Pinned plant names are persisted and win over automatic names.
- **Shaped zones keep their kind.** Rotating rectangular and elliptical zones stores an explicit orientation (degrees clockwise from true north) instead of converting them to polygons.
- **Saved object stamps** are a personal library, not part of `.canopi` Designs. Both editions keep them (2.1-Q112): Desktop in the user DB, Web in a browser record, each running the payload chain of ADR 0026; both import or export one stamp as a `.canopi` file holding only the stamp; this never goes through Design Session open/save or Recent Designs. On Web, export is a FileDelivery download and import a file input ([ADR 0030](0030-edition-parity.md)). Stamps are relative arrangements in metres; deleting one is undoable (2.1-Q158).
- **What a stamp keeps** (2.1-Q155, payload v3, 2.1-M88). Its objects with their guides, pinned names, locks, notes and species appearance, and optionally care actions (relative to placement or recurring, targeting the placed copies) and species-level planning data (unit cost, consortium stratum, colour). Placing it fills species data only where the Design has none, never overwrites, and tells the user what was added; the placement, with its planning data, is one undoable edit (2.1-M89). It never carries hidden metadata.
- **Design Notebook** is a personal library of saved Design references in one sectioned ledger with manual order, keyed by Design home on both editions (ADR 0030): on Desktop by the file path, kept native-side in the user DB, or the Draft id, the frontend receiving a grant id per session (ADR 0027); on Web by the Draft id, in a browser record (2.1-M49). Switching Designs from it uses the normal Design replacement flow; each `.canopi` file stays the authority for its content and name.

## Consequences

- Groups, symbols and stamps work identically on the map canvas and in PDF.
- Stamp and Notebook data never leak into shared Design files.
- General "display by / colour by" modes need a new decision.
