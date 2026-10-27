import { signal } from '@preact/signals'
import { snapToGridEnabled } from './canvas-settings/signals'
import { sidePanelWidth } from './shell/state'
import * as settings from './settings/state'
import { locale, scrollWheel } from './settings/state'
import { mapLayers } from './map-layers/state'
declare const next: never[]
const localCount = signal(0)
snapToGridEnabled.value = true
sidePanelWidth.value += 10
settings.googleMapsApiKey.value = null
mapLayers.value = next
scrollWheel.value++
if (locale.value === 'fr') void 0
localCount.value = 1
