# Canvas PDF export

Status: Accepted (2026-09-25, Canopi v2); amended 2026-10-19 (a page angle each and the print setup saved with the Design, 2.1 target built in Phase 2c; map backgrounds in a later release: ledger 2.1-Q151, 2.1-Q152, 2.1-Q157, 2.1-M90, 2.1-M94)

Amended by [ADR 0015](0015-rotating-map-and-canvas-controls.md) (2026-09-29): map orientation and rotated Print Areas.

## Context

Users print Designs for field work. Earlier report and native-snapshot PDF paths duplicated document and canvas concerns and rendered differently per platform. v2 puts every Design on a map, but printing map tiles needs its own provider, resolution and attribution work.

## Decision

- Canvas PDF is a derived, printable view of a Design on Linux, macOS, Windows and Web. One browser-compatible layout and encoder serve every edition; only saving (Desktop, through the Native Operation Executor) or downloading (Web) differs.
- PDFKit generates vectors with embedded Noto fonts; fontkit shaping produces one physical page plan for both the SVG preview and the PDF. System fonts and screenshots never determine layout.
- Users choose printable layers independently of saved visibility. Printable content: plants, pinned plant names, zones, annotations and persistent measurement guides; group members appear once. Interaction decorations are excluded.
- Layout runs in the session plane's metres ([ADR 0001](0001-geolocated-map-canvas.md)). An overview plus numbered detail pages cover user-drawn Print Areas at exact ground scale on A4 or US Letter, in a white print style independent of the app theme. Zone interiors print transparent; plant keys, species codes, dimension indexes and a 50 mm calibration bar keep sheets readable in grayscale.
- **Map orientation** ([ADR 0015](0015-rotating-map-and-canvas-controls.md), 2.1-Q151). Each page has its own angle: North up (the default), As on screen, a saved view's bearing, Turn to edge or a typed angle. A Print Area is a box in plan metres that turns about its own centre with its page; the sheets of a split turn together about the split's centre. Each page's north arrow points to true north, read from the session plane (2.1-M91).
- **One page frame.** A turned page does not thread an angle through the layout: one module turns the print snapshot by the page's −angle about its ground centre, and the existing axis-aligned layout runs on the result, so text stays level on paper and a North up page is unchanged. Page-editor moves and new Print Areas turn back by +angle. Rejected: an angle in every layout module (about ten modules, each a place to get the sign wrong).
- **The print setup is saved with the Design** (2.1-Q152, 2.1-M90): pages, Print Areas (a WGS84 centre and a ground size each), angles, paper and print options form the Document field `print_setup`, written by Design Edit; one PDF workspace session is one Undo entry. Exporting never changes Design content, history, dirty state or settings.
- **Map backgrounds come later** (2.1-Q157). Until the PDF editor release, basemap, satellite, Site data and terrain are never printed and export makes no network request (user, 2026-09-27). That release adds Site data layers (contours, slope, relief) and map backgrounds with their attribution, Google satellite only if its Map Tiles terms allow printed output, at its own design check.
- Timeline, Budget and Consortium sections and the retired Design Report and `printpdf` renderer are out of scope.

## Consequences

- Identical PDFs across editions and platforms.
- Printed sheets lack site imagery until the PDF editor release (2.1-Q157).
- Module ownership, limits and validation commands live in the Canvas PDF guide.
