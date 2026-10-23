import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createTypeScriptSourceGraph,
  discoverTypeScriptSourceGraph,
} from './support/architecture/source-facts'
import {
  collectArchitecturePolicyViolations,
  collectPolicyPathDriftViolations,
  collectUnusedExemptionViolations,
  type ArchitecturePolicy,
} from './support/architecture/policy-harness'

const TEST_SOURCE_PATTERNS = [
  'src/__tests__/**',
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
] as const

const FORBIDDEN_IMPORT_POLICIES = [
  {
    kind: 'forbid-nonliteral-dynamic-imports',
    name: 'Production imports stay statically analyzable',
    from: ['src/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
  },
  {
    kind: 'forbid-imports',
    name: 'Production code cannot import frontend test support',
    from: ['src/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: [...TEST_SOURCE_PATTERNS],
  },
  {
    kind: 'forbid-imports',
    name: 'Web entry stays outside the Desktop app graph',
    from: ['src/main.web.tsx'],
    targets: ['src/app.tsx', 'src/app/**', '@tauri-apps/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Web sources do not import the Settings Projection',
    from: ['src/web/**'],
    targets: ['src/app/settings/projection.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Web Edition sources stay free of Desktop-only capabilities',
    from: ['src/web/**'],
    targets: [
      '@tauri-apps/**',
      'src/ipc/**',
      'src/components/shared/TitleBar.tsx',
      'src/components/shared/MenuBar.tsx',
      'src/components/shared/ProblemReportDialog.tsx',
      'src/components/panels/DesignNotebookPanel.tsx',
      'src/components/panels/CanvasPanel.tsx',
      'src/components/canvas/DisplayLegend.tsx',
      'src/app/design-notebook/**',
      'src/app/document-session/actions.ts',
      'src/app/document-session/lifecycle.ts',
      'src/app/document-session/transition.ts',
      'src/app/document-session/state-machine.ts',
      'src/app/problem-report/**',
      'src/commands/registry.ts',
      'src/commands/graph/**',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Components reach native capabilities through app actions',
    from: ['src/components/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['@tauri-apps/**', 'src/ipc/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'App controllers stay leaves',
    from: ['src/app/*/controller.ts'],
    targets: ['src/app/*/controller.ts'],
  },
  {
    kind: 'forbid-imports',
    // The presentation controller writes the story overrides; the map, the runtime
    // adapter and the target overlays only read them, so they never start or end one.
    name: 'Map presentation reads story overrides, not the presentation controller',
    from: [
      'src/app/canvas-map-surface/**',
      'src/app/canvas-runtime/**',
      'src/app/panel-targets/**',
      'src/web/browser-workspace-map-contribution-adapter.ts',
    ],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['src/app/story-presentation/controller.ts', 'src/app/story-presentation/index.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'App modules do not import components',
    from: ['src/app/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['src/components/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Place Search consumes geocoding through its session owner',
    from: ['src/components/canvas/PlaceSearch.tsx'],
    targets: [
      '#geocoding-transport',
      'src/app/geocoding/transport.*.ts',
      'src/app/geocoding/place-search.ts',
      '@tauri-apps/**',
      'src/ipc/**',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Settings Projection stays platform-neutral',
    from: ['src/app/settings/projection.ts'],
    targets: ['src/ipc/settings.ts', 'src/web/browser-app-data.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Shared Canvas Runtime app composition stays capability-neutral',
    from: ['src/app/canvas-runtime/app-adapter.ts'],
    targets: [
      '@tauri-apps/**',
      'src/web/**',
      'src/ipc/**',
      'src/canvas/runtime/plant-labels.ts',
      'src/canvas/runtime/species-cache.ts',
      'src/app/saved-object-stamps/**',
      'src/app/canvas-runtime/desktop-adapter.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Browser Canvas Runtime composes capabilities instead of app policy',
    from: ['src/web/browser-canvas-runtime.ts'],
    targets: [
      'src/ipc/**',
      'src/app/canvas-settings/**',
      'src/app/settings/**',
      'src/app/contracts/document.ts',
      'src/app/document-session/**',
      'src/app/saved-object-stamps/**',
      'src/app/canvas-runtime/desktop-adapter.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Production code does not import the UI gallery',
    from: ['src/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['ui-gallery/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Browser workspace composition stays free of Desktop capabilities',
    from: ['src/web/browser-workspace-runtime.ts'],
    targets: [
      '@tauri-apps/**',
      'src/ipc/**',
      'src/app/canvas-runtime/desktop-adapter.ts',
      'src/app/canvas-map-surface/desktop-workspace-runtime.ts',
      'src/app/canvas-map-surface/desktop-workspace-map-contribution-adapter.ts',
      'src/maplibre/raster-display/**',
      'src/app/lidar/**',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Neutral shell command catalog stays platform-neutral',
    from: ['src/app/shell-commands/**'],
    targets: [
      '@tauri-apps/**',
      'src/web/**',
      'src/commands/**',
      'src/ipc/**',
      'src/platform/**',
      'src/app/document-session/**',
      'src/app/settings/**',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Browser App Shell consumes caller-ready command projections',
    from: ['src/web/BrowserAppShell.tsx'],
    targets: [
      'src/app/shell/state.ts',
      'src/app/shell-commands/**',
      'src/commands/**',
      'src/web/browser-design-session.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Browser Design Session stays independent of shell components',
    from: ['src/web/browser-design-session.ts'],
    targets: ['src/web/BrowserAppShell.tsx'],
  },
  {
    kind: 'forbid-imports',
    name: 'Web Species detail stays behind the reduced adapter',
    from: ['src/web/WebSpeciesCatalogPanel.tsx'],
    targets: ['src/components/plant-detail/**', 'src/app/plant-detail/**', 'src/ipc/species.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Shared Species detail presentation stays edition-neutral',
    from: ['src/components/species-detail/**'],
    targets: ['@tauri-apps/**', 'src/ipc/**', 'src/web/**', 'src/app/plant-detail/**', 'src/components/plant-detail/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Workflow components do not import Design IPC',
    from: ['src/components/shared/WelcomeScreen.tsx', 'src/components/panels/BudgetPanel.tsx'],
    targets: ['src/ipc/design.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas Runtime does not import app-owned Panel Target state',
    from: ['src/canvas/runtime/scene-runtime.ts', 'src/canvas/runtime/scene-runtime/effects.ts'],
    targets: ['src/app/panel-targets/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Panel Target adapters do not bypass presentation ownership',
    from: ['src/app/canvas-runtime/panel-target-adapter.ts'],
    targets: ['src/app/panel-targets/state.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'MapLibre Surface stays infrastructure-only',
    from: ['src/maplibre/surface.ts'],
    targets: [
      'src/app.tsx',
      'src/app/**',
      'src/components/**',
      'src/app/document-session/**',
      'src/app/canvas-map-surface/**',
      'src/app/panel-targets/**',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'App-facing tests use explicit Canvas Runtime surfaces',
    from: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    exceptFrom: ['src/__tests__/canvas-runtime-surfaces.test.ts'],
    targets: ['src/canvas/runtime/scene-runtime.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Live Species Catalog Workbench stays behind platform adapters',
    from: ['src/app/plant-browser/workbench.ts'],
    targets: ['src/ipc/species.ts', 'src/ipc/favorites.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Command Registry depends only on the command graph interface',
    from: ['src/commands/registry.ts'],
    targets: [
      'src/commands/graph/catalog.ts',
      'src/commands/graph/projections.ts',
      'src/commands/graph/shortcuts.ts',
      'src/app/canvas-settings/signals.ts',
      'src/app/settings/state.ts',
      'src/i18n/index.ts',
      'src/canvas/session.ts',
      'src/canvas/runtime/input/editable-target.ts',
      'src/app/shell/state.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Command consumers do not bypass the registry',
    from: [
      'src/platform/desktop.ts',
      'src/components/shared/MenuBar.tsx',
      'src/components/shared/TitleBar.tsx',
      'src/components/panels/DesktopPanelRail.tsx',
      'src/components/panels/CanvasPanel.tsx',
      'src/components/shared/CommandPalette.tsx',
      'src/app.tsx',
    ],
    targets: ['src/commands/graph/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Command consumers do not bypass their projections',
    from: ['src/app/keyboard/key-router.ts', 'src/app/keyboard/keymap.ts'],
    targets: ['src/app/document-session/actions.ts', 'src/canvas/session.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Tool Rail renders its projection without reading Canvas state',
    from: ['src/components/canvas/ToolRail.tsx'],
    targets: ['src/canvas/session.ts', 'src/canvas/plant-color-menu-state.ts', 'src/canvas/plant-symbol-menu-state.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'The right-click menu runs only its request’s scene edits',
    from: ['src/app/canvas-context-menu/**', 'src/components/canvas/CanvasContextMenu.tsx'],
    targets: ['src/canvas/session.ts', 'src/app/workspace-commands/**', 'src/commands/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Menu Bar does not own session or Canvas state',
    from: ['src/components/shared/MenuBar.tsx'],
    targets: ['src/app/document-session/store.ts', 'src/canvas/session.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Panel Rail does not own shell or settings state',
    from: ['src/components/shared/PanelRail.tsx'],
    targets: [
      'src/app/document-session/store.ts',
      'src/app/shell/state.ts',
      'src/app/settings/state.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Tool Rail does not mutate Canvas settings directly',
    from: ['src/components/canvas/ToolRail.tsx', 'src/components/canvas/ViewChip.tsx', 'src/components/canvas/ZoomControls.tsx'],
    targets: ['src/app/canvas-settings/signals.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Command Palette does not own shortcut registration',
    from: ['src/components/shared/CommandPalette.tsx'],
    targets: ['src/app/keyboard/key-router.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Web Design Template orchestration stays free of Desktop authorities',
    from: [
      'src/app/community/controller.ts',
      'src/app/community/catalog.browser.ts',
      'src/app/design-template-import/coordinator.ts',
      'src/app/design-template-import/types.ts',
      'src/app/design-template-import/workflow.browser.ts',
    ],
    targets: ['@tauri-apps/api/core', 'src/app/document-session/actions.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'World Map requests MapLibre through the MapLibre Surface',
    from: ['src/components/world-map/WorldMapSurface.tsx'],
    targets: ['maplibre-gl'],
  },
  {
    kind: 'forbid-imports',
    name: 'Production app and components do not import MapLibre directly',
    from: ['src/app/**', 'src/components/**'],
    targets: ['maplibre-gl'],
  },
  {
    kind: 'forbid-imports',
    name: 'Planning surfaces do not read Canvas or document authorities directly',
    from: [
      'src/components/panels/BudgetPanel.tsx',
      'src/components/panels/CalendarPanel.tsx',
      'src/components/panels/ConsortiumPanel.tsx',
    ],
    targets: [
      'src/canvas/session.ts',
      'src/app/document-session/store.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Budget component uses its Workbench instead of projection or export internals',
    from: ['src/components/panels/BudgetPanel.tsx'],
    targets: [
      'src/app/planning-projection/**',
      'src/app/budget/export.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Budget export stays outside Design IPC and component code',
    from: ['src/app/budget/export.ts'],
    targets: ['src/ipc/design.ts', 'src/components/canvas/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Document Session workflows do not own stores or Canvas sessions',
    from: ['src/app/document-session/workflows.ts'],
    targets: [
      '@preact/signals',
      'src/canvas/session.ts',
      'src/app/document-session/store.ts',
      'src/app/consortium/time-model.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Consortium workflow does not depend on its orchestrators',
    from: ['src/app/consortium/workflow.ts'],
    targets: [
      'src/app/document-session/lifecycle.ts',
      'src/app/document-session/state-machine.ts',
      'src/app/document-session/workflows.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Document Session lifecycle does not call Design IPC directly',
    from: ['src/app/document-session/lifecycle.ts'],
    targets: ['src/ipc/design.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Design Session replacement stays platform-neutral',
    from: ['src/app/document-session/replacement.ts'],
    targets: ['@tauri-apps/**', 'src/ipc/**', 'src/web/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Design persistence does not orchestrate workflows or Scene edits',
    from: ['src/app/document-session/persistence.ts'],
    targets: [
      'src/app/consortium/workflow.ts',
      'src/app/document-session/workflow-runner.ts',
      'src/app/document-session/workflows.ts',
      'src/canvas/runtime/scene-runtime/transactions.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas Runtime clean-state code does not import the Design Session store',
    from: [
      'src/canvas/runtime/scene-history.ts',
      'src/canvas/runtime/scene-runtime.ts',
      'src/canvas/runtime/scene-runtime/construction.ts',
    ],
    targets: ['src/app/document-session/store.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas Runtime document code does not import app document composition',
    from: ['src/canvas/runtime/scene-runtime/document.ts', 'src/canvas/runtime/scene-runtime.ts'],
    targets: ['src/app/contracts/document.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas Runtime settings stay behind the App Adapter',
    from: [
      'src/canvas/runtime/scene-runtime.ts',
      'src/canvas/runtime/scene-runtime/effects.ts',
      'src/canvas/runtime/scene-runtime/scene-sync.ts',
      'src/canvas/runtime/interaction-session.ts',
      'src/canvas/runtime/input/**',
      'src/canvas/runtime/tools/**',
    ],
    targets: ['src/app/settings/**', 'src/app/canvas-settings/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas Runtime presentation data stays behind the App Adapter',
    from: ['src/canvas/runtime/scene-runtime/construction.ts'],
    targets: ['src/canvas/runtime/plant-labels.ts', 'src/canvas/runtime/species-cache.ts'],
  },
  {
    // The role surfaces and the construction module stand alone: the runtime composes them, never the reverse.
    // Type-only edges count, so no role module types itself against the runtime.
    kind: 'forbid-imports',
    name: 'Canvas runtime role modules do not import ./scene-runtime',
    from: [
      'src/canvas/runtime/command-surface.ts',
      'src/canvas/runtime/query-surface.ts',
      'src/canvas/runtime/document-surface.ts',
      'src/canvas/runtime/scene-runtime/construction.ts',
    ],
    targets: ['src/canvas/runtime/scene-runtime.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas Runtime core stays free of app imports',
    from: ['src/canvas/runtime/**'],
    exceptFrom: ['src/canvas/runtime/**/*.test.ts'],
    targets: ['src/app.tsx', 'src/app/**'],
  },
  {
    kind: 'forbid-transitive-imports',
    name: 'Canvas Runtime translations and settings stay behind the App Adapter',
    from: ['src/canvas/runtime/**'],
    exceptFrom: ['src/canvas/runtime/**/*.test.ts'],
    targets: ['src/i18n/**', 'src/app/settings/**', 'src/app/canvas-settings/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Problem Report dialog delegates to the submission module',
    from: ['src/components/shared/ProblemReportDialog.tsx'],
    targets: [
      'src/app/problem-report/diagnostics.ts',
      'src/app/problem-report/attachments.ts',
      'src/ipc/problem-report.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Problem Report attachments observe through session transition',
    from: ['src/app/problem-report/attachments.ts'],
    targets: [
      'src/app/document-session/persistence.ts',
      'src/app/document-session/store.ts',
      'src/canvas/session.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Calendar component delegates mutations and authority reads to its Workbench',
    from: ['src/components/panels/CalendarPanel.tsx'],
    targets: [
      'src/app/design-edit/**',
      'src/app/document-session/store.ts',
      'src/canvas/session.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Canvas document hook delegates runtime and transition ownership',
    from: ['src/app/document-session/use-canvas-document-session.ts'],
    targets: [
      'src/canvas/runtime/scene-runtime.ts',
      'src/app/document-session/transition.ts',
      'src/app/document-session/persistence.ts',
      'src/app/document-session/state-machine.ts',
      'src/ipc/**',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Design Session lifecycle does not construct runtime internals',
    from: ['src/app/document-session/lifecycle.ts'],
    targets: [
      'src/canvas/runtime/scene-runtime.ts',
      'src/app/document-session/persistence.ts',
      'src/app/document-session/state-machine.ts',
    ],
  },
  {
    kind: 'forbid-imports',
    name: 'Calendar component stays behind its Workbench for edits',
    from: ['src/components/panels/CalendarPanel.tsx'],
    targets: ['src/app/design-edit/**', 'src/app/document-session/store.ts'],
  },
  {
    kind: 'forbid-imports',
    name: 'Consortium component delegates document edits to its Workbench',
    from: ['src/components/panels/ConsortiumPanel.tsx'],
    targets: ['src/app/design-edit/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'Canonical projection math and precision policy have no dependencies',
    from: ['src/canvas/projection.ts'],
    targets: ['**'],
    edgeKinds: ['static', 'dynamic', 'import-type', 'reexport'],
  },
  {
    kind: 'forbid-imports',
    name: 'Plant finder matcher stays pure over the search normalization authority',
    from: ['src/app/plant-finder/matcher.ts'],
    targets: ['**'],
    exceptTargets: ['src/utils/species-search-normalization.ts'],
    edgeKinds: ['static', 'dynamic', 'import-type', 'reexport'],
  },
] satisfies readonly ArchitecturePolicy[]

const CONFINED_IMPORTER_POLICIES = [
  {
    // docs/guides/map-workspace.md "Do not": the runtime is published only as its role surfaces, so nothing else names
    // the raw runtime to hold or cast it. Type-only edges count.
    kind: 'confine-importers',
    name: 'Only the workspace composition holds the raw scene runtime',
    targets: ['src/canvas/runtime/scene-runtime.ts'],
    allowedFrom: [
      'src/app/canvas-map-surface/workspace-runtime-composition.ts',
      'src/app/canvas-map-surface/workspace-activation.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-importers',
    name: 'Species Catalog state stays private to its Workbench',
    targets: ['src/app/plant-browser/search-session.ts'],
    allowedFrom: [
      'src/app/plant-browser/workbench.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-importers',
    name: 'Prepared Design write destinations stay in persistence adapters',
    targets: ['src/app/document-session/write-admission.ts'],
    allowedFrom: [
      'src/app/document-session/persistence.ts',
      'src/ipc/design.ts',
      'src/web/browser-design-session.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-importers',
    name: 'Persistence capture capability stays private',
    targets: ['src/app/document-session/persistence-capability.ts'],
    allowedFrom: [
      'src/app/document-session/persistence.ts',
      'src/app/document-session/store.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-importers',
    name: 'Design Edit authority capability stays private',
    targets: ['src/app/design-edit/authority-capability.ts'],
    allowedFrom: [
      'src/app/design-edit/core.ts',
      'src/app/document-session/store.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // Site data display writes normalise a kind's default to null in one place
    // (`setLidarEntryDisplay`), so a .canopi file never holds two encodings of
    // one default; nothing else reaches the Design Edit seam it wraps.
    kind: 'confine-importers',
    name: 'Site data Design Edit writes go through Site data actions',
    targets: ['src/app/design-edit/lidar.ts'],
    allowedFrom: [
      'src/app/lidar/actions.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-importers',
    name: 'Generated Species Search facts stay behind the shared normalizer',
    targets: ['src/generated/species-search-normalization.ts'],
    allowedFrom: [
      'src/utils/species-search-normalization.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
] satisfies readonly ArchitecturePolicy[]

const REQUIRED_IMPORT_POLICIES = [
  {
    kind: 'require-imports',
    name: 'Species Search consumers delegate shared normalization',
    from: [
      'src/app/plant-browser/search-session.ts',
      'src/__tests__/support/in-memory-reduced-species-catalog.ts',
      'src/web/duckdb-wasm-catalog.ts',
      'src/components/plant-db/favorite-species-presentation.ts',
    ],
    targets: ['src/utils/species-search-normalization.ts'],
  },
  {
    kind: 'require-imports',
    name: 'The interaction session builds the handle layer that shows tool handles',
    // Tools give handles as ToolHandle data, never chrome (P5; e.g. tools/select/{reshape,guide-ends}.ts); the session
    // builds the one handle layer that shows them into ToolHostDeps.chrome.
    from: ['src/canvas/runtime/interaction-session.ts'],
    targets: ['src/canvas/runtime/chrome/handle-layer.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Panel resize surfaces delegate pointer lifecycle ownership',
    from: [
      'src/components/shared/SidePanelDock.tsx',
      'src/components/panels/FavoritesPanel.tsx',
    ],
    targets: ['src/components/shared/usePointerResize.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop and Web canvas hosts retain one runtime lifecycle owner',
    from: [
      'src/app/document-session/use-canvas-document-session.ts',
      'src/web/WebCanvasWorkspace.tsx',
    ],
    targets: ['src/canvas/runtime/lifecycle-owner.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop and Web Favorites share search and detail navigation policy',
    from: [
      'src/components/panels/FavoritesPanel.tsx',
      'src/web/WebSpeciesCatalogPanel.tsx',
    ],
    targets: ['src/components/plant-db/favorite-species-presentation.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop and Web delegate workspace composition',
    from: [
      'src/components/workspace/DesktopWorkspace.tsx',
      'src/web/WebWorkspace.tsx',
    ],
    targets: ['src/components/workspace/WorkspaceComposition.tsx'],
  },
  {
    kind: 'require-imports',
    name: 'Edition shells delegate their concrete workspace adapters',
    from: ['src/app.tsx'],
    targets: ['src/components/workspace/DesktopWorkspace.tsx'],
  },
  {
    kind: 'require-imports',
    name: 'Browser shell delegates its concrete workspace adapter',
    from: ['src/web/WebApp.tsx'],
    targets: ['src/web/WebWorkspace.tsx'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop and Web entries select a compile-time platform adapter',
    from: ['src/main.tsx', 'src/main.web.tsx'],
    targets: ['#platform'],
  },
  {
    kind: 'require-imports',
    name: 'Web entry installs MapLibre styles',
    from: ['src/main.web.tsx'],
    targets: ['maplibre-gl/dist/maplibre-gl.css'],
  },
  {
    kind: 'require-imports',
    name: 'Platform bootstraps install their settings adapters',
    from: ['src/platform/browser.ts'],
    targets: ['src/platform/settings.browser.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop bootstrap installs its settings adapter',
    from: ['src/platform/desktop.ts'],
    targets: ['src/platform/settings.desktop.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Shell settings callers mutate through the shared projection',
    from: [
      'src/app/workspace-commands/capabilities.ts',
      'src/components/shared/SettingsDialog.tsx',
    ],
    targets: ['src/app/settings/projection.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Panel Target adapters consume presentation, not state',
    from: ['src/app/canvas-runtime/panel-target-adapter.ts'],
    targets: ['src/app/panel-targets/presentation.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Panel Target presentation owns its signal state',
    from: ['src/app/panel-targets/presentation.ts'],
    targets: ['src/app/panel-targets/state.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Target barrel exposes identity and map projection',
    from: ['src/target/index.ts'],
    targets: [
      'src/target/identity.ts',
      'src/target/map-projection.ts',
    ],
    edgeKinds: ['reexport'],
  },
  {
    kind: 'require-imports',
    name: 'Map overlays and Canvas Runtime consume the Target module',
    from: ['src/app/canvas-map-surface/overlays.ts', 'src/canvas/runtime/scene-runtime.ts'],
    targets: ['src/target/index.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Live Species Catalog selects a compile-time adapter',
    from: ['src/app/plant-browser/index.ts'],
    targets: ['#species-catalog-live'],
  },
  {
    kind: 'require-imports',
    name: 'Saved Object Stamp live owner constructs its Workbench',
    from: ['src/app/saved-object-stamps/index.ts'],
    targets: ['src/app/saved-object-stamps/workbench.ts'],
    edgeKinds: ['static'],
  },
  {
    kind: 'require-imports',
    name: 'Command graph composes its projections and shortcuts',
    from: ['src/commands/graph/index.ts'],
    targets: [
      'src/commands/graph/projections.ts',
      'src/commands/graph/shortcuts.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Command projections consume the catalog',
    from: ['src/commands/graph/projections.ts', 'src/commands/graph/shortcuts.ts'],
    targets: ['src/commands/graph/catalog.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Command Registry consumes the graph interface',
    from: ['src/commands/registry.ts'],
    targets: ['src/commands/graph/index.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Command consumers depend on the registry',
    from: [
      'src/platform/desktop.ts',
      'src/components/panels/DesktopPanelRail.tsx',
      'src/components/panels/CanvasPanel.tsx',
      'src/components/shared/TitleBar.tsx',
      'src/components/shared/CommandPalette.tsx',
    ],
    targets: ['src/commands/registry.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Menu Bar renders the shared workspace menu model',
    from: ['src/components/shared/MenuBar.tsx'],
    targets: ['src/app/shell-commands/menus.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Design Template controller uses the Web static-asset adapters',
    from: ['src/app/community/controller.ts'],
    targets: [
      'src/app/design-template-import/workflow.browser.ts',
      'src/app/community/catalog.browser.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Browser Design Template workflow owns browser ingestion',
    from: ['src/app/design-template-import/workflow.browser.ts'],
    targets: [
      'src/app/contracts/design-ingestion.ts',
      'src/web/browser-design-session.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'World Map uses the MapLibre Surface',
    from: ['src/components/world-map/WorldMapSurface.tsx'],
    targets: ['src/maplibre/surface.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Layer Panel consumes Canvas Layer Presentation',
    from: ['src/components/canvas/LayerPanel.tsx'],
    targets: ['src/app/canvas-layer-presentation/presentation.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Species Catalog UI consumes the public Workbench',
    from: [
      'src/components/panels/PlantDbPanel.tsx',
      'src/components/panels/FavoritesPanel.tsx',
      'src/components/plant-db/CatalogBrowser.tsx',
      'src/components/plant-db/ResultsList.tsx',
      'src/components/plant-db/FilterStrip.tsx',
      'src/components/plant-db/ActiveChips.tsx',
      'src/components/plant-db/MoreFiltersPanel.tsx',
      'src/components/plant-db/PlantRow.tsx',
    ],
    targets: ['src/app/plant-browser/index.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Catalog rows use the shared stamp source',
    from: ['src/components/plant-db/PlantRow.tsx'],
    targets: ['src/canvas/plant-stamp-source.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Budget surface uses its Workbench',
    from: ['src/components/panels/BudgetPanel.tsx'],
    targets: ['src/app/budget/workbench.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Budget Workbench consumes Planning Projection and Design Edit',
    from: ['src/app/budget/workbench.ts'],
    targets: ['src/app/planning-projection/index.ts', 'src/app/design-edit/index.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Budget export delegates compile-time delivery',
    from: ['src/app/budget/export.ts'],
    targets: ['#budget-export-platform'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop Budget export delivery owns export IPC',
    from: ['src/app/budget/platform.desktop.ts'],
    targets: ['src/ipc/export.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Planning Projection runtime reads Canvas and document query authorities',
    from: ['src/app/planning-projection/runtime.ts'],
    targets: ['src/canvas/session.ts', 'src/app/document-session/store.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Document workflows invoke the Consortium workflow',
    from: ['src/app/document-session/workflows.ts'],
    targets: ['src/app/consortium/workflow.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Consortium workflow owns Design Edit and workflow execution',
    from: ['src/app/consortium/workflow.ts'],
    targets: [
      'src/canvas/session.ts',
      'src/app/design-edit/index.ts',
      'src/app/document-session/store.ts',
      'src/app/document-session/workflow-runner.ts',
      'src/app/consortium/time-model.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Non-canvas Design writers consume Design Edit',
    from: [
      'src/app/budget/workbench.ts',
      'src/app/timeline/calendar-workbench.ts',
      'src/app/consortium/dock-workbench.ts',
      'src/app/consortium/workflow.ts',
    ],
    targets: ['src/app/design-edit/index.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Design Edit core owns the document store capability',
    from: ['src/app/design-edit/core.ts'],
    targets: ['src/app/document-session/store.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Planning workbenches consume Target presentation',
    from: [
      'src/app/budget/workbench.ts',
      'src/app/timeline/calendar-workbench.ts',
      'src/app/consortium/dock-workbench.ts',
    ],
    targets: ['src/app/panel-targets/presentation.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Canvas document hook delegates to Design Session lifecycle',
    from: ['src/app/document-session/use-canvas-document-session.ts'],
    targets: ['src/app/document-session/lifecycle.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Design Session state machine composes persistence and workflows',
    from: ['src/app/document-session/state-machine.ts'],
    targets: [
      'src/app/document-session/persistence.ts',
      'src/app/document-session/replacement.ts',
      'src/app/document-session/workflow-runner.ts',
      'src/app/document-session/workflows.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Browser Design Session composes shared persistence and replacement',
    from: ['src/web/browser-design-session.ts'],
    targets: [
      'src/app/document-session/persistence.ts',
      'src/app/document-session/replacement.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Canvas Runtime app adapter owns document and store integration',
    from: ['src/app/canvas-runtime/app-adapter.ts'],
    targets: [
      'src/canvas/runtime/app-adapter.ts',
      'src/app/document-session/store.ts',
      'src/app/contracts/document.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Edition Canvas Runtime adapters delegate shared app policy',
    from: [
      'src/app/canvas-runtime/desktop-adapter.ts',
      'src/web/browser-canvas-runtime.ts',
    ],
    targets: ['src/app/canvas-runtime/app-adapter.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop Design Session mounts the Desktop workspace composition',
    from: ['src/app/document-session/lifecycle.ts'],
    targets: ['src/app/canvas-map-surface/desktop-workspace-runtime.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Web Canvas Workspace mounts the browser workspace composition',
    from: ['src/web/WebCanvasWorkspace.tsx'],
    targets: ['src/web/browser-workspace-runtime.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Desktop workspace factory binds shared composition and Desktop capabilities',
    from: ['src/app/canvas-map-surface/desktop-workspace-runtime.ts'],
    targets: [
      'src/app/canvas-map-surface/workspace-runtime-composition.ts',
      'src/app/canvas-runtime/desktop-adapter.ts',
      'src/app/canvas-map-surface/desktop-workspace-map-contribution-adapter.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Browser workspace factory binds shared composition and browser capabilities',
    from: ['src/web/browser-workspace-runtime.ts'],
    targets: [
      'src/app/canvas-map-surface/workspace-runtime-composition.ts',
      'src/web/browser-canvas-runtime.ts',
      'src/web/browser-workspace-map-contribution-adapter.ts',
    ],
  },
  {
    kind: 'require-imports',
    name: 'Canvas Runtime construction consumes its core App Adapter contract',
    from: ['src/canvas/runtime/scene-runtime/construction.ts'],
    targets: ['src/canvas/runtime/app-adapter.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Canvas Runtime document bridge consumes its document adapter contract',
    from: ['src/canvas/runtime/scene-runtime/document.ts'],
    targets: ['src/canvas/runtime/app-adapter.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Browser Canvas Runtime uses detached presentation data',
    from: ['src/web/browser-canvas-runtime.ts'],
    targets: ['src/canvas/runtime/presentation-data.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Problem Report dialog consumes submission',
    from: ['src/components/shared/ProblemReportDialog.tsx'],
    targets: ['src/app/problem-report/submission.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Problem Report attachments observe Design Session transition',
    from: ['src/app/problem-report/attachments.ts'],
    targets: ['src/app/document-session/transition.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Design Session test state uses the real store authority',
    from: ['src/__tests__/support/design-session-state.ts'],
    targets: ['src/app/document-session/store.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Calendar panel uses its Workbench',
    from: ['src/components/panels/CalendarPanel.tsx'],
    targets: ['src/app/timeline/calendar-workbench.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Consortium component uses its Workbench',
    from: ['src/components/panels/ConsortiumPanel.tsx'],
    targets: ['src/app/consortium/dock-workbench.ts'],
  },
] satisfies readonly ArchitecturePolicy[]

const NAMED_IMPORT_POLICIES = [
  {
    kind: 'named-imports',
    name: 'Desktop command catalog composes neutral shell capabilities',
    from: ['src/commands/graph/catalog.ts'],
    target: 'src/app/shell-commands/index.ts',
    requiredNames: ['composeShellCommandCatalog'],
    allowedNames: [
      'composeShellCommandCatalog',
      'ShellCommandCatalogEntry',
      'ShellCommandIdForCapability',
      'ShellCommandState',
    ],
  },
  {
    kind: 'named-imports',
    name: 'Desktop chrome projects the neutral shell catalog',
    from: ['src/commands/graph/projections.ts'],
    target: 'src/app/shell-commands/index.ts',
    requiredNames: ['projectShellCommandCatalog'],
    allowedNames: ['projectShellCommandCatalog', 'ProjectedShellCommand'],
  },
  {
    kind: 'named-imports',
    name: 'Desktop shortcuts match the neutral shell catalog',
    from: ['src/commands/graph/shortcuts.ts'],
    target: 'src/app/keyboard/keymap.ts',
    requiredNames: ['shellKeymapRows', 'CANVAS_KEYMAP_ROWS'],
    allowedNames: ['shellKeymapRows', 'CANVAS_KEYMAP_ROWS', 'CommandSink', 'KeymapRow'],
  },
  {
    kind: 'named-imports',
    name: 'Web shell adapter composes and projects neutral commands',
    from: ['src/web/browser-shell-commands.ts'],
    target: 'src/app/shell-commands/index.ts',
    requiredNames: ['composeShellCommandCatalog', 'projectShellCommandCatalog'],
    allowedNames: [
      'composeShellCommandCatalog',
      'projectShellCommandCatalog',
      'ProjectedShellCommand',
      'ShellChromeProjection',
      'ShellCommandCatalogEntry',
      'ShellCommandIdForCapability',
      'ShellCommandState',
    ],
  },
  {
    kind: 'named-imports',
    name: 'Layer Presentation uses layer commands and Canvas queries only',
    from: ['src/app/canvas-layer-presentation/presentation.ts'],
    target: 'src/canvas/session.ts',
    requiredNames: ['getCurrentCanvasLayerCommandSurface', 'currentCanvasQuerySurface'],
    allowedNames: ['getCurrentCanvasLayerCommandSurface', 'currentCanvasQuerySurface'],
  },
  {
    kind: 'named-imports',
    name: 'Favorites controller uses Scene Edit commands only',
    from: ['src/app/favorites/controller.ts'],
    target: 'src/canvas/session.ts',
    requiredNames: ['currentCanvasSceneEditCommandSurface'],
    allowedNames: ['currentCanvasSceneEditCommandSurface'],
  },
  {
    kind: 'named-imports',
    name: 'Zoom Controls use viewport commands and Canvas queries only',
    from: ['src/components/canvas/ZoomControls.tsx'],
    target: 'src/canvas/session.ts',
    requiredNames: ['currentCanvasQuerySurface', 'currentCanvasViewportCommandSurface'],
    allowedNames: ['currentCanvasQuerySurface', 'currentCanvasViewportCommandSurface'],
  },
  {
    kind: 'named-imports',
    name: 'Plant database rows use tool commands only',
    from: ['src/components/plant-db/PlantRow.tsx'],
    target: 'src/canvas/session.ts',
    // Place arms through armCanvasTool (placeSpeciesOnMap), so the row needs no session import.
    requiredNames: [],
    allowedNames: [],
  },
  {
    kind: 'named-imports',
    name: 'Plant Color Menu uses presentation, query, and selection surfaces only',
    from: ['src/components/canvas/PlantColorMenu.tsx'],
    target: 'src/canvas/session.ts',
    requiredNames: [
      'currentCanvasPlantPresentationCommandSurface',
      'currentCanvasQuerySurface',
      'currentCanvasSelection',
    ],
    allowedNames: [
      'currentCanvasPlantPresentationCommandSurface',
      'currentCanvasQuerySurface',
      'currentCanvasSelection',
    ],
  },
  {
    kind: 'named-imports',
    name: 'Plant appearance popovers read Canvas queries and selection only',
    from: ['src/components/canvas/PlantAppearancePopovers.tsx'],
    target: 'src/canvas/session.ts',
    requiredNames: ['currentCanvasQuerySurface', 'currentCanvasSelection'],
    allowedNames: ['currentCanvasQuerySurface', 'currentCanvasSelection'],
  },
] satisfies readonly ArchitecturePolicy[]

const FORBIDDEN_EXPORT_POLICIES = [
  {
    kind: 'forbid-exports',
    name: 'Scene contracts expose only live runtime authorities',
    from: ['src/canvas/runtime/scene/types.ts'],
    names: ['SceneEntity', 'SceneState'],
  },
  {
    kind: 'forbid-exports',
    name: 'Projection exposes canonical operations instead of strategies',
    from: ['src/canvas/projection.ts'],
    names: [
      'ProjectionBackend',
      'LOCAL_MERCATOR_PROJECTION_BACKEND',
      'getActiveProjectionBackend',
    ],
  },
  {
    kind: 'forbid-exports',
    name: 'Plant Browser barrel does not expose implementation state',
    from: ['src/app/plant-browser/index.ts'],
    names: ['plantSearchSession', 'dynamicOptionsCache', 'dynamicOptionsErrors', 'dynamicOptionsPending'],
  },
  {
    kind: 'forbid-exports',
    name: 'Planning Projection does not expose Target presentation state',
    from: ['src/app/planning-projection/index.ts'],
    names: ['PlanningSelection'],
  },
  {
    kind: 'forbid-exports',
    name: 'Public Design Edit surface does not expose authority capabilities',
    from: ['src/app/design-edit/index.ts'],
    names: [
      'designEditAuthorityCapability',
      'disposeDesignEditAuthority',
    ],
  },
  {
    kind: 'forbid-exports',
    name: 'Design IPC does not expose retired write orchestration',
    from: ['src/ipc/design.ts'],
    names: ['saveDesignAs', 'saveDesign', 'saveDesignDraft', 'autosaveDesign', 'prepareRecoveryWrite'],
  },
] satisfies readonly ArchitecturePolicy[]

const SOURCE_TOMBSTONE_POLICIES = [
  {
    kind: 'source-tombstones',
    name: 'Retired frontend seams stay deleted',
    files: [
      'src/canvas/runtime/scene-interaction.ts',
      'src/canvas/runtime/interaction/saved-object-stamp-tool.ts',
      'src/canvas/runtime/interaction/overlay-ui.ts',
      'src/canvas/runtime/interaction/selection-action-toolbar.ts',
      'src/canvas/runtime/interaction/frame.ts',
      'src/app/adaptation/index.ts',
      'src/app/adaptation/controller.ts',
      'src/ipc/adaptation.ts',
      'src/components/canvas/TemplateAdaptation.tsx',
      'src/components/canvas/maplibre-loader.ts',
      'src/panel-targets.ts',
      'src/panel-target-identity.ts',
      'src/panel-target-resolution.ts',
      'src/panel-target-map-projection.ts',
      'src/canvas/runtime-mirror-state.ts',
      'src/app/document/controller.ts',
      'src/app/document/edit-transaction.ts',
      'src/app/budget/controller.ts',
      'src/app/timeline/controller.ts',
      'src/app/consortium/controller.ts',
      'src/app/planning-projection/target-presentation.ts',
      'src/app/timeline/canvas-workbench.ts',
      'src/app/timeline/interaction-workbench.ts',
      'src/app/timeline/interaction-frame.ts',
      'src/app/planning-canvas/interaction-frame.ts',
      'src/app/timeline/canvas/index.ts',
      'src/app/timeline/canvas/controller.ts',
      'src/app/timeline/canvas/geometry.ts',
      'src/app/timeline/canvas/host-model.ts',
      'src/app/timeline/canvas/interaction-frame.ts',
      'src/app/timeline/interaction.ts',
      'src/app/timeline/workbench.ts',
      'src/app/consortium/interaction.ts',
      'src/app/consortium/workbench.ts',
      'src/canvas/timeline-renderer.ts',
      'src/canvas/consortium-renderer.ts',
      'src/canvas/chart-label-color.ts',
      'src/components/canvas/BottomPanel.tsx',
      'src/components/canvas/BottomPanelLauncher.tsx',
      'src/components/canvas/BudgetTab.tsx',
      'src/components/canvas/TimelineTab.tsx',
      'src/components/canvas/InteractiveTimeline.tsx',
      'src/components/canvas/TimelinePopover.tsx',
      'src/components/canvas/ConsortiumChart.tsx',
      'src/components/canvas/useCanvasRenderer.ts',
      'src/app/timeline/editing.ts',
      'src/app/community/catalog.desktop.ts',
      'src/app/design-template-import/workflow.ts',
      'src/app/design-template-import/workflow.desktop.ts',
      'src/ipc/community.ts',
      'src/app/plant-browser/state.ts',
      'src/app/plant-browser/controller.ts',
      'src/web/browser-theme.ts',
      'src/web/browser-shell-projection.ts',
      'src/state/design.ts',
      'src/canvas/runtime/host.ts',
      'src/canvas/runtime/surfaces.ts',
      'src/canvas/timeline-math.ts',
      'src/app/canvas-runtime/host.ts',
      'src/components/canvas/MapLibreCanvasSurface.tsx',
      'src/components/canvas/maplibre-surface-controller.ts',
      'src/app/canvas-map-surface/lifecycle.ts',
      'src/app/canvas-map-surface/snapshot.ts',
      'src/app/canvas-map-surface/reconciliation.ts',
      'src/app/canvas-settings/state.ts',
      'src/app/canvas-settings/controller.ts',
      // Canopi v2 (ADR 0001): Location placement, spatial frame and
      // coordinated Design history are gone.
      'src/spatial-frame.ts',
      'src/maplibre/location-map.ts',
      'src/app/design-edit/history.ts',
      'src/app/design-edit/location.ts',
      'src/app/location/index.ts',
      'src/app/location/controller.ts',
      'src/app/location/workbench.ts',
      'src/app/location/search-controller.ts',
      'src/components/canvas/LocationTab.tsx',
      'src/components/panels/LocationPanel.tsx',
      // Canopi v2 (ADR 0004): one renderer; the Canvas2D and standalone Pixi
      // backends, renderer selection, probing and profiling are gone.
      'src/canvas/runtime/renderers/canvas2d-scene.ts',
      'src/canvas/runtime/renderers/capabilities.ts',
      'src/canvas/runtime/renderers/host.ts',
      'src/canvas/runtime/renderers/profile.ts',
      'src/canvas/runtime/renderers/types.ts',
      'src/canvas/runtime/renderers/index.ts',
      'src/canvas/canvas2d-utils.ts',
      // Canvas v2 (ADR 0016), end of 0A: MapFrame and its viewport diagnostics
      // gave way to the view transform's frame.
      'src/canvas/maplibre-camera.ts',
      // Canvas v2 0B-5 and 0D2 (ADR 0016, 0019): the view agreement probe went
      // (camera-contract.test.ts is the projection guard), and the layer stopped
      // deriving its transform from MapLibre's camera.
      'src/maplibre/view-agreement.ts',
      'src/maplibre/scene-camera-transform.ts',
      // P11, end of 0E (ADR 0016): the runtime drives its one CameraDriverHost
      // through ViewNavigation; the legacy facade, the camera module, the
      // MapLibre shim and the viewport presentation are gone.
      'src/canvas/runtime/legacy-camera-facade.ts',
      'src/canvas/runtime/camera.ts',
      'src/maplibre/workspace-camera.ts',
      'src/canvas/runtime/renderers/viewport-presentation.ts',
      // P11, phase F (spec §1.6): one key router owns the window key
      // listeners and one focus owner holds the F6 regions and the map's focus.
      'src/app/shell/focus-regions.ts',
      'src/shortcuts/manager.ts',
      'src/web/canvas-shortcuts.ts',
      // P11, phase 1 (spec §1.5): the grid and measurement guides draw in the world layers;
      // the Canvas2D scene chrome is gone.
      'src/canvas/runtime/scene-chrome.ts',
      // P11, phase 3 (A7): touch behaviour is unconditional and the drag slop
      // is a threshold; the bindings module is gone.
      'src/canvas/runtime/input/bindings.ts',
    ],
    symbols: [
      {
        from: ['src/**'],
        names: ['LOCAL_MERCATOR_PROJECTION_ID', 'viewportCenterGeo', 'viewportCornerGeoPoints'],
      },
      {
        // P11, end of 0B (ADR 0018): tools run on the ToolHost; the adapter
        // interface, its DOM pointer event and the frame's handlers are gone
        // with scene-interaction.ts and interaction/frame.ts (files above).
        from: ['src/**'],
        names: ['SceneToolAdapter', 'SceneToolPointerEvent', 'SceneInteractionFrame', 'SceneInteractionFrameHandlers'],
      },
      {
        // P11, end of 0E: the shim's origin refresh (the runtime's plane
        // effect re-origins), the planar hold tolerance and the annotation
        // screen frame went with the planar camera.
        from: ['src/**'],
        names: ['refreshOrigin', 'HOLD_NOISE_DEG', 'getAnnotationScreenFrame'],
      },
      {
        // P11, phase F: the map takes focus through the focus owner, and the
        // recogniser has one bindings constant, no frozen legacy copy.
        from: ['src/**'],
        names: ['focusMapSurface', 'LEGACY_BINDINGS'],
      },
      {
        // P11, phase 1: the overlay went with scene-chrome.ts (file above).
        from: ['src/**'],
        names: ['SceneChromeOverlay'],
      },
      {
        // P11, phases 2 and 3 (A7): every input binding has its end value, so
        // the Bindings type, its constant and phase 2's PanContext are gone.
        from: ['src/**'],
        names: ['Bindings', 'CURRENT_BINDINGS', 'PanContext'],
      },
      {
        // P11, phase 3 (A7): DomInputSourceDeps and RecogniserConfig take no
        // bindings. The name is common elsewhere (DuckDB, the import graph), so
        // the tombstone covers the input pipeline that held the field.
        from: [
          'src/canvas/runtime/input/**',
          'src/canvas/runtime/interaction-ports.ts',
          'src/canvas/runtime/interaction-session.ts',
        ],
        names: ['bindings'],
      },
    ],
  },
  {
    // P11, phase F: the free focusRegion(id) went with focus-regions.ts. The
    // focus owner's method keeps the name (spec §1.6), so the tombstone is the
    // bare call and the export, not the identifier.
    kind: 'forbid-calls',
    name: 'Retired frontend seams stay deleted: the free focusRegion is not called',
    from: ['src/**'],
    targets: ['focusRegion'],
  },
  {
    kind: 'forbid-exports',
    name: 'Retired frontend seams stay deleted: no module exports focusRegion',
    from: ['src/**'],
    names: ['focusRegion'],
  },
] satisfies readonly ArchitecturePolicy[]

const SYMBOL_OWNERSHIP_POLICIES = [
  {
    kind: 'forbid-source-symbols',
    name: 'Browser App Shell does not revive command dispatch ownership',
    from: ['src/web/BrowserAppShell.tsx'],
    names: [
      'BrowserShellCommandHandlers',
      'createBrowserShellCommandProjection',
      'runBrowserShellCommand',
      'navigateTo',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Browser Design Session does not project shell handlers',
    from: ['src/web/browser-design-session.ts'],
    names: ['BrowserShellCommandHandlers'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Desktop shortcut adapter does not revive shell command switches or aliases',
    from: ['src/commands/graph/shortcuts.ts'],
    names: [
      'panelCommandId',
      'fileShortcutCommand',
      'panelKeys',
      'FILE_SHORTCUTS',
      'PANEL_SHORTCUTS',
    ],
  },
  {
    kind: 'forbid-exports',
    name: 'Command Registry exposes projections, not raw command execution',
    from: ['src/commands/registry.ts', 'src/commands/graph/index.ts', 'src/commands/graph/projections.ts'],
    names: ['runAppCommand', 'isAppCommandDisabled', 'getAppCommand', 'commands', 'getMenuDefinitions'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Production Web catalog does not carry the in-memory test reader',
    from: ['src/web/**'],
    names: ['createInMemoryReducedSpeciesCatalogReader'],
  },
  {
    // Object highlights are drawn by the canvas, which rings a plant at its drawn size; MapLibre draws the basemap and
    // map data, never a plant ring (canopi-rg4q; the zone overlay moves to the canvas in a later bead).
    kind: 'forbid-source-symbols',
    name: 'MapLibre draws no plant highlight',
    from: ['src/maplibre/**'],
    names: ['MIN_PLANT_RING_RADIUS_PX', 'highlightedPlantIds', 'plantRingRadius'],
  },
  {
    // The Scene owns layer visibility, locks and opacity; Layers reads them from the scene snapshot and its open row
    // from open-row.ts, so no app signal mirrors them and no runtime port feeds one (canopi-f47t.42).
    kind: 'forbid-source-symbols',
    name: 'Retired active entity and Layer mirrors stay deleted',
    from: ['src/**'],
    names: [
      'activeEntityId',
      'activeLayerName',
      'setActiveLayerName',
      'layerVisibility',
      'layerLockState',
      'layerOpacity',
      'CanvasRuntimeLayerProjectionAdapter',
      'CanvasRuntimeLayerProjectionSource',
      'layerProjections',
      'syncDocumentSignals',
    ],
  },
  {
    // ADR 0004: one renderer (Pixi inside MapLibre); no selection, probing or fallback.
    kind: 'forbid-source-symbols',
    name: 'Scene rendering keeps renderer selection and fallback deleted',
    from: [
      'src/canvas/**',
      'src/maplibre/**',
      'src/app/canvas-map-surface/**',
      'src/app/document-session/**',
      'src/web/**',
    ],
    names: [
      'RendererHost',
      'RendererCapabilities',
      'detectRendererCapabilities',
      'createCanvas2DSceneRenderer',
      'createPixiSceneRenderer',
      'renderCanvas2DSceneSnapshot',
      'instrumentSceneRenderer',
      'reportRendererFailure',
      'failActiveLayer',
      'failActiveBackend',
      'RendererBackendPriority',
      'RendererBackendProbe',
      // The renderer seam is one target slot on the render scheduler (ADR 0019, U33 P12 and P9).
      'SceneRendererDefinition',
      'SceneChangeSet',
      'MapLibreSceneRendererBridge',
      'setSelectionPreview',
      'SceneRendererMountCancelledError',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Projection source does not revive retired strategy symbols',
    from: ['src/canvas/projection.ts'],
    names: [
      'ProjectionBackend',
      'LOCAL_MERCATOR_PROJECTION_BACKEND',
      'getActiveProjectionBackend',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Plant Browser public barrel does not mention private state symbols',
    from: ['src/app/plant-browser/index.ts'],
    names: ['plantSearchSession', 'dynamicOptionsCache', 'dynamicOptionsErrors', 'dynamicOptionsPending'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Saved Object Stamp factory does not own the live Workbench',
    from: ['src/app/saved-object-stamps/workbench.ts'],
    names: ['savedObjectStampWorkbench'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Planning Projection public barrel does not mention private Target state',
    from: ['src/app/planning-projection/index.ts'],
    names: ['PlanningSelection'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Design Edit public barrel does not mention authority capabilities',
    from: ['src/app/design-edit/index.ts'],
    names: [
      'designEditAuthorityCapability',
      'disposeDesignEditAuthority',
    ],
  },
  {
    // A popover's Esc layer goes through usePopoverEscapeLayer, which registers it as the popover commits, so it is live
    // on the first painted frame (canopi-f47t.52.228.20). The compass registers its own for a press, from the press.
    kind: 'confine-symbols',
    name: 'Components register a popover Esc layer through usePopoverEscapeLayer',
    from: ['src/components/**'],
    names: ['registerEscapeLayer'],
    allowedFrom: ['src/components/canvas/Compass.tsx', ...TEST_SOURCE_PATTERNS],
  },
  {
    kind: 'confine-symbols',
    name: 'Raw Design persistence capture stays in persistence',
    from: ['src/app/**', 'src/components/**', 'src/ipc/**', 'src/web/**'],
    names: ['captureForPersistence'],
    allowedFrom: ['src/app/document-session/persistence.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    kind: 'confine-symbols',
    name: 'Design persistence capability stays with its owner and adapter',
    from: ['src/**'],
    names: ['captureDesignSessionPersistenceState'],
    allowedFrom: [
      'src/app/document-session/persistence-capability.ts',
      'src/app/document-session/persistence.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-symbols',
    name: 'Design persistence capability registration stays in the store',
    from: ['src/**'],
    names: ['registerDesignSessionPersistenceCapability'],
    allowedFrom: [
      'src/app/document-session/persistence-capability.ts',
      'src/app/document-session/store.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-symbols',
    name: 'Design Edit authority disposal stays in the capability owner',
    from: ['src/**'],
    names: ['disposeDesignEditAuthority'],
    allowedFrom: [
      'src/app/design-edit/authority-capability.ts',
      'src/app/design-edit/core.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'confine-symbols',
    name: 'Design Edit authority registration stays in the document store',
    from: ['src/**'],
    names: ['registerDesignEditAuthorityCapability'],
    allowedFrom: [
      'src/app/design-edit/authority-capability.ts',
      'src/app/document-session/store.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Retired Design mutation escape hatches stay absent',
    from: ['src/app/**', 'src/canvas/**', 'src/components/**', 'src/ipc/**', 'src/web/**'],
    names: ['DocumentMutationOptions', 'markDesignEdited', 'committedDesign'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Canvas lock authority is not mirrored as an ID collection',
    from: ['src/canvas/**'],
    names: ['lockedObjectIds'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Planning surfaces delegate document listener ownership to their frame',
    from: [
      'src/app/timeline/calendar-workbench.ts',
      'src/app/consortium/dock-workbench.ts',
      'src/components/panels/CalendarPanel.tsx',
      'src/components/panels/ConsortiumPanel.tsx',
    ],
    names: ['addEventListener', 'removeEventListener'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Web Edition keeps Desktop-only products out of browser code',
    from: ['src/web/**'],
    names: ['saveAs', 'geocode', 'WebLocation', 'DesignNotebook', 'ProblemReport'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Web App does not own settings persistence',
    from: ['src/web/WebApp.tsx'],
    names: ['loadSettings', 'saveSettings', 'onSettingsChange'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Scene Runtime keeps retired signal-backed writes deleted',
    from: [
      'src/canvas/runtime/scene-runtime.ts',
      'src/canvas/runtime/scene-runtime/effects.ts',
      'src/canvas/runtime/scene-runtime/document.ts',
    ],
    names: ['applySignalBackedSceneState'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Scene document bridge does not publish revision ownership',
    from: ['src/canvas/runtime/scene-runtime/document.ts'],
    names: ['incrementSceneRevision', 'sceneEntityRevision'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Design Template controller does not acquire assets directly',
    from: ['src/app/community/controller.ts'],
    names: ['acquireDesignTemplate', 'downloadTemplate'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Design Template adapters keep retired path and raw-text handoff deleted',
    from: [
      'src/app/design-template-import/workflow.browser.ts',
      'src/app/document-session/actions.ts',
      'src/app/document-session/transition.ts',
      'src/web/browser-design-session.ts',
    ],
    names: ['downloadTemplate', 'BrowserTemplateCanopiFile'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Browser template workflow keeps retired adaptation out',
    from: ['src/app/design-template-import/workflow.browser.ts'],
    names: ['TemplateAdaptation'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'World Map delegates map construction and observation to infrastructure',
    from: ['src/components/world-map/WorldMapSurface.tsx'],
    names: ['createMapLibreBasemapStyle', 'ResizeObserver'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'App presentation does not construct basemap styles',
    from: ['src/app/**', 'src/components/**'],
    names: ['createMapLibreBasemapStyle'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Design Session adapters do not call the state machine directly',
    from: [
      'src/app/document-session/use-canvas-document-session.ts',
      'src/app/document-session/lifecycle.ts',
      'src/app/document-session/actions.ts',
    ],
    names: ['transitionDocument', 'buildPersistedDesignSessionContent'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Design Session state machine keeps retired settlement APIs deleted',
    from: ['src/app/document-session/state-machine.ts'],
    names: [
      'buildPersistedDesignSessionContent',
      'applyDocumentTransition',
      'markSaved',
      'replaceCurrentDesignState',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Browser Design Session uses shared replacement and persistence',
    from: ['src/web/browser-design-session.ts'],
    names: [
      'buildPersistedDesignSessionContent',
      'settleWrittenDesignOperation',
      'markSaved',
      'replaceCurrentDesignState',
      'normalizeLoadedDocument',
      'normalizeNewDocument',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Design persistence keeps retired write-operation APIs deleted',
    from: ['src/app/document-session/persistence.ts'],
    names: [
      'SceneEditBusyError',
      'DesignPersistenceWriteOperation',
      'settleWrittenDesignOperation',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Web Canvas Workspace delegates document replacement',
    from: ['src/web/WebCanvasWorkspace.tsx'],
    names: ['syncCanvasDocument', 'loadDocument', 'replaceDocument', 'useSignalEffect'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Shared Canvas Runtime app composition does not construct edition capabilities',
    from: ['src/app/canvas-runtime/app-adapter.ts'],
    names: [
      'CanvasPlantLabelResolver',
      'CanvasSpeciesCache',
      'savedObjectStampWorkbench',
      'createDetachedCanvasPlantLabelSource',
      'createDetachedCanvasSpeciesPresentationCache',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Public Design Session store keeps mutation capabilities private',
    from: ['src/app/document-session/store.ts'],
    names: [
      'capturePersistence',
      'mutateCurrentDesign',
      'reconcileCurrentDesign',
      'markDocumentDirty',
      'updateDesignArray',
      'syncExternallyInstalledDesign',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Timeline component delegates edit and form behavior',
    from: ['src/components/panels/CalendarPanel.tsx'],
    names: [
      'beginDocumentArrayEdit',
      'createCalendarActionFromFormData',
      'calendarActionPatchFromFormData',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Consortium component delegates document edits',
    from: ['src/components/panels/ConsortiumPanel.tsx'],
    names: [
      'beginDocumentArrayEdit',
      'moveConsortiumEntryInArray',
      'reorderConsortiumEntryInArray',
    ],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Consortium Workbench delegates hover ownership to Target Presentation',
    from: ['src/app/consortium/dock-workbench.ts'],
    names: ['setHoveredSpecies'],
  },
  {
    kind: 'forbid-source-symbols',
    name: 'Browser Canvas Runtime does not rebuild shared app policy',
    from: ['src/web/browser-canvas-runtime.ts'],
    names: [
      'mutateSettingsProjection',
      'syncFromLayers',
      'syncLayer',
      'setCanvasClean',
      'composeDocumentForSave',
    ],
  },
  {
    kind: 'forbid-writes',
    name: 'Design mutation dirty-state bypass stays retired',
    from: ['src/app/**', 'src/canvas/**', 'src/components/**', 'src/ipc/**', 'src/web/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    properties: ['markDirty'],
    values: ['false'],
  },
  {
    kind: 'forbid-calls',
    name: 'App-facing tests use public Canvas Runtime surfaces',
    from: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    properties: ['getSceneStore'],
  },
  {
    kind: 'forbid-calls',
    name: 'App-facing tests do not call an unbound Scene Store escape hatch',
    from: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    targets: ['getSceneStore'],
  },
  {
    kind: 'confine-symbols',
    name: 'Production code cannot acquire the Design Session test fixture',
    from: ['src/**'],
    names: ['createDesignSessionStoreTestFixture'],
    allowedFrom: ['src/app/document-session/store.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    kind: 'forbid-calls',
    name: 'App presentation does not construct MapLibre classes directly',
    from: ['src/app/**', 'src/components/**'],
    targets: ['maplibre.**', 'maplibregl.**'],
    callKinds: ['new'],
  },
  {
    // ADR 0004: a map is admitted on its first style.load and a later one is ignored, so nothing may reload a style;
    // Basemap, Satellite, terrain and LiDAR install through sources and layers (docs/guides/map-workspace.md).
    kind: 'forbid-calls',
    name: 'Production never reloads a map style',
    from: ['src/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    properties: ['setStyle'],
  },
  {
    kind: 'forbid-calls',
    name: 'World Map delegates resize observation to the MapLibre Surface',
    from: ['src/components/world-map/WorldMapSurface.tsx'],
    targets: ['ResizeObserver'],
    callKinds: ['new'],
  },
] satisfies readonly ArchitecturePolicy[]

/**
 * Callee text of a call on a MapLibre map (`map.x`, `this.map!.x`, `map?.x`, `workspaceMap.x`), for the names that other
 * objects also carry (P1's second rule and P2). The first four are the plain receivers; `*Map!.*` and `*Map?.*` give a
 * `…Map` receiver the same non-null and optional forms.
 */
const MAP_RECEIVER_TARGETS = ['*map.*', '*map!.*', '*map?.*', '*Map.*', '*Map!.*', '*Map?.*'] as const

/** The World map's components drive their own north-up map without a camera driver, so P1 exempts them. */
const WORLD_MAP_SOURCES = ['src/components/world-map/**'] as const

/** P5's and P5c's scope: every tool module. */
const TOOLS_SOURCES = 'src/canvas/runtime/tools/**'

/** The DOM event, element and camera names P5 confines to the tool host. */
const P5_DOM_AND_CAMERA_NAMES = [
  'document', 'window', 'HTMLElement', 'PointerEvent', 'KeyboardEvent', 'clientX', 'addEventListener',
  'getBoundingClientRect', 'requestAnimationFrame', 'ViewTransform', 'CameraDriver', 'ViewNavigation',
] as const

/** The tools' own seams, which P5 exempts: the host and the scene index. */
const TOOL_SEAM_SOURCES = [
  'src/canvas/runtime/tools/tool-host.ts',
  'src/canvas/runtime/tools/spatial-index.ts',
] as const

/** P2: screen positions come from the view transform (`view/camera-contract.test.ts` guards it against MapLibre). */
const P2_PROJECTION_POLICY = {
  kind: 'forbid-calls',
  name: 'P2 nobody projects through MapLibre',
  from: ['src/**'],
  exceptFrom: [...TEST_SOURCE_PATTERNS],
  targets: [...MAP_RECEIVER_TARGETS],
  properties: ['project', 'unproject'],
} satisfies ArchitecturePolicy

/** The signals the Settings Projection hydrates and persists (app/settings/projection.ts applyDraftToProjection). */
const SETTINGS_PROJECTION_SIGNALS = [
  'locale',
  'theme',
  'googleMapsApiKey',
  'satelliteSource',
  'snapToGridEnabled',
  'plantSpacingIntervalM',
  'lastView',
  'sidePanelWidth',
  'savedStampsFrameHeight',
  'mapLayers',
  'usedCanvasTools',
  'toolNamesVisible',
  'singleKeyShortcuts',
  'scrollWheel',
  'newDesignDefaults',
] as const

/**
 * Writing a canvas policy. A rule's name starts with its P-id and a space (canvasV2Policies filters on it); a P-id
 * with several rules gives each its own name. A new rule takes the id after the highest in use
 * here, in canvas-boundaries.test.ts and in the Rust policies desktop/src/module_layering.rs (P50) and
 * ci_lane_policy.rs (P51). Its comment names the failure the rule prevents, and no doc restates it. Each rule gets a
 * planted negative test in this file; each regex rule gets one planted file in canvas-boundaries.test.ts.
 * forbid-source-symbols has no exceptFrom, so a symbol rule with exemptions is a confine-symbols. Both match every
 * identifier, property names included, so names must be distinctive. forbid-calls matches targets against the full
 * callee text and records a property only on member calls, so a bare call needs confine-symbols. A rule lands with the
 * files it names (the drift check fails otherwise). Every allowlist entry says why it stays and, if it is temporary,
 * which bead removes it.
 */
const CANVAS_V2_POLICIES = [
  {
    kind: 'forbid-calls',
    name: 'P1 only the camera driver calls MapLibre camera methods',
    from: ['src/**'],
    exceptFrom: ['src/maplibre/camera-driver.ts', ...WORLD_MAP_SOURCES, ...TEST_SOURCE_PATTERNS],
    properties: [
      'jumpTo', 'easeTo', 'flyTo', 'panTo', 'rotateTo', 'setBearing', 'setPitch', 'snapToNorth', 'resetNorthPitch',
      'fitScreenCoordinates', 'fitBounds', 'zoomTo', 'setCenter',
      'setMaxBounds', 'setMinZoom', 'setMaxZoom', 'setPadding',
    ],
  },
  {
    // zoomIn, zoomOut and resetNorth are also ViewCommandSurface methods, so this rule matches map receivers only.
    kind: 'forbid-calls',
    name: 'P1 only the camera driver stops, pans, zooms, resizes or resets north a map',
    from: ['src/**'],
    exceptFrom: ['src/maplibre/camera-driver.ts', ...WORLD_MAP_SOURCES, ...TEST_SOURCE_PATTERNS],
    targets: [...MAP_RECEIVER_TARGETS],
    properties: ['stop', 'panBy', 'setZoom', 'zoomIn', 'zoomOut', 'resize', 'resetNorth'],
  },
  {
    // Fails closed: if the driver moves or stops typing its map, the two rules above no longer name the camera's owner.
    kind: 'require-imports',
    name: 'P1 the camera driver imports the MapLibre map type',
    from: ['src/maplibre/camera-driver.ts'],
    targets: ['src/maplibre/loader.ts'],
  },
  P2_PROJECTION_POLICY,
  {
    // Tests included: the legacy camera, its snapshots and the planar camera maths stay deleted (0E).
    kind: 'forbid-source-symbols',
    name: 'P3 the legacy camera, its viewport snapshots and the planar camera maths stay deleted',
    from: ['src/**'],
    names: [
      'SceneViewportState', 'deriveSharedMapSceneViewport', 'createMapFrame', 'viewportCenterWorld', 'CameraController',
      'reprojectPlaneViewport', 'recordResolvedMinimum', 'WorkspaceCameraFrameReader', 'CameraViewportSnapshot',
      'WorkspaceCameraNavigation', 'WorkspaceCameraOwner', 'MapLibreWorkspaceCameraOwner', 'MapLibreWorkspaceCameraMap',
      'geographicViewOf', 'legacyCamera', 'fitCameraViewport', 'cameraFramingRect',
      'buildViewTransformFromPlane', 'viewCameraToPlanar',
      'reprojectPlanar', 'panPlanar', 'zoomPlanarToScale', 'rotatePlanarAround', 'planarCentredOn',
    ],
  },
  {
    // World-to-screen is a ViewTransform method (view/view-transform.ts builds it); no module exports a free one.
    kind: 'forbid-exports',
    name: 'P3 no module exports a free worldToScreen or screenToWorld',
    from: ['src/**'],
    names: ['worldToScreen', 'screenToWorld'],
  },
  {
    // Both camera drivers build their frames through view/driver-frame.ts; the lens builds its own transform from a camera at
    // its centre; test support builds one for a test view.
    kind: 'confine-symbols',
    name: 'P3 only the view module and the lens build a view transform',
    from: ['src/**'],
    names: ['buildViewTransform'],
    allowedFrom: [
      'src/canvas/runtime/view/**',
      'src/canvas/runtime/inspection-lens.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // view/ reaches no DOM module, MapLibre, Pixi or scene barrel: outside its own files it imports the pure canvas
    // modules and signals, and scene/types.ts type-only (ScenePersistedState, ScenePlantEntity). Its one timer is
    // frame-source.ts's settle setTimeout (tests use Vitest fake timers), so P4 has no symbol rule.
    kind: 'forbid-imports',
    name: 'P4 the view module imports only its pure dependencies',
    from: ['src/canvas/runtime/view/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['**'],
    exceptTargets: [
      'src/canvas/runtime/view/**',
      'src/canvas/projection.ts',
      'src/canvas/session-plane.ts',
      'src/canvas/workspace-camera-policy.ts',
      '@preact/signals',
    ],
    allowTypeOnlyTargets: ['src/canvas/runtime/scene/types.ts'],
  },
  {
    // A tool reads the shared vocabulary from interaction-types.ts (type-only imports), never interaction-ports.ts;
    // the host and the scene index are the tools' own seams (ADR 0018).
    kind: 'forbid-imports',
    name: 'P5 tools import no MapLibre, DOM or Pixi',
    from: [TOOLS_SOURCES],
    exceptFrom: [...TOOL_SEAM_SOURCES, ...TEST_SOURCE_PATTERNS],
    targets: [
      'maplibre-gl', 'pixi.js', '@preact/signals',
      'src/maplibre/**', 'src/app/**', 'src/components/**',
      'src/canvas/runtime/view/**', 'src/canvas/runtime/input/**', 'src/canvas/runtime/renderers/**',
      'src/canvas/runtime/chrome/**', 'src/canvas/runtime/interaction-ports.ts',
    ],
    allowTypeOnlyTargets: ['src/canvas/runtime/view/types.ts'],
  },
  {
    // Only the host converts screen to world: a tool, and the point editor and path engine the tools share (U58), name
    // no DOM event, element or camera. Globals need no import, so the import rules cannot see them.
    kind: 'confine-symbols',
    name: 'P5 tools name no DOM event, element or camera',
    from: [TOOLS_SOURCES, 'src/canvas/point-editor/**', 'src/canvas/plant-path/**'],
    names: [...P5_DOM_AND_CAMERA_NAMES],
    allowedFrom: ['src/canvas/runtime/tools/tool-host.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    // Walks type-only edges too, so a helper's type import cannot carry MapLibre or Pixi into a tool; no exemption.
    kind: 'forbid-transitive-imports',
    name: 'P5c tools reach no MapLibre or Pixi through other modules',
    from: [TOOLS_SOURCES],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['maplibre-gl', 'pixi.js', 'src/maplibre/**'],
  },
  {
    kind: 'confine-symbols',
    name: 'P6 only the DOM input source captures the pointer',
    from: ['src/canvas/**'],
    names: ['setPointerCapture', 'releasePointerCapture'],
    allowedFrom: ['src/canvas/runtime/input/dom-input-source.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    // The chrome files listen on their own elements only (canvas-boundaries.test.ts forbids their host and container
    // listeners); the lens listens to document.fonts.
    kind: 'confine-symbols',
    name: 'P6 only the DOM input source adds canvas listeners',
    from: ['src/canvas/**'],
    names: ['addEventListener'],
    allowedFrom: [
      'src/canvas/runtime/input/dom-input-source.ts',
      // The copied GeoLibre guard the DOM source installs on the map host (phase F).
      'src/canvas/runtime/input/selection-drag-guard.ts',
      'src/canvas/runtime/chrome/text-entry-host.ts',
      'src/canvas/runtime/chrome/handle-layer.ts',
      'src/canvas/runtime/inspection-lens.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // MapLibre's own events go through map.on; the listeners here are abort signals of snapshot and tile requests.
    kind: 'confine-symbols',
    name: 'P6 MapLibre modules add listeners only to abort signals',
    from: ['src/maplibre/**'],
    names: ['addEventListener'],
    allowedFrom: [
      'src/maplibre/view-snapshot-map.ts',
      'src/maplibre/satellite-provider-session.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // normalise and recognise run without a browser: time and platform are inputs.
    kind: 'confine-symbols',
    name: 'P7 the input core reaches no browser global or DOM event',
    from: ['src/canvas/runtime/input/**'],
    names: ['window', 'document', 'Date', 'performance', 'setTimeout', 'navigator', 'PointerEvent', 'WheelEvent'],
    allowedFrom: ['src/canvas/runtime/input/dom-input-source.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    // Per-frame view data stays in the runtime and the map layer; the overview pin's ViewReadSurface.designPin is the
    // one per-frame read components get (spec §1.1).
    kind: 'confine-symbols',
    name: 'P10 only the runtime and the map layer read per-frame view signals',
    from: ['src/**'],
    names: ['viewFrame', 'settledViewFrame', 'onViewFrame'],
    allowedFrom: ['src/canvas/runtime/**', 'src/maplibre/**', ...TEST_SOURCE_PATTERNS],
  },
  {
    // Type-only: the read surface and view types, and the driver host types the composition and the activation wire
    // (spec §1.1a); no value import, so no app module can build a camera.
    kind: 'forbid-imports',
    name: 'P10 the app, components and Web import view types only',
    from: ['src/app/**', 'src/components/**', 'src/web/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['src/canvas/runtime/view/**'],
    allowTypeOnlyTargets: [
      'src/canvas/runtime/view/read-surface.ts',
      'src/canvas/runtime/view/types.ts',
      'src/canvas/runtime/view/camera-driver.ts',
    ],
  },
  {
    // World content moves by the world-root matrix, never per-point projection (world-layers.test.ts "a pan
    // re-tessellates no zone" is the behavioural half). Upright billboards and the billboard drafts project anchors;
    // overlays live in chrome/, outside the rule.
    kind: 'confine-symbols',
    name: 'P12 the renderer learns the camera one way',
    from: ['src/canvas/runtime/renderers/**'],
    names: ['worldToScreen', 'projectAnchors', 'worldQuadToScreen'],
    allowedFrom: [
      'src/canvas/runtime/renderers/billboard-layer.ts',
      'src/canvas/runtime/renderers/draft-layer.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // armCanvasTool decides focus and rail learning once (spec §1.6); the session and its signal setter sit below it.
    kind: 'confine-symbols',
    name: 'P9 only armCanvasTool and the session arm a tool',
    from: ['src/**'],
    names: ['selectCanvasTool', 'setCurrentCanvasTool', 'setCanvasTool'],
    allowedFrom: [
      'src/app/keyboard/arming.ts',
      'src/canvas/session.ts',
      'src/canvas/session-state.ts',
      'src/canvas/runtime/command-surface.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // Any receiver, through `?.`, `!` and brackets: `tools?.setTool`, `commandSurface?.setTool`, `surface['setTool']`.
    kind: 'forbid-calls',
    name: 'P9 app code calls no tool surface setTool but through armCanvasTool',
    from: ['src/app/**', 'src/components/**', 'src/web/**', 'src/canvas/*-source.ts'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    properties: ['setTool'],
  },
  {
    // Fails closed: each caller keeps its import, so a caller that drops arming for a local setter is seen.
    kind: 'require-imports',
    name: 'P9 the arming callers import armCanvasTool',
    from: [
      'src/components/plant-db/place-species.ts',
      'src/components/canvas/SiteOnboarding.tsx',
      'src/components/canvas/StampChooser.tsx',
      'src/app/saved-object-stamps/workbench.ts',
      'src/app/workspace-commands/canvas-actions.ts',
    ],
    targets: ['src/app/keyboard/arming.ts'],
  },
  {
    // Desktop and Web share one keyboard owner; each edition composes its keymap and command sink outside it
    // (Desktop: commands/registry.ts installDesktopKeyRouter, called by platform/desktop.ts; Web:
    // web/browser-shell-commands.ts).
    kind: 'forbid-imports',
    name: 'P14 the keyboard module is neutral',
    from: ['src/app/keyboard/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['src/commands/**', 'src/web/**', 'src/platform/**', 'src/components/**'],
  },
  {
    // Static and re-export value edges; type-only and dynamic edges enter no evaluation order, so they may close a loop.
    kind: 'forbid-cycles',
    name: 'P39 production modules form no value import cycle',
    from: ['src/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
  },
  {
    // The foundation layers sit below app code: they may name app types (type-only edges enter no bundle), never
    // import app values, components or edition code.
    kind: 'forbid-imports',
    name: 'P40 foundation layers import no app, component or edition code',
    from: [
      'src/i18n/**',
      'src/utils/**',
      'src/types/**',
      'src/generated/**',
      'src/maplibre/**',
      'src/target/**',
      'src/canvas/**',
      'src/ipc/**',
    ],
    exceptFrom: [
      // Locale and theme read their settings signals until they get a foundation home (canopi-f47t.52.12).
      'src/i18n/index.ts',
      'src/utils/theme.ts',
      // Design write admission and dialogs still compose app/document-session (canopi-m4v0).
      'src/ipc/design.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
    targets: ['src/app/**', 'src/components/**', 'src/web/**', 'src/commands/**', 'src/platform/**'],
    allowTypeOnlyTargets: ['src/app/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'P41 canvas imports no native code',
    from: ['src/canvas/**'],
    exceptFrom: [
      // The Desktop species cache moves to app/canvas-runtime/ in 2.1 (S26, canopi-f47t.52.18).
      'src/canvas/runtime/species-cache.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
    // Web and platform code are P40's targets.
    targets: ['src/ipc/**', '@tauri-apps/**'],
  },
  {
    kind: 'forbid-imports',
    name: 'P42 shared app code imports no Web edition module',
    from: ['src/app/**'],
    exceptFrom: [
      // Web-only app modules that move to web/ in 2.1 (S25, canopi-f47t.52.12).
      'src/app/community/catalog.browser.ts',
      'src/app/design-template-import/workflow.browser.ts',
      'src/app/plant-browser/browser-runtime.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
    targets: ['src/web/**'],
  },
  {
    // ADR 0017: recognition sees no camera. View types may be named, and the pure navigation policy gives the
    // rotate rate (ROTATE_DEG_PER_PX); no source file is excepted.
    kind: 'forbid-imports',
    name: 'P43 the input core stays camera-free and app-free',
    from: ['src/canvas/runtime/input/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: [
      'src/canvas/runtime/scene/**',
      'src/canvas/runtime/renderers/**',
      'src/canvas/runtime/chrome/**',
      'src/canvas/runtime/view/**',
      'src/app/**',
    ],
    exceptTargets: ['src/canvas/runtime/view/navigation-policy.ts'],
    allowTypeOnlyTargets: ['src/canvas/runtime/view/**'],
  },
  {
    // Every other writer calls mutateSettingsProjection, which persists the change; a direct write skips persistence.
    kind: 'forbid-writes',
    name: 'P44 settings and map-layer signals are written only by the projection',
    from: ['src/**'],
    exceptFrom: ['src/app/settings/projection.ts', ...TEST_SOURCE_PATTERNS],
    targets: SETTINGS_PROJECTION_SIGNALS.flatMap((signal) => [`${signal}.value`, `*.${signal}.value`]),
  },
  {
    // A presentation starts and ends in its controller; the map, the runtime adapter and the overlays only read the
    // overrides. Tests set them to stage a presentation.
    kind: 'confine-symbols',
    name: 'P45 only the presentation controller writes story overrides',
    from: ['src/**'],
    names: ['setStoryPresentationOverrides', 'setStoryPresentationHidesEditingAids'],
    allowedFrom: [
      'src/app/story-presentation/controller.ts',
      'src/app/story-presentation/overrides.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // An import rule, since the key's names are also property names. A namespace import ('*') reads every member, so
    // it counts too. Readers: settings itself (its readSatelliteConfig getter is how a map mount gets the key), the key
    // field and the Layers presentation. Residual risk (canopi-f47t.52.21): mutateSettingsProjection's draft
    // carries googleMapsApiKey to every caller of the mutation seam, which this rule cannot see.
    kind: 'forbid-imports',
    name: 'P46 the Google key has reviewed readers',
    from: ['src/**'],
    exceptFrom: [
      'src/app/settings/**',
      'src/components/shared/SettingsGoogleKeyField.tsx',
      'src/app/canvas-layer-presentation/presentation.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
    targets: ['src/app/settings/state.ts', 'src/app/settings/projection.ts'],
    importedNames: ['googleMapsApiKey', 'activeGoogleMapsApiKey', 'snapshotSettingsProjection', '*'],
  },
  {
    // S24: the URLs that carry the key or a session are built in basemap-tile-auth.ts (the only module naming a Google
    // tile endpoint, map-error-redaction.test.ts) and used only by the Satellite provider.
    kind: 'confine-symbols',
    name: 'P46b only the Satellite provider builds the Google key URLs',
    from: ['src/**'],
    names: ['googleSessionRequestUrl', 'googleViewportRequestUrl', 'GOOGLE_SESSION_TILES'],
    allowedFrom: [
      'src/maplibre/basemap-tile-auth.ts',
      'src/maplibre/satellite-provider.ts',
      'src/maplibre/satellite-provider-session.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // The document surface loads, replaces and destroys the canvas document; components read query and command
    // surfaces instead.
    kind: 'forbid-imports',
    name: 'P47 components never hold the canvas document lifecycle',
    from: ['src/components/**'],
    exceptFrom: [
      // Takes the whole surface only to attach the inspection; a one-member inspection surface in 2.1 (canopi-f47t.52.12).
      'src/components/canvas/InspectionLens.tsx',
      ...TEST_SOURCE_PATTERNS,
    ],
    targets: ['src/canvas/session.ts'],
    importedNames: ['currentCanvasDocumentSurface', 'getCurrentCanvasDocumentSurface', '*'],
  },
  {
    // The recogniser's secondary click reaches the tool host, which opens the menu (S14); type-only edges count too.
    kind: 'confine-importers',
    name: 'P48 the tool host is the only canvas-menu opener',
    targets: ['src/canvas/runtime/interaction/canvas-context-menu.ts'],
    allowedFrom: ['src/canvas/runtime/tools/tool-host.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    // A symbol rule, so a namespace or dynamic import of @tauri-apps/api/core is caught too.
    kind: 'confine-symbols',
    name: 'P49 only IPC transports invoke native commands',
    from: ['src/**'],
    names: ['invoke'],
    allowedFrom: [
      'src/ipc/**',
      // Both calls move into ipc/ in 2.1 (canopi-f47t.52.19).
      'src/app/shell/bootstrap.ts',
      'src/app/canvas-pdf/platform.desktop.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // The location trust boundary (canopi-f47t.53; design check A12): one session owns a device fix, and one module asks
    // the browser for it. my-location-trust.test.ts checks that the reading reaches no log.
    kind: 'confine-importers',
    name: 'P52 only the location button and the Web wiring import the location session',
    targets: ['src/app/my-location/session.ts'],
    allowedFrom: [
      'src/components/canvas/MyLocationButton.tsx',
      'src/web/browser-workspace-map-contribution-adapter.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    kind: 'forbid-calls',
    name: 'P53 only the geolocation module calls watchPosition, getCurrentPosition or clearWatch',
    from: ['src/**'],
    exceptFrom: ['src/app/my-location/geolocation.ts', ...TEST_SOURCE_PATTERNS],
    properties: ['watchPosition', 'getCurrentPosition', 'clearWatch'],
  },
  {
    // The engine and the shared point editor are pure: no tool host, session, settings or Preact, and of the runtime
    // only types (view types, ToolHandle, HandleSize, interaction types, the scene).
    kind: 'forbid-imports',
    name: 'P54 the point editor and the path engine import only each other and types',
    from: ['src/canvas/point-editor/**', 'src/canvas/plant-path/**'],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['src/**', 'preact', 'preact/**', '@preact/**'],
    // plant-spacing-sequence.ts: the straight-row maths, a pure leaf an open 2-point path calls unchanged (A3).
    exceptTargets: ['src/canvas/point-editor/**', 'src/canvas/plant-path/**', 'src/canvas/plant-spacing-sequence.ts'],
    allowTypeOnlyTargets: [
      'src/canvas/runtime/view/types.ts',
      'src/canvas/runtime/tools/draft.ts',
      'src/canvas/runtime/tools/select/handle-size.ts',
      'src/canvas/runtime/interaction-types.ts',
      'src/canvas/runtime/scene/**',
    ],
  },
  {
    // Settings own device state: only Plant a row's spacing field writes the device interval (canopi-f47t.54), through
    // the tool contract and today's wiring (the adapters name it ...Meters); its "N plants" count, a panel or a chip never
    // does (plant-row.test.ts checks the count's half).
    kind: 'confine-symbols',
    name: 'P56 only the row tool and its wiring write the device spacing interval',
    from: ['src/**'],
    names: ['commitPlantSpacingIntervalM', 'commitPlantSpacingIntervalMeters'],
    allowedFrom: [
      'src/canvas/runtime/tools/plant-row.ts',
      'src/canvas/runtime/tools/tool.ts',
      'src/canvas/runtime/interaction-session.ts',
      'src/canvas/runtime/scene-runtime.ts',
      'src/canvas/runtime/app-adapter.ts',
      'src/app/canvas-runtime/app-adapter.ts',
      ...TEST_SOURCE_PATTERNS,
    ],
  },
  {
    // P56's second route: a settings draft write (`mutateSettingsProjection((d) => { d.plantSpacingIntervalM = x })`)
    // names neither writer, and P44 sees only `.value` writes. Residual risk: `Object.assign(d, { … })` is not seen.
    kind: 'forbid-writes',
    name: 'P56 only the canvas app adapter writes the device spacing draft',
    from: ['src/**'],
    exceptFrom: ['src/app/canvas-runtime/app-adapter.ts', ...TEST_SOURCE_PATTERNS],
    targets: ['*.plantSpacingIntervalM', "*['plantSpacingIntervalM']", '*["plantSpacingIntervalM"]'],
  },
] satisfies readonly ArchitecturePolicy[]

/**
 * P5b, checked on the runtime graph: type-only imports of tools/ (interaction-ports.ts, renderers/scene-types.ts and
 * the chrome read tool.ts and draft.ts types) enter no bundle, so only value imports are confined.
 */
const TOOL_HOST_RUNTIME_GRAPH_POLICIES = [
  {
    kind: 'confine-importers',
    name: 'P5b tool modules are value-imported only inside tools/ and by the interaction session',
    targets: [TOOLS_SOURCES],
    allowedFrom: [TOOLS_SOURCES, 'src/canvas/runtime/interaction-session.ts', ...TEST_SOURCE_PATTERNS],
  },
  {
    // The session builds the ToolScene with createToolScene, which tool-host.ts re-exports (spec §1.2a).
    kind: 'forbid-imports',
    name: 'P5b the interaction session value-imports only the tool host',
    from: ['src/canvas/runtime/interaction-session.ts'],
    targets: [TOOLS_SOURCES],
    exceptTargets: ['src/canvas/runtime/tools/tool-host.ts'],
  },
] satisfies readonly ArchitecturePolicy[]

const FRONTEND_ARCHITECTURE_POLICIES = [
  ...FORBIDDEN_IMPORT_POLICIES,
  ...CONFINED_IMPORTER_POLICIES,
  ...REQUIRED_IMPORT_POLICIES,
  ...NAMED_IMPORT_POLICIES,
  ...FORBIDDEN_EXPORT_POLICIES,
  ...SOURCE_TOMBSTONE_POLICIES,
  ...SYMBOL_OWNERSHIP_POLICIES,
  ...CANVAS_V2_POLICIES,
] satisfies readonly ArchitecturePolicy[]

/**
 * Runtime-graph policies ignore type-only edges (they enter no bundle) and
 * leave `#edition` aliases unresolved, so an alias is the only permitted seam
 * from shared code to edition-specific platform code.
 */
const SHARED_RUNTIME_GRAPH_POLICIES = [
  {
    kind: 'forbid-transitive-imports',
    name: 'GeoJSON, continuous save and map layers stay free of Desktop capabilities',
    from: [
      'src/app/geojson/**',
      'src/app/document-session/continuous-save.ts',
      'src/app/map-layers/**',
    ],
    exceptFrom: [...TEST_SOURCE_PATTERNS],
    targets: ['@tauri-apps/**', 'src/ipc/**'],
  },
  {
    kind: 'forbid-transitive-imports',
    name: 'Place Search reaches native geocoding only through the edition transport',
    from: ['src/components/canvas/PlaceSearch.tsx'],
    targets: ['@tauri-apps/**', 'src/ipc/**'],
  },
] satisfies readonly ArchitecturePolicy[]

/** Checked on the runtime graph, whose `#platform` stays unresolved: Desktop's entry, app and bootstrap. */
const DESKTOP_RUNTIME_GRAPH_POLICIES = [
  {
    // Desktop never asks a browser to keep storage (2.1-Q82, Step 2.0.3 row L17): the request is Web-only.
    kind: 'forbid-transitive-imports',
    name: 'Desktop never reaches the Web Draft persistence request',
    from: ['src/main.tsx', 'src/app.tsx', 'src/platform/desktop.ts'],
    targets: ['src/web/browser-draft-persistence.ts'],
  },
  {
    // Desktop's page assets ship inside its binary, so no deploy can skew them: the release watch and its New version:
    // Reload notice are Web-only (2.1-Q83, M179; ADR 0030 app updater row).
    kind: 'forbid-transitive-imports',
    name: 'Desktop never reaches the Web release watch',
    from: ['src/main.tsx', 'src/app.tsx', 'src/platform/desktop.ts'],
    targets: ['src/web/browser-release-watch.ts'],
  },
] satisfies readonly ArchitecturePolicy[]

/** The one production source that may listen for Vite's failed lazy chunk event (2.1-M179). */
const PRELOAD_ERROR_OWNER = 'src/web/browser-release-watch.ts'

function isTestSource(path: string): boolean {
  return path.startsWith('src/__tests__/') || /\.test\.tsx?$/.test(path)
}

/** Production sources other than the owner that name `vite:preloadError`. */
function preloadErrorListeners(graph: readonly { readonly path: string, readonly source: string }[]): string[] {
  return graph
    .filter((source) => !isTestSource(source.path) && source.path !== PRELOAD_ERROR_OWNER)
    .filter((source) => source.source.includes('vite:preloadError'))
    .map((source) => source.path)
}

/** Checked on the runtime graph with `#edition` aliases resolved to their Web targets. */
const WEB_EDITION_RUNTIME_GRAPH_POLICIES = [
  {
    kind: 'forbid-transitive-imports',
    name: 'Web entry graph stays free of Desktop capabilities',
    from: ['src/main.web.tsx'],
    targets: ['@tauri-apps/**', 'src/ipc/**'],
  },
] satisfies readonly ArchitecturePolicy[]

/** Checked on the runtime graph: type-only Scene query contracts do not enter either edition's runtime bundle. */
const BROWSER_WORKSPACE_GRAPH_POLICIES = [
  {
    kind: 'forbid-transitive-imports',
    name: 'Browser workspace and shared map contributions stay free of Desktop capabilities',
    from: [
      'src/web/browser-workspace-runtime.ts',
      'src/web/browser-workspace-map-contribution-adapter.ts',
      'src/app/canvas-map-surface/workspace-map-contributions.ts',
    ],
    targets: [
      '@tauri-apps/**', 'src/ipc/**',
      'src/app/canvas-map-surface/desktop-workspace-map-contribution-adapter.ts',
      'src/maplibre/raster-display/**',
      'src/app/lidar/library-store.ts', 'src/app/lidar/display.ts',
    ],
  },
] satisfies readonly ArchitecturePolicy[]

/** Mirrors the `isWebEdition` branch of vite.config.ts `resolve.alias`. */
const WEB_EDITION_ALIAS_TARGETS: Readonly<Record<string, string>> = {
  '#platform': 'src/platform/browser.ts',
  '#canvas-pdf-platform': 'src/app/canvas-pdf/platform.browser.ts',
  '#budget-export-platform': 'src/app/budget/platform.browser.ts',
  '#geocoding-transport': 'src/app/geocoding/transport.browser.ts',
  '#species-catalog-live': 'src/app/plant-browser/live.browser.ts',
}

type SourceGraph = ReturnType<typeof discoverTypeScriptSourceGraph>

let sourceGraphCache: SourceGraph | null = null

/** The repository's source graph, parsed once per run: every policy below reads the same tree. */
function discoveredSourceGraph(): SourceGraph {
  sourceGraphCache ??= discoverTypeScriptSourceGraph(new URL('../', import.meta.url), 'src')
  return sourceGraphCache
}

// Parsing the whole tree takes about 6 s idle and three times that under load:
// it runs once here, on its own budget, so no test's 20 s timeout pays it (canopi-l1jv).
beforeAll(() => {
  discoveredSourceGraph()
}, 120_000)

function runtimeGraph(graph: SourceGraph): SourceGraph {
  return graph.map((source) => ({
    ...source,
    imports: source.imports.filter((edge) => !edge.typeOnly),
  }))
}

function resolveWebEditionAliases(graph: SourceGraph): SourceGraph {
  return graph.map((source) => ({
    ...source,
    imports: source.imports.map((edge) => {
      const target = WEB_EDITION_ALIAS_TARGETS[edge.target]
      return target ? { ...edge, target } : edge
    }),
  }))
}

const DESIGN_SESSION_TEST_BOUNDARY_POLICY_NAMES = new Set([
  'Production code cannot acquire the Design Session test fixture',
  'Production code cannot import frontend test support',
])

function designSessionTestBoundaryPolicies(): readonly ArchitecturePolicy[] {
  return FRONTEND_ARCHITECTURE_POLICIES.filter(({ name }) =>
    DESIGN_SESSION_TEST_BOUNDARY_POLICY_NAMES.has(name)
  )
}

const DESIGN_SESSION_TEST_FIXTURE_OWNER_SOURCE = {
  path: 'src/app/document-session/store.ts',
  source: 'export function createDesignSessionStoreTestFixture() {}',
} as const

const DESIGN_SESSION_TEST_FIXTURE_ALLOWED_SOURCES =
  'src/app/document-session/store.ts, src/__tests__/**, src/**/*.test.ts, src/**/*.test.tsx'

const PATH_DRIFT_LIVE_SOURCE = {
  path: 'src/app/live/module.ts',
  source: 'export const live = 1',
} as const

describe('declarative frontend architecture policies', () => {
  it('rejects platform imports from the neutral shell command catalog', () => {
    const graph = createTypeScriptSourceGraph([{
      path: 'src/app/shell-commands/index.ts',
      source: `
        import { getCurrentWindow } from '@tauri-apps/api/window'
        void getCurrentWindow
      `,
    }])
    const policies = FRONTEND_ARCHITECTURE_POLICIES.filter(({ name }) =>
      name === 'Neutral shell command catalog stays platform-neutral'
    )

    expect(collectArchitecturePolicyViolations(graph, policies)).toEqual([
      expect.stringContaining(
        '[Neutral shell command catalog stays platform-neutral] src/app/shell-commands/index.ts',
      ),
    ])
  })

  it.each([
    {
      caseName: 'root production entry',
      path: 'src/main.tsx',
      source: `
          import { createDesignSessionStoreTestFixture } from './app/document-session/store'
          createDesignSessionStoreTestFixture()
        `,
    },
    {
      caseName: 'aliased import',
      path: 'src/app/fixture-consumer.ts',
      source: `
          import {
            createDesignSessionStoreTestFixture as acquireFixture,
          } from './document-session/store'
          acquireFixture()
        `,
    },
    {
      caseName: 'namespace import',
      path: 'src/commands/fixture-consumer.ts',
      source: `
          import * as designSession from '../app/document-session/store'
          designSession.createDesignSessionStoreTestFixture()
        `,
    },
  ])('rejects Design Session test fixture acquisition through a $caseName', ({ path, source }) => {
    const graph = createTypeScriptSourceGraph([
      DESIGN_SESSION_TEST_FIXTURE_OWNER_SOURCE,
      { path, source },
    ])

    expect(collectArchitecturePolicyViolations(
      graph,
      designSessionTestBoundaryPolicies(),
    )).toEqual([
      `[Production code cannot acquire the Design Session test fixture] ${path} contains confined symbol createDesignSessionStoreTestFixture; allowed sources: ${DESIGN_SESSION_TEST_FIXTURE_ALLOWED_SOURCES}`,
    ])
  })

  it('rejects production imports from frontend test support', () => {
    const graph = createTypeScriptSourceGraph([
      {
        path: 'src/__tests__/support/design-session-state.ts',
        source: 'export const designSessionFixture = {}',
      },
      {
        path: 'src/platform/fixture-consumer.ts',
        source: `
          import { designSessionFixture } from '../__tests__/support/design-session-state'
          void designSessionFixture
        `,
      },
    ])

    expect(collectArchitecturePolicyViolations(
      graph,
      designSessionTestBoundaryPolicies(),
    )).toEqual([
      '[Production code cannot import frontend test support] src/platform/fixture-consumer.ts:2:11 imports src/__tests__/support/design-session-state.ts via "../__tests__/support/design-session-state" (static)',
    ])
  })

  it('allows the Design Session store and frontend tests to use test support', () => {
    const graph = createTypeScriptSourceGraph([
      DESIGN_SESSION_TEST_FIXTURE_OWNER_SOURCE,
      {
        path: 'src/__tests__/support/design-session-state.ts',
        source: `
          import { createDesignSessionStoreTestFixture } from '../../app/document-session/store'
          export const designSessionFixture = createDesignSessionStoreTestFixture()
        `,
      },
      {
        path: 'src/__tests__/consumer.test.ts',
        source: `
          import { designSessionFixture } from './support/design-session-state'
          void designSessionFixture
        `,
      },
      {
        path: 'src/canvas/runtime/consumer.test.ts',
        source: `
          import { designSessionFixture } from '../../__tests__/support/design-session-state'
          void designSessionFixture
        `,
      },
    ])

    expect(collectArchitecturePolicyViolations(
      graph,
      designSessionTestBoundaryPolicies(),
    )).toEqual([])
  })

  it('keeps Saved Object Stamp HMR disposal with the live Workbench owner', () => {
    const ownerSource = readFileSync(
      new URL('../app/saved-object-stamps/index.ts', import.meta.url),
      'utf8',
    )
    expect(ownerSource).toMatch(
      /const\s+liveSavedObjectStampWorkbench\s*=\s*createSavedObjectStampWorkbench\(\)/,
    )
    expect(ownerSource).toMatch(
      /export\s+const\s+savedObjectStampWorkbench(?:\s*:\s*SavedObjectStampWorkbench)?\s*=\s*liveSavedObjectStampWorkbench/,
    )
    expect(ownerSource).toMatch(/if\s*\(\s*import\.meta\.hot\s*\)/)
    expect(ownerSource).toMatch(
      /import\.meta\.hot\.dispose\(\s*\(\)\s*=>\s*(?:\{\s*)?liveSavedObjectStampWorkbench\.dispose\(\)\s*;?\s*(?:\})?\s*\)/,
    )
  })

  it('keeps the browser workspace graph free of Desktop runtime dependencies', () => {
    const graph = runtimeGraph(discoveredSourceGraph())
    expect(collectArchitecturePolicyViolations(graph, BROWSER_WORKSPACE_GRAPH_POLICIES)).toEqual([])
  }, 20_000)

  it('keeps tool modules behind the one tool host in the runtime graph', () => {
    const graph = runtimeGraph(discoveredSourceGraph())
    expect(collectArchitecturePolicyViolations(graph, TOOL_HOST_RUNTIME_GRAPH_POLICIES)).toEqual([])
  }, 20_000)

  it('keeps shared modules and the Web entry graph free of Desktop runtime dependencies', () => {
    const graph = runtimeGraph(discoveredSourceGraph())
    expect(collectArchitecturePolicyViolations(graph, SHARED_RUNTIME_GRAPH_POLICIES)).toEqual([])
    expect(collectArchitecturePolicyViolations(graph, DESKTOP_RUNTIME_GRAPH_POLICIES)).toEqual([])
    expect(collectArchitecturePolicyViolations(
      resolveWebEditionAliases(graph),
      WEB_EDITION_RUNTIME_GRAPH_POLICIES,
    )).toEqual([])
  }, 20_000)

  it('resolves every edition alias to the Web target Vite uses', () => {
    const graph = discoveredSourceGraph()
    const paths = new Set(graph.map(({ path }) => path))
    const aliases = new Set(graph.flatMap(({ imports }) =>
      imports.map(({ target }) => target).filter((target) => target.startsWith('#'))))
    const viteConfig = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
    const tsconfig = readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8')
    const tsconfigAliases = [...tsconfig.matchAll(/"(#[\w-]+)"\s*:/g)].map(([, alias]) => alias)

    expect([...aliases].sort()).toEqual(Object.keys(WEB_EDITION_ALIAS_TARGETS).sort())
    expect(tsconfigAliases.sort()).toEqual(Object.keys(WEB_EDITION_ALIAS_TARGETS).sort())
    for (const [alias, target] of Object.entries(WEB_EDITION_ALIAS_TARGETS)) {
      expect(paths.has(target), `${alias} -> ${target}`).toBe(true)
      expect(viteConfig).toContain(`'${alias}'`)
      expect(viteConfig).toContain(`'./${target}'`)
    }
  }, 20_000)

  it('rejects planted native, controller, component and Web entry dependencies', () => {
    const graph = createTypeScriptSourceGraph([
      { path: 'src/components/shared/Chrome.tsx', source: `import { getCurrentWindow } from '@tauri-apps/api/window'\nvoid getCurrentWindow` },
      { path: 'src/components/panels/Lidar.tsx', source: `import type { LidarLayer } from '../../ipc/lidar'\nexport type Layer = LidarLayer` },
      { path: 'src/ipc/lidar.ts', source: `import { invoke } from '@tauri-apps/api/core'\nexport type LidarLayer = string\nvoid invoke` },
      { path: 'src/app/one/controller.ts', source: `import { two } from '../two/controller'\nvoid two` },
      { path: 'src/app/two/controller.ts', source: `export const two = 2` },
      { path: 'src/app/panel/actions.ts', source: `import { Chrome } from '../../components/shared/Chrome'\nvoid Chrome` },
      { path: 'src/app/map-layers/state.ts', source: `import { bridge } from '../bridge'\nvoid bridge` },
      { path: 'src/app/document-session/continuous-save.ts', source: `export const save = 1` },
      { path: 'src/app/bridge.ts', source: `import { invoke } from '@tauri-apps/api/core'\nexport const bridge = invoke` },
      { path: 'src/components/canvas/PlaceSearch.tsx', source: `import { bridge } from '../../app/geo'\nimport { transport } from '#geocoding-transport'\nvoid bridge\nvoid transport` },
      { path: 'src/app/geo.ts', source: `export { lidar as bridge } from '../ipc/lidar'` },
      { path: 'src/main.web.tsx', source: `import { place } from '#geocoding-transport'\nvoid place` },
      { path: 'src/app/geocoding/transport.browser.ts', source: `import { bridge } from '../bridge'\nexport const place = bridge` },
    ])
    const violations = [
      ...collectArchitecturePolicyViolations(graph, FRONTEND_ARCHITECTURE_POLICIES.filter(({ name }) => [
        'Components reach native capabilities through app actions',
        'App controllers stay leaves',
        'App modules do not import components',
        'Place Search consumes geocoding through its session owner',
      ].includes(name))),
      ...collectArchitecturePolicyViolations(runtimeGraph(graph), SHARED_RUNTIME_GRAPH_POLICIES),
      ...collectArchitecturePolicyViolations(
        resolveWebEditionAliases(runtimeGraph(graph)),
        WEB_EDITION_RUNTIME_GRAPH_POLICIES,
      ),
    ]

    expect(violations).toEqual([
      expect.stringContaining('[Components reach native capabilities through app actions] src/components/shared/Chrome.tsx'),
      expect.stringContaining('[Components reach native capabilities through app actions] src/components/panels/Lidar.tsx'),
      expect.stringContaining('[App controllers stay leaves] src/app/one/controller.ts'),
      expect.stringContaining('[App modules do not import components] src/app/panel/actions.ts'),
      expect.stringContaining('[Place Search consumes geocoding through its session owner] src/components/canvas/PlaceSearch.tsx:2:1 imports #geocoding-transport'),
      expect.stringContaining('[GeoJSON, continuous save and map layers stay free of Desktop capabilities] src/app/map-layers/state.ts transitively imports @tauri-apps/api/core'),
      expect.stringContaining('[Place Search reaches native geocoding only through the edition transport] src/components/canvas/PlaceSearch.tsx transitively imports src/ipc/lidar.ts'),
      expect.stringContaining('[Web entry graph stays free of Desktop capabilities] src/main.web.tsx transitively imports @tauri-apps/api/core via src/main.web.tsx -> src/app/geocoding/transport.browser.ts'),
    ])
  })

  it('L17: rejects a planted Desktop path to the Web Draft persistence request', () => {
    const graph = createTypeScriptSourceGraph([
      { path: 'src/main.tsx', source: `export const main = 1` },
      { path: 'src/app.tsx', source: `export const app = 1` },
      { path: 'src/platform/desktop.ts', source: `import { shell } from '../app/shell/planted'\nvoid shell` },
      { path: 'src/app/shell/planted.ts', source: `import { browserDraftPersistence } from '../../web/browser-draft-persistence'\nexport const shell = browserDraftPersistence` },
      { path: 'src/web/browser-draft-persistence.ts', source: `export const browserDraftPersistence = 1` },
    ])
    expect(collectArchitecturePolicyViolations(runtimeGraph(graph), DESKTOP_RUNTIME_GRAPH_POLICIES)).toEqual([
      expect.stringContaining('[Desktop never reaches the Web Draft persistence request] src/platform/desktop.ts transitively imports src/web/browser-draft-persistence.ts'),
    ])
  })

  it('M179: rejects a planted Desktop path to the Web release watch', () => {
    const graph = createTypeScriptSourceGraph([
      { path: 'src/main.tsx', source: `export const main = 1` },
      { path: 'src/app.tsx', source: `import { watch } from './app/shell/planted'\nvoid watch` },
      { path: 'src/platform/desktop.ts', source: `export const desktop = 1` },
      { path: 'src/app/shell/planted.ts', source: `import { browserReleaseWatch } from '../../web/browser-release-watch'\nexport const watch = browserReleaseWatch` },
      { path: 'src/web/browser-release-watch.ts', source: `export const browserReleaseWatch = 1` },
    ])
    expect(collectArchitecturePolicyViolations(runtimeGraph(graph), DESKTOP_RUNTIME_GRAPH_POLICIES)).toEqual([
      expect.stringContaining('[Desktop never reaches the Web release watch] src/app.tsx transitively imports src/web/browser-release-watch.ts'),
    ])
  })

  it('M179: only the Web release watch listens for a failed lazy chunk', () => {
    expect(discoveredSourceGraph().some((source) => source.path === PRELOAD_ERROR_OWNER), 'the owner exists').toBe(true)
    expect(preloadErrorListeners(discoveredSourceGraph())).toEqual([])
    expect(preloadErrorListeners([
      { path: 'src/components/planted.ts', source: `window.addEventListener('vite:preloadError', (event) => event.preventDefault())` },
      { path: 'src/__tests__/planted.test.ts', source: `new Event('vite:preloadError')` },
      { path: PRELOAD_ERROR_OWNER, source: `const PRELOAD_ERROR = 'vite:preloadError'` },
    ])).toEqual(['src/components/planted.ts'])
  })

  it('rejects a map style reload anywhere in production, the World map included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/maplibre/planted.ts', [
        'map.setStyle(style)',
        'this.map?.setStyle(url, { diff: true })',
        'setStyleFilter(value)',
        '// map.setStyle() would reload the style',
      ]),
      plantedSource('src/components/world-map/WorldMapSurface.tsx', ['worldMap!.setStyle(style)']),
      plantedSource('src/maplibre/planted.test.ts', ['map.setStyle(style)']),
    ])
    const policy = '[Production never reloads a map style]'

    expect(collectArchitecturePolicyViolations(graph, FRONTEND_ARCHITECTURE_POLICIES.filter(({ name }) => `[${name}]` === policy))).toEqual([
      `${policy} src/maplibre/planted.ts:1 calls map.setStyle`,
      `${policy} src/maplibre/planted.ts:2 calls this.map?.setStyle`,
      `${policy} src/components/world-map/WorldMapSurface.tsx:1 calls worldMap!.setStyle`,
    ])
  })

  it('rejects a canvas runtime role module importing the scene runtime, type-only edges included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/scene-runtime.ts', ['export class SceneCanvasRuntime {}']),
      plantedSource('src/canvas/runtime/command-surface.ts', ["import { SceneCanvasRuntime } from './scene-runtime'"]),
      plantedSource('src/canvas/runtime/query-surface.ts', ["import type { SceneCanvasRuntime } from './scene-runtime'"]),
      plantedSource('src/canvas/runtime/document-surface.ts', ['export const documents = 1']),
      plantedSource('src/canvas/runtime/scene-runtime/construction.ts', ["import { SceneCanvasRuntime } from '../scene-runtime'"]),
    ])
    const policies = FRONTEND_ARCHITECTURE_POLICIES.filter(
      ({ name }) => name === 'Canvas runtime role modules do not import ./scene-runtime',
    )

    expect(collectArchitecturePolicyViolations(graph, policies)).toEqual([
      expect.stringContaining('src/canvas/runtime/command-surface.ts:1:1 imports src/canvas/runtime/scene-runtime.ts'),
      expect.stringContaining('src/canvas/runtime/query-surface.ts:1:1 imports src/canvas/runtime/scene-runtime.ts'),
      expect.stringContaining('src/canvas/runtime/scene-runtime/construction.ts:1:1 imports src/canvas/runtime/scene-runtime.ts'),
    ])
  })

  it('rejects the raw scene runtime outside the workspace composition, type-only edges included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/scene-runtime.ts', ['export class SceneCanvasRuntime {}']),
      plantedSource('src/app/canvas-map-surface/workspace-runtime-composition.ts', ["import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'"]),
      plantedSource('src/app/canvas-map-surface/workspace-activation.ts', ["import type { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'"]),
      plantedSource('src/app/canvas-runtime/app-adapter.ts', ["import type { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'"]),
      plantedSource('src/components/canvas/Planted.tsx', ["import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'"]),
      plantedSource('src/canvas/runtime/scene-runtime.test.ts', ["import { SceneCanvasRuntime } from './scene-runtime'"]),
    ])
    const policies = FRONTEND_ARCHITECTURE_POLICIES.filter(
      ({ name }) => name === 'Only the workspace composition holds the raw scene runtime',
    )

    expect(collectArchitecturePolicyViolations(graph, policies)).toEqual([
      expect.stringContaining('src/app/canvas-runtime/app-adapter.ts:1:1 imports src/canvas/runtime/scene-runtime.ts'),
      expect.stringContaining('src/components/canvas/Planted.tsx:1:1 imports src/canvas/runtime/scene-runtime.ts'),
    ])
  })

  it('rejects a Site data Design Edit write outside the Site data actions', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/design-edit/lidar.ts', ['export const patchLidarEntryById = 1']),
      plantedSource('src/app/lidar/actions.ts', ["import { patchLidarEntryById } from '../design-edit/lidar'"]),
      plantedSource('src/components/panels/lidar/Planted.tsx', ["import { patchLidarEntryById } from '../../../app/design-edit/lidar'"]),
      plantedSource('src/app/lidar/planted.ts', ["import type { LidarEntryPatch } from '../design-edit/lidar'"]),
      plantedSource('src/__tests__/planted.test.ts', ["import { patchLidarEntryById } from '../app/design-edit/lidar'"]),
    ])
    const policies = FRONTEND_ARCHITECTURE_POLICIES.filter(
      ({ name }) => name === 'Site data Design Edit writes go through Site data actions',
    )

    expect(collectArchitecturePolicyViolations(graph, policies)).toEqual([
      expect.stringContaining('src/components/panels/lidar/Planted.tsx:1:1 imports src/app/design-edit/lidar.ts'),
      expect.stringContaining('src/app/lidar/planted.ts:1:1 imports src/app/design-edit/lidar.ts'),
    ])
  })

  it('keeps every discovered TypeScript source within its owned dependency seams', () => {
    const graph = discoveredSourceGraph()
    const paths = graph.map(({ path }) => path)

    expect(paths).toEqual([...paths].sort((left, right) => left.localeCompare(right)))
    expect(paths).toContain('src/main.tsx')
    expect(paths).toContain('src/canvas/runtime/scene-runtime.ts')
    expect(paths).toContain('src/generated/web-catalog-artifact.d.mts')
    expect(paths.length).toBeGreaterThan(400)
    expect(collectArchitecturePolicyViolations(graph, FRONTEND_ARCHITECTURE_POLICIES)).toEqual([])
  }, 20_000)

  it('names only existing sources in every policy list checked against the real graph', () => {
    expect(collectPolicyPathDriftViolations(discoveredSourceGraph(), [
      ...FRONTEND_ARCHITECTURE_POLICIES,
      ...SHARED_RUNTIME_GRAPH_POLICIES,
      ...DESKTOP_RUNTIME_GRAPH_POLICIES,
      ...WEB_EDITION_RUNTIME_GRAPH_POLICIES,
      ...BROWSER_WORKSPACE_GRAPH_POLICIES,
      ...TOOL_HOST_RUNTIME_GRAPH_POLICIES,
    ])).toEqual([])
  }, 20_000)

  it('names only source exemptions that excuse a real file', () => {
    const graph = discoveredSourceGraph()
    const runtime = runtimeGraph(graph)
    expect([
      ...collectUnusedExemptionViolations(graph, FRONTEND_ARCHITECTURE_POLICIES, TEST_SOURCE_PATTERNS),
      ...collectUnusedExemptionViolations(runtime, SHARED_RUNTIME_GRAPH_POLICIES, TEST_SOURCE_PATTERNS),
      ...collectUnusedExemptionViolations(
        resolveWebEditionAliases(runtime),
        WEB_EDITION_RUNTIME_GRAPH_POLICIES,
        TEST_SOURCE_PATTERNS,
      ),
      ...collectUnusedExemptionViolations(runtime, BROWSER_WORKSPACE_GRAPH_POLICIES, TEST_SOURCE_PATTERNS),
      ...collectUnusedExemptionViolations(runtime, TOOL_HOST_RUNTIME_GRAPH_POLICIES, TEST_SOURCE_PATTERNS),
    ]).toEqual([])
  }, 60_000)

  it('reports an exceptFrom or allowedFrom entry that excuses nothing, but not an ignored one', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/uses.ts', ["import { invoke } from '@tauri-apps/api/core'", 'export const live = invoke']),
      plantedSource('src/app/clean.ts', ['export const clean = 1']),
    ])

    expect(collectUnusedExemptionViolations(graph, [
      {
        kind: 'forbid-imports',
        name: 'Planted exceptFrom',
        from: ['src/app/**'],
        exceptFrom: ['src/app/uses.ts', 'src/app/clean.ts', 'src/app/gone/**', 'src/**/*.test.ts'],
        targets: ['@tauri-apps/**'],
      },
      {
        kind: 'confine-symbols',
        name: 'Planted allowedFrom',
        names: ['live'],
        allowedFrom: ['src/app/uses.ts', 'src/app/clean.ts'],
      },
    ], ['src/**/*.test.ts'])).toEqual([
      '[Planted exceptFrom] exceptFrom entry excuses nothing: src/app/clean.ts',
      '[Planted exceptFrom] exceptFrom entry excuses nothing: src/app/gone/**',
      '[Planted allowedFrom] allowedFrom entry excuses nothing: src/app/clean.ts',
    ])
  })

  it('rejects a policy glob from that matches no source', () => {
    const graph = createTypeScriptSourceGraph([PATH_DRIFT_LIVE_SOURCE])

    expect(collectPolicyPathDriftViolations(graph, [
      {
        kind: 'forbid-source-symbols',
        name: 'Planted glob from',
        from: ['src/app/**', 'src/app/live/module.ts', 'src/state/**'],
        names: ['live'],
      },
    ])).toEqual([
      '[Planted glob from] from matches no source: src/state/**',
    ])
  })

  it('rejects a src/ literal target that matches no source in every import kind', () => {
    const graph = createTypeScriptSourceGraph([PATH_DRIFT_LIVE_SOURCE])
    const targets = ['src/app/live/module.ts', 'src/app/gone.ts']

    expect(collectPolicyPathDriftViolations(graph, [
      { kind: 'forbid-imports', name: 'Planted forbid-imports', from: ['src/app/**'], targets },
      { kind: 'forbid-transitive-imports', name: 'Planted forbid-transitive-imports', from: ['src/app/**'], targets },
      { kind: 'require-imports', name: 'Planted require-imports', from: ['src/app/**'], targets },
      { kind: 'confine-importers', name: 'Planted confine-importers', targets, allowedFrom: ['src/app/**'] },
      {
        kind: 'named-imports',
        name: 'Planted named-imports',
        from: ['src/app/**'],
        target: 'src/app/gone.ts',
        requiredNames: [],
        allowedNames: [],
      },
    ])).toEqual([
      '[Planted forbid-imports] targets matches no source: src/app/gone.ts',
      '[Planted forbid-transitive-imports] targets matches no source: src/app/gone.ts',
      '[Planted require-imports] targets matches no source: src/app/gone.ts',
      '[Planted confine-importers] targets matches no source: src/app/gone.ts',
      '[Planted named-imports] target matches no source: src/app/gone.ts',
    ])
  })

  it('rejects a src/ glob target that matches no source', () => {
    const graph = createTypeScriptSourceGraph([PATH_DRIFT_LIVE_SOURCE])

    expect(collectPolicyPathDriftViolations(graph, [
      {
        kind: 'forbid-imports',
        name: 'Planted glob target',
        from: ['src/app/**'],
        targets: ['src/app/live/**', 'src/app/planning-canvas/**'],
      },
    ])).toEqual([
      '[Planted glob target] targets matches no source: src/app/planning-canvas/**',
    ])
  })

  it('rejects a src/ allowedFrom entry that matches no source', () => {
    const graph = createTypeScriptSourceGraph([PATH_DRIFT_LIVE_SOURCE])

    expect(collectPolicyPathDriftViolations(graph, [
      {
        kind: 'confine-symbols',
        name: 'Planted confine-symbols',
        from: ['src/**'],
        names: ['live'],
        allowedFrom: ['src/app/live/module.ts', 'src/app/gone.ts'],
      },
      {
        kind: 'confine-importers',
        name: 'Planted confine-importers',
        targets: ['src/app/live/module.ts'],
        allowedFrom: ['src/app/live/**', 'src/app/gone/**'],
      },
    ])).toEqual([
      '[Planted confine-symbols] allowedFrom matches no source: src/app/gone.ts',
      '[Planted confine-importers] allowedFrom matches no source: src/app/gone/**',
    ])
  })

  it('skips package specifiers, aliases, callee and write text, exceptions and tombstones in the path-drift check', () => {
    const graph = createTypeScriptSourceGraph([PATH_DRIFT_LIVE_SOURCE])

    expect(collectPolicyPathDriftViolations(graph, [
      {
        kind: 'forbid-imports',
        name: 'Planted non-path targets and exceptions',
        from: ['src/app/**'],
        exceptFrom: ['src/gone/**'],
        targets: ['maplibre-gl', '@tauri-apps/api/window', '@tauri-apps/**', '#platform', '**', 'ui-gallery/**'],
        exceptTargets: ['src/gone.ts'],
        allowTypeOnlyTargets: ['src/gone/**'],
      },
      {
        kind: 'forbid-calls',
        name: 'Planted callee text',
        from: ['src/app/**'],
        exceptFrom: ['src/gone/**'],
        targets: ['maplibre.**', 'src/gone.fn'],
      },
      {
        kind: 'forbid-writes',
        name: 'Planted write text',
        from: ['src/app/**'],
        exceptFrom: ['src/gone/**'],
        targets: ['src/gone.value'],
      },
      {
        kind: 'source-tombstones',
        name: 'Planted tombstones',
        files: ['src/gone.ts'],
        symbols: [{ from: ['src/gone/**'], names: ['gone'] }],
      },
      // A literal from is collectArchitecturePolicyViolations's missing-source check, not this one.
      { kind: 'forbid-exports', name: 'Planted literal from', from: ['src/app/gone.ts'], names: ['gone'] },
    ])).toEqual([])
  })
})

function canvasV2Policies(id: string): readonly ArchitecturePolicy[] {
  return CANVAS_V2_POLICIES.filter(({ name }) => name.startsWith(`${id} `))
}

function plantedSource(path: string, lines: readonly string[]) {
  return { path, source: lines.join('\n') }
}

const P1_CAMERA_METHODS = '[P1 only the camera driver calls MapLibre camera methods]'
const P1_MAP_RECEIVERS = '[P1 only the camera driver stops, pans, zooms, resizes or resets north a map]'
const P1_MAP_TYPE = '[P1 the camera driver imports the MapLibre map type]'
const P2 = '[P2 nobody projects through MapLibre]'
const P3_SYMBOLS = '[P3 the legacy camera, its viewport snapshots and the planar camera maths stay deleted]'
const P3_EXPORTS = '[P3 no module exports a free worldToScreen or screenToWorld]'
const P3_BUILDER = '[P3 only the view module and the lens build a view transform]'
const P4_IMPORTS = '[P4 the view module imports only its pure dependencies]'
const P5_IMPORTS = '[P5 tools import no MapLibre, DOM or Pixi]'
const P5_SYMBOLS = '[P5 tools name no DOM event, element or camera]'
const P5B_IMPORTERS = '[P5b tool modules are value-imported only inside tools/ and by the interaction session]'
const P5B_SESSION = '[P5b the interaction session value-imports only the tool host]'
const P5C = '[P5c tools reach no MapLibre or Pixi through other modules]'
const P6_CAPTURE = '[P6 only the DOM input source captures the pointer]'
const P6_LISTENERS = '[P6 only the DOM input source adds canvas listeners]'
const P6_MAPLIBRE = '[P6 MapLibre modules add listeners only to abort signals]'
const P7 = '[P7 the input core reaches no browser global or DOM event]'
const P10_SIGNALS = '[P10 only the runtime and the map layer read per-frame view signals]'
const P10_IMPORTS = '[P10 the app, components and Web import view types only]'
const P12 = '[P12 the renderer learns the camera one way]'
const P11 = '[Retired frontend seams stay deleted]'
const P11_FOCUS_REGION_CALL = '[Retired frontend seams stay deleted: the free focusRegion is not called]'
const P11_FOCUS_REGION_EXPORT = '[Retired frontend seams stay deleted: no module exports focusRegion]'
const P9_SYMBOLS = '[P9 only armCanvasTool and the session arm a tool]'
const P9_CALLS = '[P9 app code calls no tool surface setTool but through armCanvasTool]'
const P9_IMPORTS = '[P9 the arming callers import armCanvasTool]'
const P14 = '[P14 the keyboard module is neutral]'
const TEST_SOURCES = TEST_SOURCE_PATTERNS.join(', ')

const PLANTED_MAP_LOADER = plantedSource('src/maplibre/loader.ts', ['export interface MapLibreMapInstance { stop(): void }'])
const PLANTED_CAMERA_DRIVER = plantedSource('src/maplibre/camera-driver.ts', [
  "import type { MapLibreMapInstance } from './loader'",
  'export function drive(map: MapLibreMapInstance) { map.jumpTo({}); map.flyTo({}); map.stop(); map.resize() }',
])

describe('canvas v2 policies', () => {
  it('P1 rejects camera moves and resizes on a map outside the camera driver and the World map components', () => {
    const graph = createTypeScriptSourceGraph([
      PLANTED_MAP_LOADER,
      PLANTED_CAMERA_DRIVER,
      plantedSource('src/maplibre/planted.ts', [
        'instance.easeTo({ zoom: 3 });',
        'this.mapInstance.jumpTo({ zoom: 3 });',
        'map.flyTo!({ zoom: 3 });',
        'map.resetNorth();',
        'this.map!.zoomIn();',
        'workspaceMap?.resize();',
        'map?.stop();',
        'surface.resetNorth();',
        'commands.viewport.zoomIn();',
        'this.options.cameraNavigation.panBy(1, 2);',
        'raster.stop();',
      ]),
      plantedSource('src/components/world-map/WorldMapSurface.tsx', ['map.flyTo({ zoom: 3 }); map.fitBounds(b); map.resize()']),
      plantedSource('src/maplibre/world-map.ts', ['map.jumpTo({ zoom: 3 })']),
      plantedSource('src/maplibre/camera-driver.test.ts', ['map.jumpTo({ zoom: 3 }); map.stop()']),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P1'))).toEqual([
      `${P1_CAMERA_METHODS} src/maplibre/planted.ts:1 calls instance.easeTo`,
      `${P1_CAMERA_METHODS} src/maplibre/planted.ts:2 calls this.mapInstance.jumpTo`,
      `${P1_CAMERA_METHODS} src/maplibre/planted.ts:3 calls map.flyTo!`,
      `${P1_CAMERA_METHODS} src/maplibre/world-map.ts:1 calls map.jumpTo`,
      `${P1_MAP_RECEIVERS} src/maplibre/planted.ts:4 calls map.resetNorth`,
      `${P1_MAP_RECEIVERS} src/maplibre/planted.ts:5 calls this.map!.zoomIn`,
      `${P1_MAP_RECEIVERS} src/maplibre/planted.ts:6 calls workspaceMap?.resize`,
      `${P1_MAP_RECEIVERS} src/maplibre/planted.ts:7 calls map?.stop`,
    ])
  })

  it('P1 fails closed when the camera driver stops importing the map type or moves', () => {
    const untyped = createTypeScriptSourceGraph([
      PLANTED_MAP_LOADER,
      plantedSource('src/maplibre/camera-driver.ts', ['export function drive(map: { stop(): void }) { map.stop() }']),
    ])
    const moved = createTypeScriptSourceGraph([
      PLANTED_MAP_LOADER,
      plantedSource('src/maplibre/map-camera.ts', ["import type { MapLibreMapInstance } from './loader'"]),
    ])

    expect(collectArchitecturePolicyViolations(untyped, canvasV2Policies('P1'))).toEqual([
      `${P1_MAP_TYPE} src/maplibre/camera-driver.ts is missing required import matching src/maplibre/loader.ts`,
    ])
    expect(collectArchitecturePolicyViolations(moved, canvasV2Policies('P1'))).toEqual([
      `${P1_MAP_TYPE} required policy source is missing: src/maplibre/camera-driver.ts`,
    ])
  })

  it('P2 rejects map projections everywhere but tests, the World map included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/maplibre/planted.ts', [
        'map.project([1, 2]);',
        'this.map?.unproject([1, 2]);',
        'workspaceMap!.project([1, 2]);',
        'plane.project(point);',
        'input.project(point);',
      ]),
      plantedSource('src/maplibre/shared-scene-layer.ts', ['map!.project([1, 2])']),
      plantedSource('src/components/world-map/WorldMapSurface.tsx', ['map.project([1, 2])']),
      plantedSource('src/maplibre/camera-driver.test.ts', ['map.unproject([1, 2])']),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P2'))).toEqual([
      `${P2} src/maplibre/planted.ts:1 calls map.project`,
      `${P2} src/maplibre/planted.ts:2 calls this.map?.unproject`,
      `${P2} src/maplibre/planted.ts:3 calls workspaceMap!.project`,
      `${P2} src/maplibre/shared-scene-layer.ts:1 calls map!.project`,
      `${P2} src/components/world-map/WorldMapSurface.tsx:1 calls map.project`,
    ])
  })

  it('P3 rejects the retired camera symbols anywhere, tests included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/view/planted.ts', [
        'export const transform = buildViewTransformFromPlane(plane, viewCameraToPlanar(camera))',
        'export const moved = panPlanar(zoomPlanarToScale(camera, 4), 1, 2)',
        '// CameraController and SceneViewportState in a comment are not identifiers',
      ]),
      plantedSource('src/app/planted.test.ts', [
        'const camera = new CameraController()',
        'export const snapshot: CameraViewportSnapshot = camera.snapshot',
        "export const name = 'legacyCamera in a string is not an identifier'",
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P3'))).toEqual([
      `${P3_SYMBOLS} src/canvas/runtime/view/planted.ts contains forbidden symbol buildViewTransformFromPlane`,
      `${P3_SYMBOLS} src/canvas/runtime/view/planted.ts contains forbidden symbol viewCameraToPlanar`,
      `${P3_SYMBOLS} src/canvas/runtime/view/planted.ts contains forbidden symbol panPlanar`,
      `${P3_SYMBOLS} src/canvas/runtime/view/planted.ts contains forbidden symbol zoomPlanarToScale`,
      `${P3_SYMBOLS} src/app/planted.test.ts contains forbidden symbol CameraController`,
      `${P3_SYMBOLS} src/app/planted.test.ts contains forbidden symbol CameraViewportSnapshot`,
    ])
  })

  it('P3 rejects a free world-to-screen export, the view transform module included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/view/view-transform.ts', [
        'export function worldToScreen(p: number) { return p }',
        'export function screenToWorld(p: number) { return p }',
      ]),
      plantedSource('src/canvas/runtime/annotation-layout.ts', [
        'export function worldToScreen(p: number) { return p }',
      ]),
      plantedSource('src/canvas/projection.ts', [
        'const screenToWorld = (p: number) => p',
        'export { screenToWorld }',
      ]),
      plantedSource('src/canvas/runtime/view/types.ts', [
        'export interface ViewTransform { worldToScreen(p: number): number }',
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P3'))).toEqual([
      `${P3_EXPORTS} src/canvas/runtime/view/view-transform.ts exports forbidden symbol worldToScreen`,
      `${P3_EXPORTS} src/canvas/runtime/view/view-transform.ts exports forbidden symbol screenToWorld`,
      `${P3_EXPORTS} src/canvas/runtime/annotation-layout.ts exports forbidden symbol worldToScreen`,
      `${P3_EXPORTS} src/canvas/projection.ts exports forbidden symbol screenToWorld`,
    ])
  })

  it('P3 confines building a view transform to the view module, the lens and tests', () => {
    const allowed = [
      'src/canvas/runtime/view/**',
      'src/canvas/runtime/inspection-lens.ts',
      ...TEST_SOURCE_PATTERNS,
    ].join(', ')
    const build = ['export const view = buildViewTransform(camera, screen, plane)']
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/view/headless-driver.ts', build),
      plantedSource('src/canvas/runtime/inspection-lens.ts', build),
      plantedSource('src/__tests__/support/test-view.ts', build),
      plantedSource('src/app/canvas-map-surface/planted.ts', build),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P3'))).toEqual([
      `${P3_BUILDER} src/app/canvas-map-surface/planted.ts contains confined symbol buildViewTransform; allowed sources: ${allowed}`,
    ])
  })

  it('P4 rejects view imports other than its pure dependencies', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/projection.ts', ['export const project = 1']),
      plantedSource('src/canvas/session-plane.ts', ['export const plane = 1']),
      plantedSource('src/canvas/workspace-camera-policy.ts', ['export const policy = 1']),
      plantedSource('src/canvas/runtime/scene/types.ts', ['export interface ScenePlantEntity { readonly id: string }']),
      plantedSource('src/canvas/runtime/scene/index.ts', ["export * from './types'"]),
      plantedSource('src/maplibre/loader.ts', ['export const load = 1']),
      plantedSource('src/canvas/runtime/view/types.ts', ['export const frame = 1']),
      plantedSource('src/canvas/runtime/view/fit.ts', [
        "import { project } from '../../projection'",
        "import { plane } from '../../session-plane'",
        "import { policy } from '../../workspace-camera-policy'",
        "import type { ScenePlantEntity } from '../scene/types'",
        "import { signal } from '@preact/signals'",
        "import { frame } from './types'",
      ]),
      plantedSource('src/canvas/runtime/view/planted.ts', [
        "import maplibregl from 'maplibre-gl'",
        "import { load } from '../../../maplibre/loader'",
        "import { ScenePlantEntity } from '../scene/types'",
        "import type { ScenePlantEntity as Barrel } from '../scene'",
        "import { Application } from 'pixi.js'",
      ]),
      plantedSource('src/canvas/runtime/view/camera-contract.test.ts', [
        "import { MercatorTransform } from 'maplibre-gl-source/geo/projection/mercator_transform.ts'",
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P4'))).toEqual([
      `${P4_IMPORTS} src/canvas/runtime/view/planted.ts:1:1 imports maplibre-gl via "maplibre-gl" (static)`,
      `${P4_IMPORTS} src/canvas/runtime/view/planted.ts:2:1 imports src/maplibre/loader.ts via "../../../maplibre/loader" (static)`,
      `${P4_IMPORTS} src/canvas/runtime/view/planted.ts:3:1 imports src/canvas/runtime/scene/types.ts via "../scene/types" (static)`,
      `${P4_IMPORTS} src/canvas/runtime/view/planted.ts:4:1 imports src/canvas/runtime/scene/index.ts via "../scene" (static)`,
      `${P4_IMPORTS} src/canvas/runtime/view/planted.ts:5:1 imports pixi.js via "pixi.js" (static)`,
    ])
  })
})

describe('canvas v2 policies, end of 0B', () => {
  it('P5 rejects tool imports of MapLibre, Pixi, signals, the app, input, the view, renderers, chrome and the ports', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/maplibre/loader.ts', ['export const load = 1']),
      plantedSource('src/app/keyboard/arming.ts', ['export const arm = 1']),
      plantedSource('src/components/canvas/ToolCard.tsx', ['export const card = 1']),
      plantedSource('src/canvas/runtime/view/types.ts', ['export interface ViewFrame { readonly scale: number }']),
      plantedSource('src/canvas/runtime/view/navigation.ts', ['export const navigate = 1']),
      plantedSource('src/canvas/runtime/input/input-router.ts', ['export const route = 1']),
      plantedSource('src/canvas/runtime/renderers/draft-layer.ts', ['export const draw = 1']),
      plantedSource('src/canvas/runtime/chrome/handle-layer.ts', ['export const handles = 1']),
      plantedSource('src/canvas/runtime/interaction-ports.ts', ['export const ports = 1']),
      plantedSource('src/canvas/runtime/interaction-types.ts', ['export interface ToolPoint { readonly x: number }']),
      plantedSource('src/canvas/runtime/tools/planted.ts', [
        "import maplibregl from 'maplibre-gl'",
        "import { Graphics } from 'pixi.js'",
        "import { signal } from '@preact/signals'",
        "import { load } from '../../../maplibre/loader'",
        "import { arm } from '../../../app/keyboard/arming'",
        "import { card } from '../../../components/canvas/ToolCard'",
        "import { navigate } from '../view/navigation'",
        "import { ViewFrame } from '../view/types'",
        "import { route } from '../input/input-router'",
        "import { draw } from '../renderers/draft-layer'",
        "import { handles } from '../chrome/handle-layer'",
        "import { ports } from '../interaction-ports'",
      ]),
      plantedSource('src/canvas/runtime/tools/polygon.ts', [
        "import type { ViewFrame } from '../view/types'",
        "import type { ToolPoint } from '../interaction-types'",
      ]),
      plantedSource('src/canvas/runtime/tools/tool-host.ts', [
        "import { signal } from '@preact/signals'",
        "import { route } from '../input/input-router'",
      ]),
      plantedSource('src/canvas/runtime/tools/pan.test.ts', ["import { route } from '../input/input-router'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P5'))).toEqual([
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:1:1 imports maplibre-gl via "maplibre-gl" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:2:1 imports pixi.js via "pixi.js" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:3:1 imports @preact/signals via "@preact/signals" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:4:1 imports src/maplibre/loader.ts via "../../../maplibre/loader" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:5:1 imports src/app/keyboard/arming.ts via "../../../app/keyboard/arming" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:6:1 imports src/components/canvas/ToolCard.tsx via "../../../components/canvas/ToolCard" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:7:1 imports src/canvas/runtime/view/navigation.ts via "../view/navigation" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:8:1 imports src/canvas/runtime/view/types.ts via "../view/types" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:9:1 imports src/canvas/runtime/input/input-router.ts via "../input/input-router" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:10:1 imports src/canvas/runtime/renderers/draft-layer.ts via "../renderers/draft-layer" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:11:1 imports src/canvas/runtime/chrome/handle-layer.ts via "../chrome/handle-layer" (static)`,
      `${P5_IMPORTS} src/canvas/runtime/tools/planted.ts:12:1 imports src/canvas/runtime/interaction-ports.ts via "../interaction-ports" (static)`,
    ])
  })

  it('P5 confines DOM, event and camera names in tools to the tool host', () => {
    // One tool reaching every name of P5: dropping any name from the rule drops its line here.
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/tools/planted.ts', [
        'export function planted(event: PointerEvent, key: KeyboardEvent, element: HTMLElement) {',
        '  const box = element.getBoundingClientRect()',
        '  window.addEventListener(key.type, () => requestAnimationFrame(() => document.title = `${event.clientX - box.x}`))',
        '}',
        'export interface Planted { readonly view: ViewTransform; readonly driver: CameraDriver; readonly nav: ViewNavigation }',
      ]),
      plantedSource('src/canvas/runtime/tools/tool-host.ts', [
        'export function toWorld(event: PointerEvent, view: ViewTransform) { return event.clientX * view.scale }',
      ]),
      plantedSource('src/canvas/runtime/tools/polygon.test.ts', ['document.body.dispatchEvent(new PointerEvent("pointerdown"))']),
      plantedSource('src/canvas/point-editor/layout.ts', ['export const dotAt = (view: ViewTransform) => view.scale']),
      plantedSource('src/canvas/point-editor/layout.test.ts', ['window.dispatchEvent(new PointerEvent("pointerdown"))']),
    ])

    const allowed = `allowed sources: src/canvas/runtime/tools/tool-host.ts, ${TEST_SOURCES}`
    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P5'))).toEqual([
      ...P5_DOM_AND_CAMERA_NAMES.map(
        (name) => `${P5_SYMBOLS} src/canvas/runtime/tools/planted.ts contains confined symbol ${name}; ${allowed}`,
      ),
      `${P5_SYMBOLS} src/canvas/point-editor/layout.ts contains confined symbol ViewTransform; ${allowed}`,
    ])
  })

  it('P5b rejects value imports of a tool module outside tools/ and of a tool other than the host from the session', () => {
    const graph = runtimeGraph(createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/tools/tool.ts', ['export interface Tool { readonly id: string }']),
      plantedSource('src/canvas/runtime/tools/polygon.ts', ["import type { Tool } from './tool'", 'export const polygon = 1']),
      plantedSource('src/canvas/runtime/tools/tool-host.ts', ["import { polygon } from './polygon'", 'export const host = 1']),
      plantedSource('src/canvas/runtime/input/input-router.ts', [
        "import { polygon } from '../tools/polygon'",
        "import type { Tool } from '../tools/tool'",
      ]),
      plantedSource('src/canvas/runtime/interaction-session.ts', [
        "import { host } from './tools/tool-host'",
        "import { polygon } from './tools/polygon'",
      ]),
      plantedSource('src/canvas/runtime/tools/polygon.test.ts', ["import { polygon } from './polygon'"]),
    ]))
    const allowed = `src/canvas/runtime/tools/**, src/canvas/runtime/interaction-session.ts, ${TEST_SOURCES}`

    expect(collectArchitecturePolicyViolations(graph, TOOL_HOST_RUNTIME_GRAPH_POLICIES)).toEqual([
      `${P5B_IMPORTERS} src/canvas/runtime/input/input-router.ts:1:1 imports src/canvas/runtime/tools/polygon.ts via "../tools/polygon" (static); allowed importers: ${allowed}`,
      `${P5B_SESSION} src/canvas/runtime/interaction-session.ts:2:1 imports src/canvas/runtime/tools/polygon.ts via "./tools/polygon" (static)`,
    ])
  })

  it('P5c rejects MapLibre and Pixi reached from a tool through helpers, type-only edges included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/maplibre/loader.ts', ['export interface MapLibreMapInstance { stop(): void }']),
      plantedSource('src/canvas/runtime/helper.ts', ["import { Graphics } from 'pixi.js'", 'export const helper = 1']),
      plantedSource('src/canvas/runtime/legacy-shim.ts', [
        "import type { MapLibreMapInstance } from '../../maplibre/loader'",
        'export type Shim = MapLibreMapInstance',
      ]),
      plantedSource('src/canvas/runtime/runtime.ts', ["export type { Shim } from './legacy-shim'"]),
      plantedSource('src/canvas/runtime/tools/tool.ts', ["import type { Shim } from '../runtime'"]),
      plantedSource('src/canvas/runtime/tools/polygon.ts', ["import { helper } from '../helper'"]),
      plantedSource('src/canvas/runtime/tools/tool-host.ts', ["import type { MapLibreMapInstance } from '../../../maplibre/loader'"]),
      plantedSource('src/canvas/runtime/tools/polygon.test.ts', ["import maplibregl from 'maplibre-gl'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P5c'))).toEqual([
      `${P5C} src/canvas/runtime/tools/tool.ts transitively imports src/maplibre/loader.ts via src/canvas/runtime/tools/tool.ts -> src/canvas/runtime/runtime.ts -> src/canvas/runtime/legacy-shim.ts -> src/maplibre/loader.ts`,
      `${P5C} src/canvas/runtime/tools/polygon.ts transitively imports pixi.js via src/canvas/runtime/tools/polygon.ts -> src/canvas/runtime/helper.ts -> pixi.js`,
      `${P5C} src/canvas/runtime/tools/tool-host.ts transitively imports src/maplibre/loader.ts via src/canvas/runtime/tools/tool-host.ts -> src/maplibre/loader.ts`,
    ])
  })

  it('P6 confines pointer capture and canvas listeners to the DOM input source and the named element owners', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/planted.ts', [
        'export function planted(host: HTMLElement) {',
        "  host.addEventListener('pointerdown', (event) => host.setPointerCapture(event.pointerId))",
        '  host.releasePointerCapture(1)',
        '}',
      ]),
      plantedSource('src/canvas/planted-source.ts', ["window.addEventListener('wheel', () => {})"]),
      plantedSource('src/canvas/runtime/input/dom-input-source.ts', [
        "host.addEventListener('pointerdown', () => {}); host.setPointerCapture(1); host.releasePointerCapture(1)",
      ]),
      plantedSource('src/canvas/runtime/chrome/handle-layer.ts', ["element.addEventListener('pointerenter', () => {})"]),
      plantedSource('src/canvas/runtime/chrome/text-entry-host.ts', ["textarea.addEventListener('blur', () => {})"]),
      plantedSource('src/canvas/runtime/inspection-lens.ts', ["document.fonts?.addEventListener('loadingdone', () => {})"]),
      plantedSource('src/maplibre/workspace-map.ts', ["container.addEventListener('pointerdown', () => {})"]),
      plantedSource('src/maplibre/view-snapshot-map.ts', ["signal.addEventListener('abort', () => {})"]),
      plantedSource('src/canvas/runtime/planted.test.ts', ['host.setPointerCapture(1); host.addEventListener("pointerup", () => {})']),
    ])
    const listenerOwners = [
      'src/canvas/runtime/input/dom-input-source.ts',
      'src/canvas/runtime/input/selection-drag-guard.ts',
      'src/canvas/runtime/chrome/text-entry-host.ts',
      'src/canvas/runtime/chrome/handle-layer.ts',
      'src/canvas/runtime/inspection-lens.ts',
      ...TEST_SOURCE_PATTERNS,
    ].join(', ')
    const captureOwners = `src/canvas/runtime/input/dom-input-source.ts, ${TEST_SOURCES}`
    const abortOwners = `src/maplibre/view-snapshot-map.ts, src/maplibre/satellite-provider-session.ts, ${TEST_SOURCES}`

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P6'))).toEqual([
      `${P6_CAPTURE} src/canvas/runtime/planted.ts contains confined symbol setPointerCapture; allowed sources: ${captureOwners}`,
      `${P6_CAPTURE} src/canvas/runtime/planted.ts contains confined symbol releasePointerCapture; allowed sources: ${captureOwners}`,
      `${P6_LISTENERS} src/canvas/runtime/planted.ts contains confined symbol addEventListener; allowed sources: ${listenerOwners}`,
      `${P6_LISTENERS} src/canvas/planted-source.ts contains confined symbol addEventListener; allowed sources: ${listenerOwners}`,
      `${P6_MAPLIBRE} src/maplibre/workspace-map.ts contains confined symbol addEventListener; allowed sources: ${abortOwners}`,
    ])
  })

  it('P7 confines browser globals and DOM events in the input core to the DOM input source', () => {
    // One input module reaching every name of P7: dropping any name from the rule drops its line here.
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/input/recognise.ts', [
        'export function recognise(event: PointerEvent | WheelEvent) {',
        '  setTimeout(() => {}, Date.now() - performance.now())',
        '  return window.devicePixelRatio + document.title.length + navigator.maxTouchPoints + event.timeStamp',
        '}',
      ]),
      plantedSource('src/canvas/runtime/input/normalise.ts', [
        '// Time arrives as an input: no Date, performance or setTimeout here.',
        'export function normalise(raw: { readonly timeStamp: number }, now: () => number) { return now() - raw.timeStamp }',
      ]),
      plantedSource('src/canvas/runtime/input/dom-input-source.ts', [
        "export function install(event: PointerEvent) { window.addEventListener('blur', () => performance.now()) }",
      ]),
      plantedSource('src/canvas/runtime/input/recognise.test.ts', ['new PointerEvent("pointerdown"); Date.now()']),
    ])

    const confined = ['window', 'document', 'Date', 'performance', 'setTimeout', 'navigator', 'PointerEvent', 'WheelEvent']
    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P7'))).toEqual(
      confined.map(
        (name) =>
          `${P7} src/canvas/runtime/input/recognise.ts contains confined symbol ${name}; allowed sources: src/canvas/runtime/input/dom-input-source.ts, ${TEST_SOURCES}`,
      ),
    )
  })

  it('P12 confines per-point projection in the renderers to the billboards and the billboard drafts', () => {
    // One world-layer module reaching every name of P12: dropping any name from the rule drops its line here.
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/renderers/world-layers.ts', [
        'export function paint(view: RendererView, quad: WorldQuad, out: Float64Array) {',
        '  view.projectAnchors(new Float64Array(2), out, 1)',
        '  return [view.worldToScreen({ x: 0, y: 0 }), view.worldQuadToScreen(quad)]',
        '}',
      ]),
      plantedSource('src/canvas/runtime/renderers/billboard-layer.ts', [
        'export function place(view: RendererView, out: Float64Array) { view.projectAnchors(out, out, 1); view.worldToScreen({ x: 0, y: 0 }) }',
      ]),
      plantedSource('src/canvas/runtime/renderers/draft-layer.ts', ['export function draft(at: RendererView, out: Float64Array) { at.projectAnchors(out, out, 1) }']),
      plantedSource('src/canvas/runtime/renderers/world-layers.test.ts', ['view.worldToScreen({ x: 0, y: 0 })']),
      plantedSource('src/canvas/runtime/chrome/handle-layer.ts', ['export function place(view: RendererView) { return view.worldToScreen({ x: 0, y: 0 }) }']),
    ])
    const allowed = [
      'src/canvas/runtime/renderers/billboard-layer.ts',
      'src/canvas/runtime/renderers/draft-layer.ts',
      ...TEST_SOURCE_PATTERNS,
    ].join(', ')

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P12'))).toEqual(
      ['worldToScreen', 'projectAnchors', 'worldQuadToScreen'].map(
        (name) => `${P12} src/canvas/runtime/renderers/world-layers.ts contains confined symbol ${name}; allowed sources: ${allowed}`,
      ),
    )
  })

  it('P10 confines per-frame view signals to the runtime, the map layer and tests', () => {
    const allowed = ['src/canvas/runtime/**', 'src/maplibre/**', ...TEST_SOURCE_PATTERNS].join(', ')
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/scene-runtime/effects.ts', ['export const read = frames.viewFrame.value']),
      plantedSource('src/maplibre/shared-scene-layer.ts', ['export const read = frames.viewFrame.value']),
      plantedSource('src/components/canvas/Planted.tsx', ['export const read = query.viewFrame.value']),
      plantedSource('src/app/planted.ts', ['export const off = frames.onViewFrame(() => frames.settledViewFrame.value)']),
      plantedSource('src/components/canvas/Planted.test.tsx', ['export const read = query.viewFrame.value']),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P10'))).toEqual([
      `${P10_SIGNALS} src/components/canvas/Planted.tsx contains confined symbol viewFrame; allowed sources: ${allowed}`,
      `${P10_SIGNALS} src/app/planted.ts contains confined symbol settledViewFrame; allowed sources: ${allowed}`,
      `${P10_SIGNALS} src/app/planted.ts contains confined symbol onViewFrame; allowed sources: ${allowed}`,
    ])
  })

  it('P10 rejects value imports of the view module and type imports beyond its read surface, types and driver host', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/view/types.ts', ['export interface ViewScreen { readonly width: number }']),
      plantedSource('src/canvas/runtime/view/read-surface.ts', ['export interface ViewReadSurface { readonly x: number }']),
      plantedSource('src/canvas/runtime/view/camera-driver.ts', ['export interface CameraDriverHost { readonly x: number }']),
      plantedSource('src/canvas/runtime/view/driver-host.ts', ['export function createCameraDriverHost() {}']),
      plantedSource('src/canvas/runtime/view/camera-math.ts', ['export interface Placement { readonly x: number }']),
      plantedSource('src/app/canvas-map-surface/workspace-activation.ts', [
        "import type { CameraDriverHost } from '../../canvas/runtime/view/camera-driver'",
        "import type { ViewScreen } from '../../canvas/runtime/view/types'",
        "import type { ViewReadSurface } from '../../canvas/runtime/view/read-surface'",
      ]),
      plantedSource('src/app/canvas-map-surface/planted.ts', [
        "import { createCameraDriverHost } from '../../canvas/runtime/view/driver-host'",
        "import type { Placement } from '../../canvas/runtime/view/camera-math'",
      ]),
      plantedSource('src/components/canvas/Planted.tsx', ["import { ViewScreen } from '../../canvas/runtime/view/types'"]),
      plantedSource('src/web/planted.test.ts', ["import { createCameraDriverHost } from '../canvas/runtime/view/driver-host'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P10'))).toEqual([
      `${P10_IMPORTS} src/app/canvas-map-surface/planted.ts:1:1 imports src/canvas/runtime/view/driver-host.ts via "../../canvas/runtime/view/driver-host" (static)`,
      `${P10_IMPORTS} src/app/canvas-map-surface/planted.ts:2:1 imports src/canvas/runtime/view/camera-math.ts via "../../canvas/runtime/view/camera-math" (static)`,
      `${P10_IMPORTS} src/components/canvas/Planted.tsx:1:1 imports src/canvas/runtime/view/types.ts via "../../canvas/runtime/view/types" (static)`,
    ])
  })

  it('P11 rejects the retired tool adapter seam, its symbols and scene-interaction.ts', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/scene-interaction.ts', ['export const session = 1']),
      plantedSource('src/canvas/runtime/tools/planted.ts', [
        'export interface SceneToolAdapter { onPointerDown(event: SceneToolPointerEvent): void }',
        'export type SceneToolPointerEvent = { readonly x: number }',
        'export type Frame = SceneInteractionFrame & SceneInteractionFrameHandlers',
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, SOURCE_TOMBSTONE_POLICIES)).toEqual([
      `${P11} retired source still exists: src/canvas/runtime/scene-interaction.ts`,
      `${P11} src/canvas/runtime/tools/planted.ts contains retired symbol SceneToolAdapter`,
      `${P11} src/canvas/runtime/tools/planted.ts contains retired symbol SceneToolPointerEvent`,
      `${P11} src/canvas/runtime/tools/planted.ts contains retired symbol SceneInteractionFrame`,
      `${P11} src/canvas/runtime/tools/planted.ts contains retired symbol SceneInteractionFrameHandlers`,
    ])
  })

  it('P11 rejects the retired camera files and the shim and planar camera symbols', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/legacy-camera-facade.ts', ['export const facade = 1']),
      plantedSource('src/canvas/runtime/camera.ts', ['export const camera = 1']),
      plantedSource('src/maplibre/workspace-camera.ts', ['export const shim = 1']),
      plantedSource('src/canvas/runtime/renderers/viewport-presentation.ts', ['export const presentation = 1']),
      plantedSource('src/canvas/runtime/view/planted.ts', [
        'export const HOLD_NOISE_DEG = 1e-9',
        'export function refreshOrigin() { return getAnnotationScreenFrame() }',
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, SOURCE_TOMBSTONE_POLICIES)).toEqual([
      `${P11} retired source still exists: src/canvas/runtime/legacy-camera-facade.ts`,
      `${P11} retired source still exists: src/canvas/runtime/camera.ts`,
      `${P11} retired source still exists: src/maplibre/workspace-camera.ts`,
      `${P11} retired source still exists: src/canvas/runtime/renderers/viewport-presentation.ts`,
      `${P11} src/canvas/runtime/view/planted.ts contains retired symbol refreshOrigin`,
      `${P11} src/canvas/runtime/view/planted.ts contains retired symbol HOLD_NOISE_DEG`,
      `${P11} src/canvas/runtime/view/planted.ts contains retired symbol getAnnotationScreenFrame`,
    ])
  })

  it('P11 rejects the retired focus regions, shortcut managers, focusMapSurface, the free focusRegion and LEGACY_BINDINGS', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/shell/focus-regions.ts', ['export const regions = 1']),
      plantedSource('src/shortcuts/manager.ts', ['export const manager = 1']),
      plantedSource('src/web/canvas-shortcuts.ts', ['export const shortcuts = 1']),
      plantedSource('src/components/plant-db/planted.ts', [
        'export function focusRegion(id: string) { return id }',
        "focusRegion('map')",
        'export function focusMapSurface() {}',
      ]),
      plantedSource('src/canvas/runtime/input/planted.test.ts', ['export const legacy = LEGACY_BINDINGS']),
      // The focus owner's method keeps the name: a declaration, an object method and a call on the owner pass.
      plantedSource('src/app/keyboard/focus-owner.ts', [
        "export interface FocusOwner { focusRegion(region: string, reason: string): void }",
        "export const focusOwner: FocusOwner = { focusRegion(region) { return void region } }",
        "focusOwner.focusRegion('map', 'region-cycle')",
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, SOURCE_TOMBSTONE_POLICIES)).toEqual([
      `${P11} retired source still exists: src/app/shell/focus-regions.ts`,
      `${P11} retired source still exists: src/shortcuts/manager.ts`,
      `${P11} retired source still exists: src/web/canvas-shortcuts.ts`,
      `${P11} src/components/plant-db/planted.ts contains retired symbol focusMapSurface`,
      `${P11} src/canvas/runtime/input/planted.test.ts contains retired symbol LEGACY_BINDINGS`,
      `${P11_FOCUS_REGION_CALL} src/components/plant-db/planted.ts:2 calls focusRegion`,
      `${P11_FOCUS_REGION_EXPORT} src/components/plant-db/planted.ts exports forbidden symbol focusRegion`,
    ])
  })

  it('P11 rejects the retired bindings module, Bindings, CURRENT_BINDINGS, PanContext and the input pipeline\'s bindings field', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/input/bindings.ts', ['export const touch = 1']),
      plantedSource('src/canvas/runtime/input/planted.test.ts', [
        'export const config: Bindings = CURRENT_BINDINGS',
        "export type Pan = PanContext",
      ]),
      plantedSource('src/canvas/runtime/interaction-ports.ts', [
        'export interface DomInputSourceDeps { readonly bindings: () => number }',
      ]),
      // The name stays free outside the input pipeline.
      plantedSource('src/__tests__/planted-duckdb.test.ts', ['export const bindings = 1']),
    ])

    expect(collectArchitecturePolicyViolations(graph, SOURCE_TOMBSTONE_POLICIES)).toEqual([
      `${P11} retired source still exists: src/canvas/runtime/input/bindings.ts`,
      `${P11} src/canvas/runtime/input/planted.test.ts contains retired symbol Bindings`,
      `${P11} src/canvas/runtime/input/planted.test.ts contains retired symbol CURRENT_BINDINGS`,
      `${P11} src/canvas/runtime/input/planted.test.ts contains retired symbol PanContext`,
      `${P11} src/canvas/runtime/interaction-ports.ts contains retired symbol bindings`,
    ])
  })

  it('P11 rejects the retired scene chrome file and SceneChromeOverlay', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/scene-chrome.ts', ['export const chrome = 1']),
      plantedSource('src/canvas/runtime/scene-runtime/planted.ts', ['export class SceneChromeOverlay {}']),
    ])

    expect(collectArchitecturePolicyViolations(graph, SOURCE_TOMBSTONE_POLICIES)).toEqual([
      `${P11} retired source still exists: src/canvas/runtime/scene-chrome.ts`,
      `${P11} src/canvas/runtime/scene-runtime/planted.ts contains retired symbol SceneChromeOverlay`,
    ])
  })

  it('P9 rejects arming a tool outside armCanvasTool: a bare selectCanvasTool and a surface setTool', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/keyboard/arming.ts', [
        "import { setCurrentCanvasTool } from '../../canvas/session'",
        'export function armCanvasTool(tool: string) { setCurrentCanvasTool(tool); surface.setTool(tool) }',
      ]),
      plantedSource('src/canvas/session.ts', ['export function setCurrentCanvasTool(name: string) { setCanvasTool(name) }']),
      plantedSource('src/canvas/runtime/scene-runtime.ts', ['export const set = (name: string) => tools.setTool(name)']),
      plantedSource('src/components/canvas/Planted.tsx', [
        "selectCanvasTool('polygon')",
        "surface.setTool('line')",
        "tools?.setTool('select')",
        "commands!['setTool']('rectangle')",
      ]),
      plantedSource('src/canvas/planted-source.ts', ["commandSurface?.setTool('plant-stamp')"]),
      plantedSource('src/web/planted.test.ts', ["selectCanvasTool('polygon'); surface.setTool('line')"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P9').filter(({ kind }) => kind !== 'require-imports'))).toEqual([
      `${P9_SYMBOLS} src/components/canvas/Planted.tsx contains confined symbol selectCanvasTool; allowed sources: src/app/keyboard/arming.ts, src/canvas/session.ts, src/canvas/session-state.ts, src/canvas/runtime/command-surface.ts, ${TEST_SOURCES}`,
      `${P9_CALLS} src/app/keyboard/arming.ts:2 calls surface.setTool`,
      `${P9_CALLS} src/components/canvas/Planted.tsx:2 calls surface.setTool`,
      `${P9_CALLS} src/components/canvas/Planted.tsx:3 calls tools?.setTool`,
      `${P9_CALLS} src/components/canvas/Planted.tsx:4 calls commands!['setTool']`,
      `${P9_CALLS} src/canvas/planted-source.ts:1 calls commandSurface?.setTool`,
    ])
  })

  it('P9 fails when an arming caller stops importing armCanvasTool', () => {
    const callers = [
      'src/components/plant-db/place-species.ts',
      'src/components/canvas/SiteOnboarding.tsx',
      'src/components/canvas/StampChooser.tsx',
      'src/app/saved-object-stamps/workbench.ts',
    ]
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/keyboard/arming.ts', ['export function armCanvasTool(tool: string) { return tool }']),
      ...callers.map((path) => plantedSource(path, [
        `import { armCanvasTool } from '${'../'.repeat(path.split('/').length - 2)}app/keyboard/arming'`,
        "armCanvasTool('select')",
      ])),
      plantedSource('src/app/workspace-commands/canvas-actions.ts', ["export const selectTool = (tool: string) => tool"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P9').filter(({ kind }) => kind === 'require-imports'))).toEqual([
      `${P9_IMPORTS} src/app/workspace-commands/canvas-actions.ts is missing required import matching src/app/keyboard/arming.ts`,
    ])
  })

  it('P14 rejects keyboard imports of commands, Web, the platforms and components, not in tests', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/commands/registry.ts', ['export const registry = 1']),
      plantedSource('src/web/browser-shell-commands.ts', ['export const web = 1']),
      plantedSource('src/platform/desktop.ts', ['export const desktop = 1']),
      plantedSource('src/components/canvas/ToolRail.tsx', ['export const rail = 1']),
      plantedSource('src/app/shell-commands/index.ts', ['export const shell = 1']),
      plantedSource('src/app/keyboard/planted.ts', [
        "import { registry } from '../../commands/registry'",
        "import type { web } from '../../web/browser-shell-commands'",
        "import { desktop } from '../../platform/desktop'",
        "import { rail } from '../../components/canvas/ToolRail'",
        "import { shell } from '../shell-commands'",
      ]),
      plantedSource('src/app/keyboard/planted.test.ts', ["import { rail } from '../../components/canvas/ToolRail'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P14'))).toEqual([
      `${P14} src/app/keyboard/planted.ts:1:1 imports src/commands/registry.ts via "../../commands/registry" (static)`,
      `${P14} src/app/keyboard/planted.ts:2:1 imports src/web/browser-shell-commands.ts via "../../web/browser-shell-commands" (static)`,
      `${P14} src/app/keyboard/planted.ts:3:1 imports src/platform/desktop.ts via "../../platform/desktop" (static)`,
      `${P14} src/app/keyboard/planted.ts:4:1 imports src/components/canvas/ToolRail.tsx via "../../components/canvas/ToolRail" (static)`,
    ])
  })
})

const P39 = '[P39 production modules form no value import cycle]'
const P40 = '[P40 foundation layers import no app, component or edition code]'
const P41 = '[P41 canvas imports no native code]'
const P42 = '[P42 shared app code imports no Web edition module]'
const P43 = '[P43 the input core stays camera-free and app-free]'
const P44 = '[P44 settings and map-layer signals are written only by the projection]'
const P45 = '[P45 only the presentation controller writes story overrides]'
const P46 = '[P46 the Google key has reviewed readers]'
const P46B = '[P46b only the Satellite provider builds the Google key URLs]'
const P47 = '[P47 components never hold the canvas document lifecycle]'
const P48 = '[P48 the tool host is the only canvas-menu opener]'
const P49 = '[P49 only IPC transports invoke native commands]'
const P52 = '[P52 only the location button and the Web wiring import the location session]'
const P53 = '[P53 only the geolocation module calls watchPosition, getCurrentPosition or clearWatch]'

describe('2.0 guard policies (canopi-f47t.52.17)', () => {
  it('P39 rejects a production value cycle; type-only, dynamic and test cycles pass', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/planted/a.ts', ["import { b } from './b'", 'export const a = b']),
      plantedSource('src/app/planted/b.ts', ["export { a } from './a'", 'export const b = 1']),
      plantedSource('src/app/planted/type-a.ts', ["import type { B } from './type-b'", 'export type A = B']),
      plantedSource('src/app/planted/type-b.ts', ["import { type A } from './type-a'", 'export type B = A']),
      plantedSource('src/app/planted/lazy-a.ts', ["export const load = () => import('./lazy-b')"]),
      plantedSource('src/app/planted/lazy-b.ts', ["import { load } from './lazy-a'", 'void load']),
      plantedSource('src/app/planted/tested.ts', ["import './tested.test'"]),
      plantedSource('src/app/planted/tested.test.ts', ["import './tested'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P39'))).toEqual([
      `${P39} src/app/planted/a.ts is in a value import cycle with src/app/planted/b.ts`,
      `${P39} src/app/planted/b.ts is in a value import cycle with src/app/planted/a.ts`,
    ])
  })

  it('P40 rejects foundation imports of app values, components and edition code, but not app types or named exceptions', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/settings/state.ts', ['export const locale = 1', 'export type Locale = string']),
      plantedSource('src/components/shared/Chip.tsx', ['export const Chip = 1']),
      plantedSource('src/web/browser-app-data.ts', ['export const data = 1']),
      plantedSource('src/commands/registry.ts', ['export const registry = 1']),
      plantedSource('src/platform/desktop.ts', ['export const desktop = 1']),
      plantedSource('src/utils/planted.ts', [
        "import { locale } from '../app/settings/state'",
        "import type { Locale } from '../app/settings/state'",
        "import type { Chip } from '../components/shared/Chip'",
      ]),
      plantedSource('src/maplibre/planted.ts', ["import { data } from '../web/browser-app-data'"]),
      plantedSource('src/canvas/planted.ts', ["import { registry } from '../commands/registry'"]),
      plantedSource('src/canvas/edition.ts', [
        "import type { data } from '../web/browser-app-data'",
        "import { desktop } from '../platform/desktop'",
      ]),
      plantedSource('src/ipc/planted.ts', ["import { desktop } from '../platform/desktop'"]),
      // A transport may implement an app port's interface: only its types cross.
      plantedSource('src/ipc/transport.ts', [
        "import { locale } from '../app/settings/state'",
        "import type { Locale } from '../app/settings/state'",
      ]),
      plantedSource('src/i18n/planted.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/types/planted.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/generated/planted.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/target/planted.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/i18n/index.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/utils/theme.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/ipc/design.ts', ["import { locale } from '../app/settings/state'"]),
      plantedSource('src/utils/planted.test.ts', ["import { Chip } from '../components/shared/Chip'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P40'))).toEqual([
      `${P40} src/utils/planted.ts:1:1 imports src/app/settings/state.ts via "../app/settings/state" (static)`,
      `${P40} src/utils/planted.ts:3:1 imports src/components/shared/Chip.tsx via "../components/shared/Chip" (static)`,
      `${P40} src/maplibre/planted.ts:1:1 imports src/web/browser-app-data.ts via "../web/browser-app-data" (static)`,
      `${P40} src/canvas/planted.ts:1:1 imports src/commands/registry.ts via "../commands/registry" (static)`,
      `${P40} src/canvas/edition.ts:1:1 imports src/web/browser-app-data.ts via "../web/browser-app-data" (static)`,
      `${P40} src/canvas/edition.ts:2:1 imports src/platform/desktop.ts via "../platform/desktop" (static)`,
      `${P40} src/ipc/planted.ts:1:1 imports src/platform/desktop.ts via "../platform/desktop" (static)`,
      `${P40} src/ipc/transport.ts:1:1 imports src/app/settings/state.ts via "../app/settings/state" (static)`,
      `${P40} src/i18n/planted.ts:1:1 imports src/app/settings/state.ts via "../app/settings/state" (static)`,
      `${P40} src/types/planted.ts:1:1 imports src/app/settings/state.ts via "../app/settings/state" (static)`,
      `${P40} src/generated/planted.ts:1:1 imports src/app/settings/state.ts via "../app/settings/state" (static)`,
      `${P40} src/target/planted.ts:1:1 imports src/app/settings/state.ts via "../app/settings/state" (static)`,
    ])
  })

  it('P41 rejects canvas imports of IPC and Tauri code, but not the named species cache', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/ipc/species.ts', ['export const species = 1']),
      plantedSource('src/canvas/runtime/planted.ts', [
        "import { species } from '../../ipc/species'",
        "import { invoke } from '@tauri-apps/api/core'",
      ]),
      plantedSource('src/canvas/runtime/species-cache.ts', ["import { species } from '../../ipc/species'"]),
      plantedSource('src/canvas/runtime/planted.test.ts', ["import { species } from '../../ipc/species'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P41'))).toEqual([
      `${P41} src/canvas/runtime/planted.ts:1:1 imports src/ipc/species.ts via "../../ipc/species" (static)`,
      `${P41} src/canvas/runtime/planted.ts:2:1 imports @tauri-apps/api/core via "@tauri-apps/api/core" (static)`,
    ])
  })

  it('P42 rejects shared app imports of Web edition modules, but not the three named browser files', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/web/static-design-templates.ts', ['export const templates = 1']),
      plantedSource('src/app/planted/module.ts', ["import type { templates } from '../../web/static-design-templates'"]),
      plantedSource('src/app/community/catalog.browser.ts', ["import { templates } from '../../web/static-design-templates'"]),
      plantedSource('src/app/design-template-import/workflow.browser.ts', ["import { templates } from '../../web/static-design-templates'"]),
      plantedSource('src/app/plant-browser/browser-runtime.ts', ["import { templates } from '../../web/static-design-templates'"]),
      plantedSource('src/app/planted/module.test.ts', ["import { templates } from '../../web/static-design-templates'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P42'))).toEqual([
      `${P42} src/app/planted/module.ts:1:1 imports src/web/static-design-templates.ts via "../../web/static-design-templates" (static)`,
    ])
  })

  it('P43 rejects input imports of the scene, renderers, chrome, view values and the app, the DOM input source included', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/scene/index.ts', ['export const scene = 1']),
      plantedSource('src/canvas/runtime/renderers/layer.ts', ['export const layer = 1']),
      plantedSource('src/canvas/runtime/chrome/handle-layer.ts', ['export const handles = 1']),
      plantedSource('src/canvas/runtime/view/camera-driver.ts', ['export const driver = 1', 'export type Driver = number']),
      plantedSource('src/canvas/runtime/view/navigation-policy.ts', ['export const ROTATE_DEG_PER_PX = 1']),
      plantedSource('src/app/keyboard/arming.ts', ['export const arm = 1']),
      plantedSource('src/canvas/runtime/input/planted.ts', [
        "import { scene } from '../scene'",
        "import type { layer } from '../renderers/layer'",
        "import { handles } from '../chrome/handle-layer'",
        "import { driver } from '../view/camera-driver'",
        "import type { Driver } from '../view/camera-driver'",
        "import { ROTATE_DEG_PER_PX } from '../view/navigation-policy'",
        "import { arm } from '../../../app/keyboard/arming'",
      ]),
      plantedSource('src/canvas/runtime/input/dom-input-source.ts', ["import { driver } from '../view/camera-driver'"]),
      plantedSource('src/canvas/runtime/input/planted.test.ts', ["import { scene } from '../scene'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P43'))).toEqual([
      `${P43} src/canvas/runtime/input/planted.ts:1:1 imports src/canvas/runtime/scene/index.ts via "../scene" (static)`,
      `${P43} src/canvas/runtime/input/planted.ts:2:1 imports src/canvas/runtime/renderers/layer.ts via "../renderers/layer" (static)`,
      `${P43} src/canvas/runtime/input/planted.ts:3:1 imports src/canvas/runtime/chrome/handle-layer.ts via "../chrome/handle-layer" (static)`,
      `${P43} src/canvas/runtime/input/planted.ts:4:1 imports src/canvas/runtime/view/camera-driver.ts via "../view/camera-driver" (static)`,
      `${P43} src/canvas/runtime/input/planted.ts:7:1 imports src/app/keyboard/arming.ts via "../../../app/keyboard/arming" (static)`,
      `${P43} src/canvas/runtime/input/dom-input-source.ts:1:1 imports src/canvas/runtime/view/camera-driver.ts via "../view/camera-driver" (static)`,
    ])
  })

  it('P44 rejects a settings or map-layer signal write outside the projection, through a namespace too, not in tests', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/web/BrowserAppShell.tsx', ["locale.value = 'fr'", "theme.value = 'dark'"]),
      plantedSource('src/app/planted.ts', [
        'snapToGridEnabled.value = true',
        'sidePanelWidth.value += 10',
        'settings.googleMapsApiKey.value = null',
        'mapLayers.value = next',
        'scrollWheel.value++',
        "if (locale.value === 'fr') void 0",
      ]),
      plantedSource('src/app/settings/projection.ts', ["locale.value = 'fr'", 'mapLayers.value = next']),
      plantedSource('src/app/planted.test.ts', ["locale.value = 'fr'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P44'))).toEqual([
      `${P44} src/web/BrowserAppShell.tsx:1 writes locale.value = 'fr'`,
      `${P44} src/web/BrowserAppShell.tsx:2 writes theme.value = 'dark'`,
      `${P44} src/app/planted.ts:1 writes snapToGridEnabled.value = true`,
      `${P44} src/app/planted.ts:2 writes sidePanelWidth.value = 10`,
      `${P44} src/app/planted.ts:3 writes settings.googleMapsApiKey.value = null`,
      `${P44} src/app/planted.ts:4 writes mapLayers.value = next`,
      `${P44} src/app/planted.ts:5 writes scrollWheel.value = ++`,
    ])
  })

  it('P45 confines the story override setters to the presentation controller, the overrides module and tests', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/story-presentation/overrides.ts', [
        'export function setStoryPresentationOverrides() {}',
        'export function setStoryPresentationHidesEditingAids() {}',
      ]),
      plantedSource('src/app/story-presentation/controller.ts', [
        "import { setStoryPresentationOverrides, setStoryPresentationHidesEditingAids } from './overrides'",
        'setStoryPresentationOverrides(null); setStoryPresentationHidesEditingAids(false)',
      ]),
      plantedSource('src/app/canvas-map-surface/planted.ts', [
        "import { setStoryPresentationOverrides } from '../story-presentation/overrides'",
        'setStoryPresentationOverrides(null)',
      ]),
      plantedSource('src/components/panels/Planted.tsx', [
        "import * as overrides from '../../app/story-presentation/overrides'",
        'overrides.setStoryPresentationHidesEditingAids(true)',
      ]),
      plantedSource('src/__tests__/planted.test.ts', [
        "import { setStoryPresentationOverrides } from '../app/story-presentation/overrides'",
        'setStoryPresentationOverrides(null)',
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P45'))).toEqual([
      `${P45} src/app/canvas-map-surface/planted.ts contains confined symbol setStoryPresentationOverrides; allowed sources: src/app/story-presentation/controller.ts, src/app/story-presentation/overrides.ts, ${TEST_SOURCES}`,
      `${P45} src/components/panels/Planted.tsx contains confined symbol setStoryPresentationHidesEditingAids; allowed sources: src/app/story-presentation/controller.ts, src/app/story-presentation/overrides.ts, ${TEST_SOURCES}`,
    ])
  })

  it('P46 rejects a Google key or settings snapshot import outside its reviewed readers, by name, namespace, re-export or dynamic import', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/settings/state.ts', [
        'export const googleMapsApiKey = 1',
        'export const activeGoogleMapsApiKey = 1',
        'export const locale = 1',
      ]),
      plantedSource('src/app/settings/projection.ts', [
        "import { googleMapsApiKey } from './state'",
        'export function snapshotSettingsProjection() { return googleMapsApiKey }',
        'export function mutateSettingsProjection() {}',
      ]),
      plantedSource('src/app/planted.ts', [
        "import { locale, activeGoogleMapsApiKey } from './settings/state'",
        "import { snapshotSettingsProjection, mutateSettingsProjection } from './settings/projection'",
        "import * as settings from './settings/state'",
        "import { locale as language } from './settings/state'",
        "import { mutateSettingsProjection as mutate } from './settings/projection'",
      ]),
      plantedSource('src/components/shared/Planted.tsx', [
        "export { googleMapsApiKey } from '../../app/settings/state'",
      ]),
      plantedSource('src/app/dynamic.ts', [
        "export const key = async () => (await import('./settings/state')).googleMapsApiKey",
        "export const snapshot = async () => { const { snapshotSettingsProjection: s } = await import('./settings/projection'); return s }",
        "export const active = import('./settings/state').then((m) => m.activeGoogleMapsApiKey)",
        "export const whole = async () => await import('./settings/state')",
        "export const language = async () => (await import('./settings/state')).locale",
      ]),
      plantedSource('src/components/shared/SettingsGoogleKeyField.tsx', [
        "import { googleMapsApiKey } from '../../app/settings/state'",
      ]),
      plantedSource('src/app/canvas-layer-presentation/presentation.ts', [
        "import { googleMapsApiKey } from '../settings/state'",
      ]),
      plantedSource('src/app/planted.test.ts', ["import { googleMapsApiKey } from './settings/state'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P46'))).toEqual([
      `${P46} src/app/planted.ts:1:1 imports src/app/settings/state.ts via "./settings/state" (static)`,
      `${P46} src/app/planted.ts:2:1 imports src/app/settings/projection.ts via "./settings/projection" (static)`,
      `${P46} src/app/planted.ts:3:1 imports src/app/settings/state.ts via "./settings/state" (static)`,
      `${P46} src/components/shared/Planted.tsx:1:1 imports src/app/settings/state.ts via "../../app/settings/state" (reexport)`,
      `${P46} src/app/dynamic.ts:1:39 imports src/app/settings/state.ts via "./settings/state" (dynamic)`,
      `${P46} src/app/dynamic.ts:2:87 imports src/app/settings/projection.ts via "./settings/projection" (dynamic)`,
      `${P46} src/app/dynamic.ts:3:23 imports src/app/settings/state.ts via "./settings/state" (dynamic)`,
      `${P46} src/app/dynamic.ts:4:40 imports src/app/settings/state.ts via "./settings/state" (dynamic)`,
    ])
  })

  it('P46b confines the Google key URL builders to the Satellite provider and tests', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/maplibre/basemap-tile-auth.ts', [
        'export function googleSessionRequestUrl() {}',
        'export function googleViewportRequestUrl() {}',
        "export const GOOGLE_SESSION_TILES = ''",
      ]),
      plantedSource('src/maplibre/satellite-provider.ts', ["import { GOOGLE_SESSION_TILES } from './basemap-tile-auth'"]),
      plantedSource('src/maplibre/satellite-provider-session.ts', [
        "import { googleSessionRequestUrl, googleViewportRequestUrl } from './basemap-tile-auth'",
      ]),
      plantedSource('src/maplibre/planted.ts', ["import { googleSessionRequestUrl } from './basemap-tile-auth'"]),
      plantedSource('src/__tests__/planted.test.ts', ["import { GOOGLE_SESSION_TILES } from '../maplibre/basemap-tile-auth'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P46b'))).toEqual([
      `${P46B} src/maplibre/planted.ts contains confined symbol googleSessionRequestUrl; allowed sources: src/maplibre/basemap-tile-auth.ts, src/maplibre/satellite-provider.ts, src/maplibre/satellite-provider-session.ts, ${TEST_SOURCES}`,
    ])
  })

  it('P47 rejects a component import of the canvas document surface, but not the named lens or other session surfaces', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/session.ts', [
        'export const currentCanvasDocumentSurface = 1',
        'export function getCurrentCanvasDocumentSurface() {}',
        'export const currentCanvasQuerySurface = 1',
      ]),
      plantedSource('src/components/canvas/Planted.tsx', [
        "import { currentCanvasQuerySurface, currentCanvasDocumentSurface } from '../../canvas/session'",
        "import { getCurrentCanvasDocumentSurface } from '../../canvas/session'",
        "import * as session from '../../canvas/session'",
        "import { currentCanvasQuerySurface as queries } from '../../canvas/session'",
        "export const lifecycle = async () => (await import('../../canvas/session')).currentCanvasDocumentSurface",
        "export const queries2 = async () => (await import('../../canvas/session')).currentCanvasQuerySurface",
      ]),
      plantedSource('src/components/canvas/InspectionLens.tsx', [
        "import { currentCanvasDocumentSurface } from '../../canvas/session'",
      ]),
      plantedSource('src/app/canvas-map-surface/design-reveal.ts', [
        "import { currentCanvasDocumentSurface } from '../../canvas/session'",
      ]),
      plantedSource('src/components/canvas/Planted.test.tsx', [
        "import { currentCanvasDocumentSurface } from '../../canvas/session'",
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P47'))).toEqual([
      `${P47} src/components/canvas/Planted.tsx:1:1 imports src/canvas/session.ts via "../../canvas/session" (static)`,
      `${P47} src/components/canvas/Planted.tsx:2:1 imports src/canvas/session.ts via "../../canvas/session" (static)`,
      `${P47} src/components/canvas/Planted.tsx:3:1 imports src/canvas/session.ts via "../../canvas/session" (static)`,
      `${P47} src/components/canvas/Planted.tsx:5:45 imports src/canvas/session.ts via "../../canvas/session" (dynamic)`,
    ])
  })

  it('P48 rejects a canvas context menu import outside the tool host and tests', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/interaction/canvas-context-menu.ts', ['export function createCanvasContextMenu() {}']),
      plantedSource('src/canvas/runtime/tools/tool-host.ts', [
        "import { createCanvasContextMenu } from '../interaction/canvas-context-menu'",
      ]),
      plantedSource('src/canvas/runtime/interaction-session.ts', [
        "import { createCanvasContextMenu } from './interaction/canvas-context-menu'",
      ]),
      plantedSource('src/app/canvas-context-menu/planted.ts', [
        "import type { createCanvasContextMenu } from '../../canvas/runtime/interaction/canvas-context-menu'",
      ]),
      plantedSource('src/__tests__/planted.test.ts', [
        "import { createCanvasContextMenu } from '../canvas/runtime/interaction/canvas-context-menu'",
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P48'))).toEqual([
      `${P48} src/canvas/runtime/interaction-session.ts:1:1 imports src/canvas/runtime/interaction/canvas-context-menu.ts via "./interaction/canvas-context-menu" (static); allowed importers: src/canvas/runtime/tools/tool-host.ts, ${TEST_SOURCES}`,
      `${P48} src/app/canvas-context-menu/planted.ts:1:1 imports src/canvas/runtime/interaction/canvas-context-menu.ts via "../../canvas/runtime/interaction/canvas-context-menu" (static); allowed importers: src/canvas/runtime/tools/tool-host.ts, ${TEST_SOURCES}`,
    ])
  })

  it('P49 confines invoke to ipc/, the two named files and tests, through a namespace or a dynamic import too', () => {
    const allowed = `src/ipc/**, src/app/shell/bootstrap.ts, src/app/canvas-pdf/platform.desktop.ts, ${TEST_SOURCES}`
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/ipc/species.ts', ["import { invoke } from '@tauri-apps/api/core'", "invoke('search')"]),
      plantedSource('src/app/shell/bootstrap.ts', ["import { invoke } from '@tauri-apps/api/core'", "invoke('health')"]),
      plantedSource('src/app/canvas-pdf/platform.desktop.ts', ["import { invoke } from '@tauri-apps/api/core'", "invoke('pdf')"]),
      plantedSource('src/app/planted.ts', ["import { invoke } from '@tauri-apps/api/core'", "void invoke('x')"]),
      plantedSource('src/components/Planted.tsx', ["import * as core from '@tauri-apps/api/core'", "void core.invoke('x')"]),
      plantedSource('src/web/planted.ts', ["void import('@tauri-apps/api/core').then((core) => core.invoke('x'))"]),
      plantedSource('src/app/planted.test.ts', ["import { invoke } from '@tauri-apps/api/core'", "void invoke('x')"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P49'))).toEqual([
      `${P49} src/app/planted.ts contains confined symbol invoke; allowed sources: ${allowed}`,
      `${P49} src/components/Planted.tsx contains confined symbol invoke; allowed sources: ${allowed}`,
      `${P49} src/web/planted.ts contains confined symbol invoke; allowed sources: ${allowed}`,
    ])
  })

  it('P52 rejects a location session importer outside the button, the Web wiring and tests', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/my-location/session.ts', ['export function startMyLocation() {}']),
      plantedSource('src/components/canvas/MyLocationButton.tsx', ["import { startMyLocation } from '../../app/my-location/session'"]),
      plantedSource('src/web/browser-workspace-map-contribution-adapter.ts', ["import { startMyLocation } from '../app/my-location/session'"]),
      plantedSource('src/app/my-location/session.test.ts', ["import { startMyLocation } from './session'"]),
      plantedSource('src/app/document-session/store.ts', ["import { startMyLocation } from '../my-location/session'"]),
      plantedSource('src/components/panels/ViewsPanel.tsx', ["import type { startMyLocation } from '../../app/my-location/session'"]),
    ])

    const allowed = `src/components/canvas/MyLocationButton.tsx, src/web/browser-workspace-map-contribution-adapter.ts, ${TEST_SOURCES}`
    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P52'))).toEqual([
      `${P52} src/app/document-session/store.ts:1:1 imports src/app/my-location/session.ts via "../my-location/session" (static); allowed importers: ${allowed}`,
      `${P52} src/components/panels/ViewsPanel.tsx:1:1 imports src/app/my-location/session.ts via "../../app/my-location/session" (static); allowed importers: ${allowed}`,
    ])
  })

  it('P53 rejects a geolocation call outside the geolocation module and tests, through optional chains, ! and brackets', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/app/my-location/geolocation.ts', [
        'export const watch = (on: PositionCallback) => navigator.geolocation.watchPosition(on)',
        'export const stop = (id: number) => navigator.geolocation.clearWatch(id)',
      ]),
      plantedSource('src/app/my-location/geolocation.test.ts', ['navigator.geolocation.getCurrentPosition(() => {})']),
      plantedSource('src/app/my-location/follow.ts', [
        'navigator.geolocation.watchPosition(() => {})',
        'globalThis.navigator?.geolocation?.getCurrentPosition(() => {})',
        "geo!['clearWatch'](3)",
        'surface.watch(() => {})',
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P53'))).toEqual([
      `${P53} src/app/my-location/follow.ts:1 calls navigator.geolocation.watchPosition`,
      `${P53} src/app/my-location/follow.ts:2 calls globalThis.navigator?.geolocation?.getCurrentPosition`,
      `${P53} src/app/my-location/follow.ts:3 calls geo!['clearWatch']`,
    ])
  })
})

const P54 = '[P54 the point editor and the path engine import only each other and types]'
const P56 = '[P56 only the row tool and its wiring write the device spacing interval]'
const P56_DRAFT = '[P56 only the canvas app adapter writes the device spacing draft]'

describe('plant along a path policies (canopi-f47t.54)', () => {
  it('P5 rejects a DOM, event or camera name in the path engine, which needs no import to reach one', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/plant-path/curve.ts', ['export const later = () => requestAnimationFrame(() => {})']),
      plantedSource('src/canvas/plant-path/curve.test.ts', ['document.body.dispatchEvent(new PointerEvent("pointerdown"))']),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P5'))).toEqual([
      `${P5_SYMBOLS} src/canvas/plant-path/curve.ts contains confined symbol requestAnimationFrame; allowed sources: src/canvas/runtime/tools/tool-host.ts, ${TEST_SOURCES}`,
    ])
  })

  it('P54 rejects a point editor or path engine import of a tool, the session or Preact, and a value import of a type home', () => {
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/view/types.ts', ['export type WorldPoint = { x: number }']),
      plantedSource('src/canvas/runtime/tools/draft.ts', ['export type ToolHandle = { id: string }', 'export const glyphs = 1']),
      plantedSource('src/canvas/runtime/tools/select/handle-size.ts', ['export type HandleSize = number']),
      plantedSource('src/canvas/runtime/interaction-types.ts', ['export type PointerKind = string']),
      plantedSource('src/canvas/runtime/scene/types.ts', ['export type ScenePoint = { x: number }']),
      plantedSource('src/canvas/runtime/tools/tool-host.ts', ['export const host = 1']),
      plantedSource('src/canvas/session-state.ts', ['export const session = 1']),
      plantedSource('src/canvas/plant-path/curve.ts', [
        "import type { WorldPoint } from '../runtime/view/types'",
        "import type { ScenePoint } from '../runtime/scene/types'",
        "import { CLOSE } from '../point-editor/rules'",
        "import { session } from '../session-state'",
      ]),
      plantedSource('src/canvas/point-editor/rules.ts', [
        "import type { PointerKind } from '../runtime/interaction-types'",
        'export const CLOSE = 1',
      ]),
      plantedSource('src/canvas/point-editor/layout.ts', [
        "import type { ToolHandle } from '../runtime/tools/draft'",
        "import type { HandleSize } from '../runtime/tools/select/handle-size'",
        "import { glyphs } from '../runtime/tools/draft'",
        "import { host } from '../runtime/tools/tool-host'",
        "import { h } from 'preact'",
        "import { signal } from '@preact/signals'",
        "import { curve } from '../plant-path/curve'",
      ]),
      plantedSource('src/canvas/point-editor/layout.test.ts', ["import { host } from '../runtime/tools/tool-host'"]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P54'))).toEqual([
      `${P54} src/canvas/plant-path/curve.ts:4:1 imports src/canvas/session-state.ts via "../session-state" (static)`,
      `${P54} src/canvas/point-editor/layout.ts:3:1 imports src/canvas/runtime/tools/draft.ts via "../runtime/tools/draft" (static)`,
      `${P54} src/canvas/point-editor/layout.ts:4:1 imports src/canvas/runtime/tools/tool-host.ts via "../runtime/tools/tool-host" (static)`,
      `${P54} src/canvas/point-editor/layout.ts:5:1 imports preact via "preact" (static)`,
      `${P54} src/canvas/point-editor/layout.ts:6:1 imports @preact/signals via "@preact/signals" (static)`,
    ])
  })

  it('P56 confines the device spacing interval writers and the settings draft write to the row tool and its wiring', () => {
    const allowed = [
      'src/canvas/runtime/tools/plant-row.ts',
      'src/canvas/runtime/tools/tool.ts',
      'src/canvas/runtime/interaction-session.ts',
      'src/canvas/runtime/scene-runtime.ts',
      'src/canvas/runtime/app-adapter.ts',
      'src/app/canvas-runtime/app-adapter.ts',
      TEST_SOURCES,
    ].join(', ')
    const graph = createTypeScriptSourceGraph([
      plantedSource('src/canvas/runtime/tools/plant-row.ts', ['ctx.settings.commitPlantSpacingIntervalM(2)']),
      plantedSource('src/app/canvas-runtime/app-adapter.ts', [
        'export const commitPlantSpacingIntervalM = (m: number) => m',
        'mutateSettingsProjection((settings) => { settings.plantSpacingIntervalM = 2 })',
      ]),
      plantedSource('src/canvas/runtime/tools/select/select-tool.ts', ['ctx.settings.commitPlantSpacingIntervalM(3)']),
      plantedSource('src/components/canvas/SelectionChip.tsx', ['surface.commitPlantSpacingIntervalM(3)']),
      plantedSource('src/canvas/runtime/command-surface.ts', ['adapter.settings.commitPlantSpacingIntervalMeters(3)']),
      plantedSource('src/components/canvas/SelectionChip.test.tsx', ['surface.commitPlantSpacingIntervalM(3)']),
      plantedSource('src/components/canvas/RowSpacingField.tsx', [
        'mutateSettingsProjection((d) => { d.plantSpacingIntervalM = 2 })',
        "mutateSettingsProjection((d) => { d['plantSpacingIntervalM'] = 2 })",
        'const local = { plantSpacingIntervalM: 2 }',
      ]),
    ])

    expect(collectArchitecturePolicyViolations(graph, canvasV2Policies('P56'))).toEqual([
      `${P56} src/canvas/runtime/tools/select/select-tool.ts contains confined symbol commitPlantSpacingIntervalM; allowed sources: ${allowed}`,
      `${P56} src/components/canvas/SelectionChip.tsx contains confined symbol commitPlantSpacingIntervalM; allowed sources: ${allowed}`,
      `${P56} src/canvas/runtime/command-surface.ts contains confined symbol commitPlantSpacingIntervalMeters; allowed sources: ${allowed}`,
      `${P56_DRAFT} src/components/canvas/RowSpacingField.tsx:1 writes d.plantSpacingIntervalM = 2`,
      `${P56_DRAFT} src/components/canvas/RowSpacingField.tsx:2 writes d['plantSpacingIntervalM'] = 2`,
    ])
  })
})

describe('map error logging', () => {
  it('routes every map-layer console write through the credential redactor', async () => {
    const { readdirSync } = await import('node:fs')
    const roots = ['../maplibre', '../app/canvas-map-surface']
    const offenders: string[] = []
    let scanned = 0
    for (const root of roots) {
      const dir = new URL(`${root}/`, import.meta.url)
      for (const name of readdirSync(dir)) {
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || name === 'redact-credentials.ts') continue
        scanned += 1
        const source = readFileSync(new URL(name, dir), 'utf8')
        if (/\bconsole\.(error|warn|log|info|debug)\b/.test(source)) offenders.push(`${root}/${name}`)
      }
    }
    // The map modules must have been found, or the check proves nothing.
    expect(scanned).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })
})

describe('one zone geometry', () => {
  // docs/guides/map-workspace.md: one zone geometry (canvas/runtime/zone-geometry.ts). A second shoelace drifts from it.
  it('declares polygonArea only in zone-geometry.ts', () => {
    const declaring = discoveredSourceGraph()
      .filter(({ path }) => !path.startsWith('src/__tests__/') && !/\.test\.tsx?$/.test(path))
      .filter(({ source }) => /\b(?:function\s+polygonArea|(?:const|let)\s+polygonArea\s*=)/.test(source))
      .map(({ path }) => path)

    expect(declaring).toEqual(['src/canvas/runtime/zone-geometry.ts'])
  }, 20_000)
})

/**
 * item-types.ts is the one place that knows library item types (canopi-f47t.42): nothing else in production spells
 * a RasterQuantity member as a string, so a new quantity is one table entry, never a scatter of branches.
 */
const RASTER_QUANTITY_HOMES = ['src/app/lidar/item-types.ts']

function rasterQuantityMembers(): readonly string[] {
  const path = 'src/generated/contracts.ts'
  const file = ts.createSourceFile(path, readFileSync(new URL('../generated/contracts.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest)
  const alias = file.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === 'RasterQuantity')
  if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error(`${path} no longer declares RasterQuantity as a union`)
  return alias.type.types.flatMap((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : [])
}

function rasterQuantityLiteralViolations(
  sources: readonly { readonly path: string; readonly source: string }[],
  members: readonly string[],
): string[] {
  const quantities = new Set(members)
  const violations: string[] = []
  for (const { path, source } of sources) {
    if (RASTER_QUANTITY_HOMES.includes(path) || path.startsWith('src/generated/')) continue
    if (path.startsWith('src/__tests__/') || /\.test\.tsx?$/.test(path)) continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && quantities.has(node.text)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        violations.push(`${path}:${line + 1} spells RasterQuantity '${node.text}'; ask item-types.ts instead`)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return violations
}

describe('library item types have one home (canopi-f47t.42)', () => {
  it('reads the RasterQuantity members from the generated contract', () => {
    expect(rasterQuantityMembers()).toEqual(expect.arrayContaining(['GroundElevation', 'OtherContinuous', 'Slope']))
  })

  it('rejects a planted RasterQuantity literal outside item-types.ts, generated contracts and tests', () => {
    const members = ['GroundElevation', 'OtherContinuous']
    expect(rasterQuantityLiteralViolations([
      plantedSource('src/components/panels/lidar/Planted.tsx', ["const other = quantity === 'OtherContinuous'"]),
      plantedSource('src/app/lidar/planted.ts', ['type Ground = `GroundElevation`', "const label = 'Ground elevation'"]),
      plantedSource('src/app/lidar/item-types.ts', ["const home = 'OtherContinuous'"]),
      plantedSource('src/generated/contracts.ts', ['export type RasterQuantity = "GroundElevation" | "OtherContinuous"']),
      plantedSource('src/__tests__/planted.test.ts', ["const fixture = 'GroundElevation'"]),
      plantedSource('src/app/lidar/planted.test.ts', ["const fixture = 'GroundElevation'"]),
    ], members)).toEqual([
      "src/components/panels/lidar/Planted.tsx:1 spells RasterQuantity 'OtherContinuous'; ask item-types.ts instead",
      "src/app/lidar/planted.ts:1 spells RasterQuantity 'GroundElevation'; ask item-types.ts instead",
    ])
  })

  it('keeps every production source free of RasterQuantity literals', () => {
    expect(rasterQuantityLiteralViolations(discoveredSourceGraph(), rasterQuantityMembers())).toEqual([])
  }, 20_000)
})
