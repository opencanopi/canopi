export const key = async () => (await import('./settings/state')).googleMapsApiKey
export const snapshot = async () => { const { snapshotSettingsProjection: s } = await import('./settings/projection'); return s }
export const active = import('./settings/state').then((m) => m.activeGoogleMapsApiKey)
export const whole = async () => await import('./settings/state')
export const language = async () => (await import('./settings/state')).locale
