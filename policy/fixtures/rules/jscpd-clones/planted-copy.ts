export function plantedCloneCopy(rows: Array<{ id: string; width: number; height: number; label: string | null }>): string[] {
  const seen = new Map<string, number>()
  const out: string[] = []
  for (const row of rows) {
    const area = row.width * row.height
    const previous = seen.get(row.id) ?? 0
    seen.set(row.id, previous + area)
    if (row.label !== null && row.label.trim().length > 0) out.push(`${row.id}:${row.label.trim()}:${area.toFixed(2)}`)
    else out.push(`${row.id}:${area.toFixed(2)}`)
  }
  return out.sort((left, right) => left.localeCompare(right)).filter((value, index, all) => all.indexOf(value) === index)
}
