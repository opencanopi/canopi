// app/problem-report/design-consent.ts
//
// Owner of whether Report a problem may attach the open Design (canopi-v4kj; 2.1-M479, Q337). Invariant: a Design a
// newer Canopi saved is open as the format core's read view, never the user's file, so no report attaches it: the
// dialog leaves its Design row out, the submission never asks for it, and both editions' writers return null. A
// storage-unchecked read-only Draft (a 2.0 Draft read without loss) and every editing session attach as before.
import { designSessionStore, readOnlyOrigin, type ReadOnlyOrigin } from '../document-session/store'

/** Whether a session read-only from `origin` (undefined: editing) holds a Design a report may attach. */
export function designAttachable(origin: ReadOnlyOrigin | undefined): boolean {
  return origin !== 'newer-version'
}

/** `designAttachable` for the app's Design session; read in a render, it redraws when the session kind changes. */
export function currentDesignAttachable(): boolean {
  return designAttachable(readOnlyOrigin(designSessionStore.sessionKind.value))
}
