// google-key-only-in-reviewed-readers: a reader inside src/app importing the key by a relative specifier.
import { googleMapsApiKey } from '../settings/state'
export const relative = googleMapsApiKey
