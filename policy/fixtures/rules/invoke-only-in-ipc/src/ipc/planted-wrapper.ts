// The planted invoke-only-in-ipc violation inside ipc/ (F15): a wrapper that is not the transport invokes.
declare const invoke: (command: string) => Promise<unknown>
export const planted = () => invoke('planted_command')
