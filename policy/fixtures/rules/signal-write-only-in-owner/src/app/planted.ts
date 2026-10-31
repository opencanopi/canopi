// A planted violation of signal-write-only-in-owner: a write to a signal another module declares.
import { theme } from './settings/state'
export const plantedDarken = (): void => { theme.value = 'dark' }
