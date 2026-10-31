declare const map: { isStyleLoaded(): boolean }
export const ready = () => map.isStyleLoaded()
