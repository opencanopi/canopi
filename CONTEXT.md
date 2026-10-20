# Canopi Design Domain

Canopi helps people create agroecological designs for permaculture, syntropic agriculture and food forests. This glossary defines the product's domain language. Every term is the name the interface uses (`desktop/web/src/i18n/en.json`; translations in the [UI glossary](docs/guides/ui-glossary.md)); the concept map at the end gives each architecture noun its one owner. Code, guides, ADRs and bd use these words.

## Designs and files

**Design**: An agroecological plan drawn on the map: plants, zones, notes, measurements, planning (Calendar, Budget, Consortium), saved views and stories. Saved as a `.canopi` file; "Design" is always capitalised. _Avoid:_ Document, file, project

**Draft**: A Design that has no `.canopi` file yet. Every new Design starts as one; Desktop keeps drafts in app data until Save as…, Web in the browser, their only home. _Avoid:_ Autosave backup, untitled file

**Home**: Where a Design Session writes: the `.canopi` file it was opened from or saved as (Desktop), or a Draft. Save as… moves it to a file; a Web download never changes it. _Avoid:_ Save location, target

**Continuous Save**: Canopi's always-on saving: changes reach the Home soon after each change, on leaving the window, before another Design replaces it and on close. The user is asked only when a write fails or the file changed outside Canopi. _Avoid:_ Autosave, save prompt

**Design Session**: The runtime context of the open Design: its state, Home, Continuous Save and the attached scene runtime. _Avoid:_ Document session

**Write lane**: The Session core's one serial write path; the target lock makes each publish one step.

**Start screen**: What the app shows when no Design Session is active: New Design, Open Design… (Web: Open a .canopi file…), Drafts and, on Desktop, Recent Designs. A Design that cannot open says why, never a path. _Avoid:_ Welcome screen, homepage

**Recent Design**: A reference to a `.canopi` file (on Web a Draft) opened or saved before, with its sketch and counts. A file that cannot open shows its name and why. _Avoid:_ Recent file, history item

**Design notebook**: The panel that lists saved Designs in user-named sections, keyed by Home on both editions (2.1). It stores references only; the file or Draft stays the authority. _Avoid:_ File browser, project folder

**Web Edition**: Canopi in a browser, aligned with Desktop except where ADR 0030 says why: the full Plant catalog, browser-local Drafts, contours, hillshading, and Site data up to a measured size limit with the terrain analyses (2.1); larger data and hydrology stay Desktop. A real editor, not a demo. _Avoid:_ Web sketch, demo app

**GeoJSON import and export**: A Design's objects as a WGS84 FeatureCollection. Import adds Design objects in one undoable step. _Avoid:_ Shapefile import

## Map and coordinates

**Map canvas**: The design surface is the map itself: basemap, satellite, terrain data, contours and hillshading are its background. There is no separate local canvas and no Design location. The view can turn; editing stays top-down. _Avoid:_ sketch, Design location

**Session plane**: The runtime's local metre plane for the open Design, centred on the objects. Files store WGS84 lon/lat; the plane converts to metres for tools, snapping, measurements and PDF layout. _Avoid:_ Anchor, spatial frame

**Background**: The choice in Layers' Map section: Satellite, Street map or None (plain paper), with its opacity and Soften background. An app setting shared by every Design. _Avoid:_ Basemap layer, Design layer

**Online elevation**: Contour lines and Hillshading, drawn from online elevation, not imported data, listed in Layers' Map section. App settings, not Design content. _Avoid:_ Map layers, Site data

**Place search**: The title-bar field (Search a place…, Ctrl K) that finds a place by name (on Enter) or by typed coordinates and moves the view there. Only the camera moves; objects never do. _Avoid:_ Location editing, geocoding

**Last view**: The map centre and zoom Canopi remembers on this device; "Where is your site?" opens a new Design north-up over it. _Avoid:_ Design location, default site

**Saved view**: A named camera position and direction kept in the Design (View › Save current view…), with the background, layers, labels and focused species it showed, and a picture. Going to a view moves only the camera. _Avoid:_ Bookmark, camera preset

**Turn the view**: Rotate the map so north is no longer up (Shift + right-drag, Shift + ← or →, the compass, two fingers). Objects keep their stored angle. _Avoid:_ Rotate the map, spin (Rotate… turns objects)

**Reset north**: Turn the view back to north up (N, Shift N, Shift + ↑, a compass click). _Avoid:_ Reset rotation, north-up mode

**Compass**: The zoom-group button whose needle points north: click to reset north, drag its ring to turn the view. _Avoid:_ North arrow (the PDF's), orientation button

**Story**: An ordered set of steps kept in the Design, each showing a saved view with a title, text and pictures. Present shows a story full-window. Presenting never changes the Design. _Avoid:_ Slideshow, tour

## Design objects

**Design object**: Anything placed on the map canvas: a placed plant, zone, text note, measurement or group. Positions are stored as longitude/latitude. _Avoid:_ Canvas object, shape, element

**Placed plant**: One instance of a species positioned in a Design. Many placed plants share a species. _Avoid:_ Species, catalog item

**Plant symbol**: The marker a placed plant draws, chosen by the designer from four families: plant form, what it gives, what it does and abstract marks. Any symbol takes any colour. Design-owned presentation, not catalog data. _Avoid:_ Custom icon, uploaded icon

**Plant label**: The code or name shown beside a placed plant. View › Labels chooses None, Codes or Names for the Design; Show name pins one plant's name. _Avoid:_ Annotation, tooltip

**Species focus**: A temporary view state that keeps one species prominent and dims the others. Saved views remember it; it changes neither selection nor content. _Avoid:_ Filter, selection

**Zone**: An area or line drawn in a Design, typed by its shape: Polygon zone, Rectangle zone, Ellipse zone or Line zone. _Avoid:_ Shape, region

**Zone display name**: A zone's name where it has one (Rename zone…), otherwise its type and size ("Rectangle zone · 120 m²"). Panels never show an internal id. _Avoid:_ Zone id, label

**Text note**: A positioned text object in a Design. _Avoid:_ Annotation, label, comment

**Measurement**: A persistent straight measuring aid with two endpoints and a derived distance, drawn with Measure. Not a boundary or row. _Avoid:_ Line zone, ruler line

**Group**: Design objects that move and transform together (Arrange › Group). Groups do not nest. _Avoid:_ Layer, selection

**Layer**: A fixed visibility and locking group of Design objects (Annotations, Plants, Measurement guides, Zones) in the Design section of Layers. Not user-created folders. _Avoid:_ Folder, category

**Lock**: A saved constraint on a Design object that stops selection, moving, deleting and copying while keeping it visible. Edit › Unlock all releases every lock as one Undo. _Avoid:_ Selection lock

**Selection chip**: The chip at the bottom of the map that names the selection ("12 plants · 3 species · 0.52 m apart") with Select all of this species, Rename… and Clear selection. _Avoid:_ Status bar, inspector

**Right-click menu**: The one context menu for objects and the empty map (a still right-click, the Menu key or Shift F10; a right-drag pans): Cut, Copy, Paste, Duplicate, Arrange, Save as stamp, Lock, Rotate… and more. _Avoid:_ Selection toolbar, action bar

**Tool card**: The card beside the tool rail that names the active tool, what to do now and its keys. _Avoid:_ Toolbar hint, status text

**Inspection lens**: A temporary magnified view of a small part of the map with plant names beside their positions. It creates no Design object. _Avoid:_ Print area, second Design

## Placing tools

**Place plants**: The tool that places one species per click, with a chooser (species in the Design, Favorites, recent, search, the catalog). _Avoid:_ Plant stamp, clone tool

**Plant a row**: The tool that repeats a species along a drawn line at an Interval, the centre-to-centre distance. _Avoid:_ Spacing tool, linear stamp

**Stamp**: A copy source for Place a stamp: an object picked on the map, or a saved stamp. Copies land unlocked and selected; the source never changes. _Avoid:_ Template, clone

**Saved stamps**: Named personal snapshots of selected objects (plants, zones, notes, guides, groups), kept outside Designs in Favorites and stamps, importable and exportable. From 2.1 they keep locks, care actions and species data. _Avoid:_ Template, Design template

## Plants and the catalog

**Plant catalog**: The searchable species database with filters, details, photos and Favorites. Guides call the subsystem the species catalog. A species enters a Design only as placed plants. _Avoid:_ Plant database, species browser

**Species**: A catalog entry describing a plant taxon, identified by its canonical name. _Avoid:_ Plant, catalog plant

**Canonical name**: The scientific name Canopi uses to identify a species; one per species. Labels and legends show it in full when a plant has no common name. _Avoid:_ Latin name, species name

**Common name**: A language-scoped everyday name. Lists show the name in the interface language; when none exists they show the English name marked "(en)". A common name never stands in for another language. _Avoid:_ Species identifier

**Species code**: A short unique code for a species within one Design (IBM Plex Mono). A Design keeps assigned codes even after the last plant of that species is removed. _Avoid:_ Species id

**Plants in this Design**: The panel listing the placed species with counts, colours, symbols and Display on the map (colour by Species, Stratum or One color; Symbol size; Outline; Labels). _Avoid:_ Species key, legend panel

**Find plants**: The Ctrl F search in every plant list (guides call it the plant finder): common names in every language, scientific names, synonyms and codes, ignoring accents, capitals and small typos. _Avoid:_ Global search

**Hardiness zone**: A USDA cold-tolerance zone of a species (min and max). _Avoid:_ Climate zone

## Planning panels

**Calendar**: The panel of actions: scheduled work (a range, one day or unscheduled) with a type, completion, description and targets. _Avoid:_ Timeline, tasks

**Budget**: The panel of unit costs per species, a currency and a CSV export. _Avoid:_ Estimate, price list

**Consortium**: A stratified, time-aware plant assembly: which species take part, in which stratum and across which succession phases. _Avoid:_ Guild, companion group

**Stratum**: A vertical layer of a consortium: Emergent, High, Mid or Low. A species without one is "No stratum yet"; stratum colours on the map follow it. _Avoid:_ Layer, height band

**Succession phase**: A time phase of a consortium: Placenta 1–3, Secondary 1–3, Climax. An entry spans a first and a last phase. _Avoid:_ Stage, action

**Target**: What a Calendar action or Budget line refers to: a species, a placed plant, a zone or the whole Design. _Avoid:_ Link, reference

## Data and analyses

**Data library**: The store (`canopi-library`, `app/data-library/`, 2.1; on Web up to a size limit) of imported terrain and height rasters (single-band GeoTIFF: ground elevation, surface elevation, height above ground), vectors and calculated results, shared by every Design; no GDAL install needed. Delete everywhere removes an item from the library and every Design. _Avoid:_ LiDAR panel, layer store

**Site data**: The panel listing the Data library items this Design shows, results nested under their source; Layers shows it as one row. Remove from Design keeps the item in the library. _Avoid:_ Data layer, terrain layer

**Analysis**: A calculation run on a Data library item with recorded parameters and history, such as Slope from ground elevation. A result knows when its source changed (Out of date, Refresh). _Avoid:_ Filter, derived layer

## PDF export

**Planting plan (PDF)**: File › Export › Planting plan (PDF)…, titled "Export to PDF": the planting plan as pages with a plant key, north arrow and scale, printed As in the Design, in Grayscale or in Black. The Design never changes. _Avoid:_ Design report, screenshot

**Map orientation**: The PDF choice North up (default) or As on screen; the north arrow always points to true north. _Avoid:_ Orientation (the paper's), rotation

**Field sheet**: A detail page added over a drawn print area (Add field sheet) or the Whole Design, with its own key. Print areas are print setup (saved, 2.1), never zones. _Avoid:_ Zone, page zone

## Support

**Problem report**: Help › Report a problem…: a summary and a diagnostic bundle the user shares by hand, never with screenshots, raw paths or keys, and with the Design only when the user opts in; Web downloads it. _Avoid:_ Bug report, telemetry

## Architecture terms: the domain concept map

Each noun has one owner, written states and a closed list of who may change it ([ADR 0024](docs/adr/0024-ownership-and-lifecycle.md)). Rows marked 2.1 are the target the foundation phases build.

| Noun | One owner | States | Who may change it |
|---|---|---|---|
| **Scene Edit** | the scene runtime (`transactions.ts`) | applied, undone | runtime transactions only; the Session core owns the one Design history and dirty (2.1). _Avoid:_ canvas mutation |
| **Design Edit** | `app/design-edit/` | applied | Design Edit updaters only: Budget, Calendar, Consortium, saved views, stories, description, extra fields. _Avoid:_ panel action |
| Design | the Design Session core | idle, opening, open, replacing, closing (2.1) | Scene Edits and Design Edits |
| Design Session, Home | one Session core (2.1); `DesignHome`: a file grant or a Draft id | as Design; save idle, pending, writing, busy, failed, refused, conflict, quota, copy_blocked (2.1) | the core only |
| Design scope | the Session core (2.1) | open, closing, closed | modules register with it; none watches the session identity |
| Draft | one Draft record per id, behind the home store | present, absent, unreadable | the Session's writes and deletes; quota, conflict: write results |
| Placed plant, Zone, Text note, Measurement, Selection | `SceneStore` | per object: present, locked | Scene Edits only |
| Highlight | the canvas | shown, hidden | panels set origins; only the canvas draws (zones too, 2.1) |
| Tool, armed source | the interaction session's tool owner | one typed record | the owner's arm command only (2.1) |
| Background, Map layer | the settings map-layer slice (2.1); the map layer store is its actions and read model, with a story's override | Satellite, Street map, None | settings writes and the presented story |
| Canvas surface, Map | the canvas host; one lifetime per map (2.1) | idle, starting, unavailable, map, releasing; map: creating to released | host; lifetime |
| Settings record | `app/settings/`, from one field table (2.1) | loading, ready (notice), degraded | `patchSettings` only |
| `.canopi`, settings record, user DB, LiDAR catalogue, `meta.json`, browser records | each store's chain (ADR 0026); `.canopi`'s in `canopi-format`, on Web in the core worker | opening, migrating, then ready, recovered, newer-read-only, refused-newer, set-aside-damaged or unavailable | that store's frozen steps |
| Data library item | the `canopi-library` repository; its kind `LibraryItemKind` (2.1) | importing, ready, failed; result current or stale | import and analysis jobs, Rename, Delete everywhere |
| Result, Display derivative | `analyses/` (a result and its generations); `display_cog.rs` (a display copy) | result: unpublished, head, superseded; display: preparing, ready, failed | jobs and display preparation |
| Site data entry display | one read model per entry in `app/data-library` | requested, ready, failed | the Site data panel and Design Edits |
| Job | the `jobs.rs` runner (2.1) | Queued, Running, Settling, Settled | the runner; users cancel through it |
| Library file (asset, original, staging) | the janitor (2.1) | claimed, unclaimed | writers claim before writing; only the janitor deletes |
| Failure | the failure catalogue in `canopi-types` and `reportFailure` ([ADR 0025](docs/adr/0025-failure-model-and-native-scheduling.md)) | one stable code | producers emit codes; only the sink records them |
| **App Command Graph** | one shell command catalog over the edition's capabilities | available, unavailable | command modules; menus, the Command palette and rails read it. _Avoid:_ menu registry |
| **Browser App Shell** | the Web edition root | n/a | the Web Edition chrome (title bar, menus, phone layout) around the shared app. _Avoid:_ website navigation |
