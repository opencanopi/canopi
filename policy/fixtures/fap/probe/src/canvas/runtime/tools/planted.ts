export function planted(event: PointerEvent, key: KeyboardEvent, element: HTMLElement) {
  const box = element.getBoundingClientRect()
  window.addEventListener(key.type, () => requestAnimationFrame(() => document.title = `${event.clientX - box.x}`))
}
export interface Planted { readonly view: ViewTransform; readonly driver: CameraDriver; readonly nav: ViewNavigation }
