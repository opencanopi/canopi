/**
 * platform/design-home.ts: L1 port for reading and durably writing Design homes
 * (2b-4; contracts §4, ADR 0027).
 */
import type { HomeRead, HomeVersion, HomeWrite } from '../generated/contracts'

export interface DesktopHomePort {
  read(key: string): Promise<HomeRead>
  write(
    key: string,
    bytes: Uint8Array,
    expected: HomeVersion | null,
    options?: { readonly keepPrevious?: boolean },
  ): Promise<HomeWrite>
}
