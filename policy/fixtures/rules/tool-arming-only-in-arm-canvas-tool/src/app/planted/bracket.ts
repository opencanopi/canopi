// tool-arming-only-in-arm-canvas-tool: a surface setTool called by bracket access from app code.
declare const commands: { setTool(tool: string): void } | undefined
commands!['setTool']('rectangle')
