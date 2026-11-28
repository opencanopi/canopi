/**
 * types/command-transport.ts: L0 seam for overriding the native command transport
 * (used by the Gallery L5 root and tests without importing `ipc/` or `@tauri-apps/*`).
 */
import type { CommandName } from '../generated/command-map'
import type { OperationId } from '../generated/contracts'

export type CommandTransportHandler = (
  command: CommandName,
  args: Record<string, unknown> | undefined,
  operation: OperationId | undefined,
) => Promise<unknown>

let installedTransport: CommandTransportHandler | null = null
let installedAssetUrlResolver: ((path: string) => string) | null = null

/** Installs a custom command transport (e.g. the gallery's Partial<CommandMap> adapter). */
export function installCommandTransport(transport: CommandTransportHandler | null): () => void {
  const previous = installedTransport
  installedTransport = transport
  return () => {
    if (installedTransport === transport) installedTransport = previous
  }
}

/** Returns the active custom command transport, or null when using native Tauri invoke. */
export function activeCommandTransport(): CommandTransportHandler | null {
  return installedTransport
}

/** Installs a custom asset URL resolver (used by Gallery to pass Vite `?url` assets directly). */
export function installAssetUrlResolver(resolver: ((path: string) => string) | null): () => void {
  const previous = installedAssetUrlResolver
  installedAssetUrlResolver = resolver
  return () => {
    if (installedAssetUrlResolver === resolver) installedAssetUrlResolver = previous
  }
}

/** Resolves an asset path through an installed resolver, or returns null for default Tauri mapping. */
export function resolveAssetUrl(path: string): string | null {
  return installedAssetUrlResolver ? installedAssetUrlResolver(path) : null
}
