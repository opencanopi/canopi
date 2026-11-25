import type { CanopiFile } from '../../types/design'
import {
  defaultDesignEditAuthority,
  disposeDefaultDesignEditAuthority,
} from './authority-capability'

export function editCurrentDesign(
  updater: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return defaultDesignEditAuthority().editCommitted(updater)
}

/** The open Design as committed, for a command that decides before it edits. */
export function readCurrentDesign(): CanopiFile | null {
  return defaultDesignEditAuthority().readCommitted()
}

/** The open Design session's identity; session-only Design Edit state keys on it and goes with it. */
export function currentDesignSessionKey(): object {
  return defaultDesignEditAuthority().readSessionIdentity()
}

export function reconcileCurrentDesign(
  updater: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return defaultDesignEditAuthority().reconcileCommitted(updater)
}

export function setDesignName(name: string): void {
  const nextName = name.trim()
  if (nextName.length === 0) return
  const authority = defaultDesignEditAuthority()
  if (nextName === authority.readDesignName()) return

  authority.renameDesign(nextName)
}

export function editDesignArray<K extends keyof CanopiFile>(
  key: K,
  updater: (arr: CanopiFile[K]) => CanopiFile[K],
): void {
  editCurrentDesign((design) => {
    const next = updater(design[key])
    return next === design[key] ? design : { ...design, [key]: next }
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeDefaultDesignEditAuthority()
  })
}
