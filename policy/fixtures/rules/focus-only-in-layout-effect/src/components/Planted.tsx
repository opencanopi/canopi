// focus-only-in-layout-effect: a planted site the rule counts.
import { useEffect } from 'preact/hooks'
export function Planted({ field }: { field: HTMLInputElement }) {
  useEffect(() => {
    field.focus()
  }, [])
  return null
}
