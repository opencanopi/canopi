import { useLayoutEffect, useRef } from 'preact/hooks'

interface ElementRef<T extends HTMLElement> {
  readonly current: T | null
}

export function useFavoriteSpeciesDetailNavigation({
  active = true,
  canonicalName,
  detailRef,
  mainRef,
}: {
  readonly active?: boolean
  readonly canonicalName: string | null
  readonly detailRef: ElementRef<HTMLElement>
  readonly mainRef: ElementRef<HTMLElement>
}): void {
  const previousCanonicalName = useRef<string | null>(null)
  const originRef = useRef<HTMLButtonElement | null>(null)

  useLayoutEffect(() => {
    const main = mainRef.current
    if (!active || !main) return

    const rememberOrigin = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const origin = target.closest<HTMLButtonElement>('[data-species-detail]')
      if (origin && main.contains(origin)) originRef.current = origin
    }
    main.addEventListener('focusin', rememberOrigin)
    return () => main.removeEventListener('focusin', rememberOrigin)
  }, [active, mainRef])

  useLayoutEffect(() => {
    if (!active) {
      previousCanonicalName.current = null
      originRef.current = null
      return
    }

    if (canonicalName) {
      detailRef.current?.querySelector<HTMLElement>('[data-detail-back]')?.focus()
    } else if (previousCanonicalName.current) {
      const buttons = mainRef.current?.querySelectorAll<HTMLButtonElement>('[data-species-detail]') ?? []
      const rememberedOrigin = originRef.current
      const matchingOrigin = Array.from(buttons).find(
        (button) => button.dataset.speciesDetail === previousCanonicalName.current,
      )
      const origin = rememberedOrigin?.isConnected
        && rememberedOrigin.dataset.speciesDetail === previousCanonicalName.current
        ? rememberedOrigin
        : matchingOrigin
      ;(origin ?? mainRef.current?.querySelector<HTMLInputElement>('input[type="search"]'))
        ?.focus({ preventScroll: true })
      originRef.current = null
    }
    previousCanonicalName.current = canonicalName
  }, [active, canonicalName, detailRef, mainRef])
}
