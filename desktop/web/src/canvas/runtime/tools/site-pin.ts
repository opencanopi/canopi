// canvas/runtime/tools/site-pin.ts
//
// Owns the Site data pin tool (`siteData.pin`, 2.1-Q364, 2.1-M164): click to pin a ground point, click again to move it.
// Edits nothing in the Design and settles the active map input request with the tapped world point.

import type { CanvasTool, ToolContext, ToolGesture, ToolReply } from './tool'

export function createSitePinTool(): CanvasTool {
  let ctx: ToolContext | null = null

  return {
    id: 'siteData.pin',
    activate(next) {
      ctx = next
    },
    deactivate() {
      ctx = null
    },
    gesture(g: ToolGesture): ToolReply {
      if (!ctx || ctx.view.mode !== 'site') return 'pass'
      if (g.kind === 'press') return 'handled'
      if (g.kind === 'tap') {
        ctx.effects.completeRequest(g.point.world)
        return 'handled'
      }
      return 'pass'
    },
    command(): ToolReply {
      return 'pass'
    },
    hasTransient: () => false,
    cancelTransient() {},
  }
}
