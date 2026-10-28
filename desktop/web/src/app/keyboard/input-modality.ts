// app/keyboard/input-modality.ts
//
// Whether the last input was a key press or a pointer press, recorded by the key router (the owner of key listeners,
// policy P8) at document capture. A button's tooltip shows on keyboard focus (components/shared/ButtonTooltip.tsx):
// WebKit's `:focus-visible` misses focus a script moves on a key (a rail's arrows, a menu closing on Esc), so a key as
// the last input counts too. Leaving the window clears it, so focus coming back with the window is no key's.
// It also records the held primary press (`button` 0, `isPrimary`), from the router's pointerdown to its pointerup or
// pointercancel, a window blur or a page hide: layout that would move controls under a finger or a held button waits
// for the press to end (components/shared/useMapChrome.ts useChromeRow), so the press's pointerup lands on the control
// it began on.

let keyLast = false

/** The key router's keydown capture. */
export function noteKeyPress(): void {
  keyLast = true
}

/** The key router's pointerdown capture, and its window blur and page hide. */
export function notePointerPress(): void {
  keyLast = false
}

/** Whether focus arriving now follows a key press rather than a pointer press. */
export function lastInputWasKey(): boolean {
  return keyLast
}

/** The pointer id of the held primary press, or null. */
let heldPress: number | null = null
/** Work waiting for the held press to end, one per owner: a later call replaces an earlier one. */
const afterPress = new Map<object, () => void>()

/** The key router's pointerdown capture, for a primary pointer's primary button. */
export function notePrimaryPressDown(pointerId: number): void {
  heldPress = pointerId
}

/** The key router's pointerup and pointercancel capture (the press's pointer), and, with no id, its window blur, page
 *  hide and disposal: a press can end where the page cannot see it. */
export function notePrimaryPressEnd(pointerId?: number): void {
  if (heldPress === null || (pointerId !== undefined && pointerId !== heldPress)) return
  heldPress = null
  // In a later task, after the press's own mouseup and click: their target is the control the press began on.
  setTimeout(() => {
    if (heldPress !== null) return
    const due = [...afterPress.values()]
    afterPress.clear()
    for (const apply of due) apply()
  }, 0)
}

/** Runs `apply` now, or once the held primary press ends. A later call for the same owner replaces a waiting one. */
export function afterPrimaryPress(owner: object, apply: () => void): void {
  if (heldPress !== null) {
    afterPress.set(owner, apply)
    return
  }
  afterPress.delete(owner)
  apply()
}
