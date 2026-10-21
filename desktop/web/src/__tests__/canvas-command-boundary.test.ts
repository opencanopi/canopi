import { beforeAll, describe, expect, it } from 'vitest'
import { canvasCommandDefinitions } from '../app/canvas-commands'
import {
  createTypeScriptSourceGraph,
  discoverTypeScriptSourceGraph,
} from './support/architecture/source-facts'
import {
  collectArchitecturePolicyViolations,
  type ArchitecturePolicy,
} from './support/architecture/policy-harness'

const NEUTRAL_BOUNDARY_TARGETS = [
  '@tauri-apps/**',
  '#platform',
  'node:*',
  'src/web/**',
  'src/platform/**',
  'src/ipc/**',
  'src/**/*.browser.*',
  'src/**/*.desktop.*',
  'src/**/storage.ts',
  'src/**/storage/**',
  'src/**/*storage*.ts',
  '**/*storage*',
  'src/app/shell/**',
  'src/commands/graph/**',
] as const

const CANVAS_COMMAND_BOUNDARY_POLICIES = [
  {
    kind: 'forbid-nonliteral-dynamic-imports',
    name: 'Canvas Command Projection imports stay statically analyzable',
    from: ['src/app/canvas-commands/**'],
  },
  {
    kind: 'forbid-transitive-imports',
    name: 'Canvas Command Projection stays transitively platform-neutral',
    from: ['src/app/canvas-commands/**'],
    targets: NEUTRAL_BOUNDARY_TARGETS,
  },
  {
    kind: 'require-imports',
    name: 'Canvas command consumers use the neutral catalog',
    from: [
      'src/commands/graph/catalog.ts',
      'src/commands/graph/shortcuts.ts',
      'src/app/workspace-commands/canvas-actions.ts',
      'src/app/keyboard/keymap.ts',
    ],
    targets: ['src/app/canvas-commands/index.ts'],
  },
  {
    kind: 'require-imports',
    name: 'Web entry owns the browser Canvas shortcut lifecycle',
    from: ['src/main.web.tsx'],
    targets: ['src/web/browser-shell-commands.ts'],
  },
  {
    kind: 'source-tombstones',
    name: 'Retired Canvas command catalogs stay retired',
    symbols: [
      {
        from: ['src/commands/graph/projections.ts'],
        names: ['TOOLBAR_PRIMARY_TOOLS', 'TOOLBAR_CREATION_TOOLS'],
      },
      {
        from: ['src/commands/graph/shortcuts.ts'],
        names: ['TOOL_COMMAND_IDS'],
      },
      {
        from: ['src/commands/graph/shortcuts.ts'],
        names: ['canvasShortcutCommand'],
      },
    ],
  },
] satisfies readonly ArchitecturePolicy[]

let discoveredSourceGraph: ReturnType<typeof discoverTypeScriptSourceGraph> | null = null

function sourceGraph(): ReturnType<typeof discoverTypeScriptSourceGraph> {
  discoveredSourceGraph ??= discoverTypeScriptSourceGraph(new URL('../', import.meta.url), 'src')
  return discoveredSourceGraph
}

// Parsing the whole tree takes about 6 s idle and three times that under load:
// it runs once here, on its own budget, so no test's 20 s timeout pays it (canopi-l1jv).
beforeAll(() => {
  sourceGraph()
}, 120_000)

describe('Canvas Command Projection boundaries', () => {
  it('detects a forbidden platform dependency hidden behind a neutral helper', () => {
    const graph = createTypeScriptSourceGraph([
      {
        path: 'src/app/canvas-commands/index.ts',
        source: "import './helper'",
      },
      {
        path: 'src/app/canvas-commands/helper.ts',
        source: `
          import '@tauri-apps/api/core'
          import '#platform'
          import 'node:fs'
          import '../settings.browser'
        `,
      },
      { path: 'src/app/settings.browser.ts', source: 'export const settings = true' },
    ])
    const policy = {
      kind: 'forbid-transitive-imports',
      name: 'Canvas Command Projection stays transitively platform-neutral',
      from: ['src/app/canvas-commands/index.ts'],
      targets: NEUTRAL_BOUNDARY_TARGETS,
    } satisfies ArchitecturePolicy

    expect(collectArchitecturePolicyViolations(graph, [policy])).toEqual([
      '[Canvas Command Projection stays transitively platform-neutral] src/app/canvas-commands/index.ts transitively imports @tauri-apps/api/core via src/app/canvas-commands/index.ts -> src/app/canvas-commands/helper.ts -> @tauri-apps/api/core',
      '[Canvas Command Projection stays transitively platform-neutral] src/app/canvas-commands/index.ts transitively imports #platform via src/app/canvas-commands/index.ts -> src/app/canvas-commands/helper.ts -> #platform',
      '[Canvas Command Projection stays transitively platform-neutral] src/app/canvas-commands/index.ts transitively imports node:fs via src/app/canvas-commands/index.ts -> src/app/canvas-commands/helper.ts -> node:fs',
      '[Canvas Command Projection stays transitively platform-neutral] src/app/canvas-commands/index.ts transitively imports src/app/settings.browser.ts via src/app/canvas-commands/index.ts -> src/app/canvas-commands/helper.ts -> src/app/settings.browser.ts',
    ])
  })

  it('rejects opaque dynamic imports from the neutral module', () => {
    const graph = createTypeScriptSourceGraph([{
      path: 'src/app/canvas-commands/helper.ts',
      source: 'const target = "#platform"\nvoid import(target)',
    }])

    expect(collectArchitecturePolicyViolations(graph, [{
      kind: 'forbid-nonliteral-dynamic-imports',
      name: 'Canvas Command Projection imports stay statically analyzable',
      from: ['src/app/canvas-commands/**'],
    }])).toEqual([
      '[Canvas Command Projection imports stay statically analyzable] src/app/canvas-commands/helper.ts:2:6 imports <non-literal dynamic import: target> via "<non-literal dynamic import: target>" (dynamic)',
    ])
  })

  it('keeps the neutral projection transitively free of platform and shell dependencies', () => {
    expect(collectArchitecturePolicyViolations(
      sourceGraph(),
      CANVAS_COMMAND_BOUNDARY_POLICIES,
    )).toEqual([])
  }, 20_000)

  it('owns every projected command identity exhaustively', () => {
    const commandIds = canvasCommandDefinitions.map((definition) => definition.commandId)
    expect(new Set(commandIds).size).toBe(commandIds.length)
    expect(commandIds).toEqual([
      'canvas.tool.select',
      'canvas.tool.hand',
      'canvas.tool.plantStamp',
      'canvas.tool.plantSpacing',
      'canvas.tool.objectStamp',
      'canvas.tool.polygon',
      'canvas.tool.rectangle',
      'canvas.tool.ellipse',
      'canvas.tool.line',
      'canvas.tool.text',
      'canvas.tool.measurementGuide',
      'edit.undo',
      'edit.redo',
      'canvas.cut',
      'canvas.copy',
      'canvas.paste',
      'canvas.duplicateSelected',
      'canvas.deleteSelected',
      'canvas.selectAll',
      'canvas.selectSameSpecies',
      'canvas.clearSelection',
      'canvas.groupSelected',
      'canvas.ungroupSelected',
      'canvas.bringToFront',
      'canvas.sendToBack',
      'canvas.rotateSelected',
      'canvas.lockSelected',
      'canvas.unlockSelected',
      'canvas.unlockAll',
      'canvas.saveSelectionAsStamp',
      'view.zoomIn',
      'view.zoomOut',
      'view.fitToDesign',
      'view.zoomToSelection',
      'view.resetNorth',
      'view.turnViewLeft',
      'view.turnViewRight',
      'view.searchPlace',
      'view.cycleLabels',
      'canvas.toggleGrid',
      'canvas.toggleSnapToGrid',
    ])
  })

  it('registers Web shortcut teardown with the Vite HMR lifetime', () => {
    const shortcutLifecycle = sourceGraph()
      .find((source) => source.path === 'src/web/browser-shell-commands.ts')

    expect(shortcutLifecycle?.calls.some(
      (call) => call.target === 'import.meta.hot.dispose',
    )).toBe(true)
  })
})
