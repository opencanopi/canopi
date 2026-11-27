import type { CanopiFile } from '../../types/design'

type DesignProjector = (design: CanopiFile) => CanopiFile

export interface DesignEditOptions {
  readonly coalesce?: string
}

export interface DesignEditAuthorityCapability {
  editCommitted(projector: DesignProjector, label?: string, options?: DesignEditOptions): CanopiFile | null
  endCoalesce(key: string): void
  reconcileCommitted(projector: DesignProjector): CanopiFile | null
  readCommitted(): CanopiFile | null
  readSessionIdentity(): object
  readDesignName(): string
  renameDesign(name: string, label?: string): boolean
}

const NO_AUTHORITY = 'Design Session store has no Design Edit authority'
const authorities = new WeakMap<object, DesignEditAuthorityCapability>()
const authorityDisposers = new WeakMap<object, () => void>()
const defaultOwnerHolder: { current: object | null } = { current: null }

export function registerDesignEditAuthorityCapability(
  owner: object,
  authority: DesignEditAuthorityCapability,
  dispose: () => void,
  isDefault = false,
): void {
  if (authorities.has(owner)) {
    throw new Error('Design Edit authority is already registered for this Design Session store')
  }
  authorities.set(owner, authority)
  authorityDisposers.set(owner, dispose)
  if (isDefault) defaultOwnerHolder.current = owner
}

function getAuthority(owner: object): DesignEditAuthorityCapability {
  const authority = authorities.get(owner)
  if (!authority) throw new Error(NO_AUTHORITY)
  return authority
}

function disposeAuthority(owner: object): void {
  const dispose = authorityDisposers.get(owner)
  if (!dispose) throw new Error(NO_AUTHORITY)
  dispose()
}

/** @testonly */
export function designEditAuthorityCapabilityForTests(
  owner: object,
): DesignEditAuthorityCapability {
  return getAuthority(owner)
}

export function hasDesignEditAuthority(): boolean {
  return defaultOwnerHolder.current !== null && authorities.has(defaultOwnerHolder.current)
}

export function defaultDesignEditAuthority(): DesignEditAuthorityCapability {
  if (!defaultOwnerHolder.current) throw new Error(NO_AUTHORITY)
  return getAuthority(defaultOwnerHolder.current)
}

/** @testonly */
export function disposeDesignEditAuthorityForTests(owner: object): void {
  disposeAuthority(owner)
}

export function disposeDefaultDesignEditAuthority(): void {
  if (defaultOwnerHolder.current) disposeAuthority(defaultOwnerHolder.current)
}
