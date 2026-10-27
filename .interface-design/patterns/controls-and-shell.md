# Controls and shell

Read the [design system](../system.md) and [canvas navigation](canvas-navigation.md) first. Boards: `boards/build.py`.

## Title bar and menus

- The place field searches on Enter; a waiting name's popup says "Press Enter to search". The Design name is a button that renames (F2).
- Save status is a live region: Saved, Saving… (not announced), Draft with Save as…, Couldn't save (alert) with Details… (the reason and Retry / Save as…), Changed outside Canopi (alert) with Resolve…. Web shows "Saved in this browser" and Download a copy (File only at 1100 px or less and on phones, 2.1-Q246).
- Web, while the browser may clear Drafts: "May be cleared by this browser", muted with an alert icon, never a failed write's red, opens a Details…-style popover: the reason, Download a copy and Keep my drafts (the one ask) while Drafts at launch are not yet asked; then what may happen and Download a copy.
- Menus (native on macOS): File (new, open, recent, rename, save, revert, Import terrain or height data…, Import GeoJSON…, Data library…, Export ▸, Settings…, Close, Quit), Edit (history, clipboard, Find plants, selection, species commands, Arrange ▸, Rotate…, locks, stamps), View (zoom, fit, Reset north, Turn view left/right 15°, Pan, place search, saved views, Grid/Snap, Labels ▸, Tool names, panels Ctrl 1–9, Background, Theme), Tools (each tool with its key), Help (Command palette… Ctrl Shift P, Keyboard shortcuts F1, Getting started, Report a problem…, About). Web omits Desktop-only items.
- Checkable items are `menuitemcheckbox` (Labels radio items) and reserve a check column. Plant color, Plant symbol, Species details, Add to calendar… and Set unit cost… are right-click items, not Edit. Below 760 px the menubar is one Menu button with submenus inline, holding Help, Settings and the Web file icons.

## Start and new Designs

- Start: left, the logo, one line of purpose, New Design (Ctrl N, primary) and Open Design… (Ctrl O), Settings, Keyboard shortcuts, Report a problem…. Right: Search your Designs, Recent Designs, Drafts (dashed tile; deleting confirms inline and names the draft). Web adds one line under the ways in: on a first visit, the reason before the first ask; otherwise the amber warning, naming Download a copy (each Draft row's More menu) only when a Draft is listed, plus the reason and Keep my drafts while Drafts at launch are not yet asked.
- A recent row: a sketch (72 × 52, from the file: ink zones, ochre plant dots, north up, no map or network), name, "2,201 plants · 24 zones", relative date, More (Show in folder, Remove from list, which keeps the file).
- First run (nothing recent, no Drafts): no search; an empty state says where Designs appear, with New Design.
- New Design opens "Where is your site?" over the world map: a combobox with results (coordinates only when the input reads as them), attribution, and Skip. Then "Start your Design" beside the labelled tool rail: draw a zone, open the catalog, rename and Save as….
- A Design that cannot open shows "Can’t open this Design" with the reason and never a path: a native dialog on Desktop, the shell notice on Web.

## Dialogs, notices and states

- Dialogs: body 14.5, footer actions right-aligned and wrapping, a leading ghost action aligned with the text. Modal: focus trapped, Esc closes and returns focus; nothing under the scrim takes a press, focus or key.
- Saved views: Save current view… has Name (selected, default "View n") and an optional Title. Manage views… lists each view with its thumbnail (64 × 40), Go to, Rename in place (Enter keeps, Esc cancels only the rename) and Delete.
- Notices: info, warning (amber), error (red, alert). Toasts are dark and carry Undo when it applies.
- Notices never cover controls. An app-wide notice (catalog missing or damaged, Data library refused, earlier data not opened (dismissible), a Web shell notice) takes its own row under the title bar. Web New version is its info notice with Reload (primary) and Dismiss, both off while saving; any shell notice shows over it until dismissed.
- Empty states say what goes here and give the action to start. Loading keeps the frame: inline "Searching…", row skeletons, progress bars. Errors say what happened, what is safe and the next step.

## Settings

A wide dialog with a section list on the left (`nav`, the current section `aria-current="page"`; a scrolling row under 640 px) and one section on the right under a Literata heading.

- Appearance: theme, language, tool names.
- Map and imagery: Satellite imagery as a segmented Free imagery / My Google key. The key field is masked and a saved key is never put in the page; Show reveals only what is typed; Save key, Remove key (chooses Free imagery); a note says the key stays on this device. Then Map style and Soften background.
- Canvas: Pointing device.
- New Designs: Open on satellite, symbol size (50–200 %), labels (None, Codes, Names); applied once when a Design is created.
- Keyboard: Single-key shortcuts and Show all shortcuts (closes Settings, opens F1); no remapping.
- Files and data: Desktop lists the Drafts and Data library paths with Show in folder; Web says Designs and Drafts stay in the browser.
- About: the version and About Canopi… (closes Settings, opens it).

## Export planting plan

A 280 px side sheet beside the live preview, in the order [PDF export](../../docs/guides/pdf-export.md) sets, under Back to Design. Plant colours: As in the Design, Grayscale, Black. Include ends with a "North arrow and scale" switch. Page options: Fit, zoom, orientation, Split into readable sheets, Inspect. Whole Design beside Add field sheet; key pages nest under their page.

Pages move on the preview (drag, or arrows on the focused page). No manual symbol size. The key is automatic: on the sheet when it fits, otherwise on following pages; the guide sets its content and bars maps.

## Controls

- Dropdown, never a native `<select>`; its accessible name includes the current value. DatePicker, never `<input type="date">`.
- Segmented controls are radio groups, the selected segment ink-edged. Switches are switch checkboxes. Radios are custom with a visible ring.
- Sliders show their value and carry accessible names.
- Tooltips flip or shift to stay whole. Touch screens show them only on keyboard focus (Show my location's reason also 4 s after a tap); menu rows are 44 px.

## Web on phones

- Phone sizes: [editions](../../docs/guides/editions.md). Wider windows keep the rails and dock (narrow rules from 640 to 760 px). Safe-area insets apply; inputs are 16 px.
- Top bar: 8 px from the edges, below the notch, 52 px with 44 px buttons: Menu, the Design name over its save status (action in File; the may-be-cleared warning is text, its popover opened by File › Keep my drafts… while Keep is offered), Undo, Search a place (a card over the bar; Ctrl K).
- Tool strip (left): Select, Pan, Place plants, Polygon zone (44 px), then More tools (soft accent when holding the active tool). Redo is in Edit; Grid and Snap in View.
- Zoom: a column on the right, midway down the frame; hidden without room.
- Sheet: across the bottom, at peek (bar, handle, tabs), half or full. The 44 px handle steps them (also arrows, PageUp/Down, Home, End). Tabs Layers, Plants, Catalog, More; the open tab's press rests it at peek. A new draft drops it to peek.
- Context bar: the sheet's first row; one 44 px row, never scrolling (the map notice adds a row on top). One context: the overview notice, the armed tool (not Select or Pan), the selection, the highlight chip, the labels chip, else nothing.
- Tool row: name, status, the row's check button, Options: the card's content in place of the open panel at half, closed by a tab, peek or disarming. Place plants with no species opens it.
- Landscape: the sheet rests in the bottom right corner and opens along the right edge (half 360 px, full up to 560 px); the bar is its header.
