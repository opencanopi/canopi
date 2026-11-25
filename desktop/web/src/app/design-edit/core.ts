import type { CanopiFile } from '../../types/design'
import {
  defaultDesignEditAuthority,
  disposeDefaultDesignEditAuthority,
} from './authority-capability'

export function editCurrentDesign(
  updater: (design: CanopiFile) => CanopiFile,
  label = 'edit',
): CanopiFile | null {
  return defaultDesignEditAuthority().editCommitted(updater, label)
}

/** The open Design as committed, for a command that decides before it edits. */
export function readCurrentDesign(): CanopiFile | null {
  return defaultDesignEditAuthority().readCommitted()
}

export function reconcileCurrentDesign(
  updater: (design: CanopiFile) => CanopiFile,
): CanopiFile | null {
  return defaultDesignEditAuthority().reconcileCommitted(updater)
}

export function setDesignName(name: string, label = 'rename'): void {
  const nextName = name.trim()
  if (nextName.length === 0) return
  const authority = defaultDesignEditAuthority()
  if (nextName === authority.readDesignName()) return

  authority.renameDesign(nextName, label)
}

export function editDesignArray<K extends keyof CanopiFile>(
  key: K,
  updater: (arr: CanopiFile[K]) => CanopiFile[K],
  label: string = String(key),
): void {
  editCurrentDesign((design) => {
    const next = updater(design[key])
    return next === design[key] ? design : { ...design, [key]: next }
  }, label)
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeDefaultDesignEditAuthority()
  })
}
