/**
 * Owner of Web's FileAccessPort and AppLifecyclePort (`no-cancelled-literal`, ADR 0024, ADR 0025; contracts §4, §22).
 * Production Web Draft persistence lives in `platform/design-home.browser.ts` (IndexedDB, 2.1-M21 / 2.1-M526).
 */
import type { AppLifecyclePort, LifecycleEvent } from '../../platform/app-lifecycle'
import type { FileAccessPort, PickFileOutcome } from '../../platform/file-access'

export const browserFileAccessPort: FileAccessPort = {
  async pickOpen(): Promise<PickFileOutcome> {
    return { kind: 'cancelled' }
  },
  async pickHomeTarget(): Promise<PickFileOutcome> {
    return { kind: 'cancelled' }
  },
}

export const browserAppLifecyclePort: AppLifecyclePort = {
  subscribe(listener: (event: LifecycleEvent) => void): () => void {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') listener({ kind: 'hidden' })
      else listener({ kind: 'shown', persisted: false })
    }
    const onPageHide = () => listener({ kind: 'hidden' })
    const onPageShow = (event: PageTransitionEvent) => listener({ kind: 'shown', persisted: event.persisted })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  },
}
