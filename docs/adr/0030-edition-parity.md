# Edition parity

Status: Accepted (2026-10-17, Canopi 2.1 target; built by the 2.1 foundation phases; ledger [2.1-Q111 to 2.1-Q117, 2.1-Q122, 2.1-Q123, 2.1-Q127 to 2.1-Q133, 2.1-M13](../decisions/2-1.md)); amended 2026-10-19 (window state: 2.1-Q144; Desktop location on Linux and Windows: 2.1-Q146); amended 2026-10-20 (hydrology on Web up to the limit: 2.1-Q175; whole-grid runs over the Web limit: 2.1-M166); amended 2026-10-22 (per-site edition-check ratchet: 2.1-M211)

## Context

In 2.0 Desktop and Web differ in 43 places; 9 have a platform reason, the rest grew because each edition was built apart. 37 feature files check the edition by a literal, a single-edition composition module or an optional prop that means "the other edition". The user decided: "It seems that it is better if web and desktop are aligned except for features that cannot be handled properly like the full database." (2.1-Q111), then that the full database goes to Web too (2.1-Q113).

## Decision

- **Aligned by default.** Desktop and Web have the same features, behaviour, wording and data rules. A difference exists only where a platform cannot do the feature properly, and it is a row of the edition-capabilities table. A behaviour difference with no row is a bug.
- **The edition-capabilities table** is data in `canopi-types`, `canopi-types/edition-capabilities.json` (guarded like the ranking corpus): capability id, the edition that lacks it, the platform reason, what the user sees instead, and the ledger id that decided it. `bindings-gen` emits the Rust `EditionCapability` enum and `generated/edition-capabilities.ts` with the ids as a literal union and each edition's set, so a misspelt capability does not compile. Each root computes its set once at startup from its edition and OS and installs it in its `EditionPorts` record (ADR 0022).
- **Gate or adapter** (2.1-M164). A gate row is named by some command, tool, keymap, analysis-registry or object-kind `requires`, and its consumers answer lacking where the set lacks it; an adapter row is a behaviour inside one port adapter, and no `requires` names it.
- **No edition checks in feature code.** Only edition roots and platform adapters may know the edition. Feature code reads a capability from the set, never an edition literal, an `isDesktop` flag or the absence of an optional prop. dependency-cruiser `edition-roots` holds imports, and ast-grep `no-edition-check` holds literals and presence branches, starting as a shrink-only ratchet of `path: count` sites in the 37 files, so a second branch in a listed file fails (2.1-M211).
- **Pending rows** (2.1-M13). An alignment decided but not yet built is a row marked pending, naming the step or release that removes it; `edition-root-parity` accepts it, pending rows only shrink, and a pending row past its step fails. Its reason is "not built yet", never a platform fact, so it can never become a permanent row.
- **Rows today** (each reason a platform fact, except the pending rows):

| Capability | Kind | Lacks it | Reason | Instead | Decided |
|---|---|---|---|---|---|
| file home, Show in folder, folders in Settings | gate | Web | a page has no file paths | Drafts, Download a copy; the welcome screen and save status show storage persistence | 2.1-Q111 (ED-01, ED-23), 2.1-Q82, 2.1-Q195 |
| Quit | gate | Web | a page cannot own the window or its tab | the browser's | 2.1-Q111 (ED-09) |
| window chrome, single instance, remembered window size and position | adapter | Web | a page cannot own the window or its tab | the browser's | 2.1-Q111 (ED-09), 2.1-Q144, 2.1-M164 |
| second copy prevention | adapter | Web | a browser cannot stop a second tab | the tab-conflict state | 2.1-Q111 (ED-10) |
| Linux trackpad pinch note | gate | Web, and Desktop off Linux | WebKitGTK sends no pinch | none needed | 2.1-Q111 (ED-26) |
| geocoder User-Agent | adapter | Web | Chromium ignores a script-set User-Agent, so it cannot be relied on in every engine | the Referer identifies Canopi (same behaviour) | 2.1-Q111 (ED-28), 2.1-Q91 |
| Save as to a chosen path (exports go through FileDelivery on both) | gate | Web | no save-to-path in every engine | Download a copy, reported as downloaded | 2.1-Q111 (ED-29), 2.1-M164 |
| app updater | gate | Web | a page is updated by its deploy | the New version: Reload notice | 2.1-Q83, 2.1-Q123 |
| jobs outliving the window | adapter | Web | no work after a tab closes | Interrupted with Run again | 2.1-Q111 (ED-39), 2.1-Q61 |
| durable storage | adapter | Web | browsers evict and cap storage | the persistence request and Download a copy, also per Draft on the welcome screen | 2.1-Q111 (ED-41), 2.1-Q82, 2.1-Q193 |
| Show my location | gate | Desktop on macOS | wry maps no geolocation permission there; on Linux and Windows the host grants it to the app origin only | none | 2.1-Q115 (ED-27), 2.1-Q146 |
| Site data over the Web size limit, or a whole-grid run whose extent with its halo is over the Web whole-grid limit | adapter | Web | quota, 4 GiB wasm memory | `over_web_limit{limit}`: "Needs Canopi Desktop" with the limit | 2.1-Q114, 2.1-M164, 2.1-M166 |
| Ctrl+N, Ctrl+W, Ctrl+1-9, Ctrl+Shift+P (keymap rows) | gate | Web | browsers reserve them | the browser-safe chords both editions share | 2.1-Q117, 2.1-Q132 |
| Saved stamp larger than the per-stamp cap | adapter | both | payload admission in `canopi-format` | `stamp_too_large{limit}`; Export stamp offered | 2.1-Q173 |
| Problem-report folder names | adapter | Web | no named app folders | `<path>` instead of `<home-dir>` and the other named folders | 2.1-M113 |
| Site data below the limit: import, display, pin, Profile, terrain analyses (pending: plan N5) | gate | Web | not built yet | "Needs Canopi Desktop" | 2.1-Q114, 2.1-Q65, 2.1-Q122 |
| saved stamps (pending: plan N2) | gate | Web | not built yet | none | 2.1-Q112; deleted at N2 |
| Design Notebook (pending: plan N2) | gate | Web | not built yet | none | 2.1-Q111 (ED-06); deleted at N2 |

- **Decided alignments.** The full catalog on both (2.1-Q113, one artifact if 2.1-E1 holds); Site data on Web up to a measured limit in the browser's private file storage, with display, pin, Profile and the terrain analyses in the library worker, in 2.1 (2.1-Q114, 2.1-Q65, 2.1-Q122); offline Web (2.1-Q116, ADR 0029); one keymap of browser-safe chords and a browser-safe palette chord, with Desktop keeping its OS-standard aliases and Ctrl+Shift+P (2.1-Q117, 2.1-Q132); stamps, the Notebook, the command palette, the problem report and the error boundary on both.
  - Hydrology on Web up to the measured Web whole-grid limit (2.1-Q175, 2.1-M166), from its release.
  - Also decided (contracts §19): launch reopens the last open Design, file or Draft, else the start screen (2.1-Q127); the title bar's Open button (2.1-Q128); the layout chosen by window size, so a narrow Desktop window gets the phone layout (2.1-Q129); Catalog and Favorites open without a Design (2.1-Q130); Recently viewed inside the Catalog, Favorites and stamps holding only the user's picks (2.1-Q131); PDF architectural scales when the unit system is US customary (2.1-Q133).

## Alternatives rejected

- **A reduced Web listed as one exception.** It is today's drift, renamed.
- **Edition props with a lint.** An optional prop that means "Desktop" is an edition check the lint cannot see.

## Consequences

- ADRs 0005, 0006, 0007 and 0012 lose their "Desktop only" and "reduced" lines except where a row above holds them.
- Adding a difference is the table row, its ledger id and the user's decision; nothing else changes.

## Checks

- `edition-root-parity` (to be created by Phase 2a): the two roots' commands, FileDelivery rows, map contributions, panels, settings slices and keymap are equal except where a capability row names the difference; an unlisted difference fails, and so do a gate row no `requires` names, an adapter row some `requires` names, a pending row past its step and a row whose Decided id is not a ledger row (`policy-tables-check`).
- `no-edition-check` (to be created by Phase 0; per-site `path: count` entries for today's sites (40 in 21 files, 2.1-M270), 0 at Phase 2's close, 2.1-M211) and `edition-roots` (to be created by Phase 0).
- Every port's contract suite runs against both editions' adapters (ADR 0028).
