export const read = (text: string) => {
  try { return JSON.parse(text) } catch { return null }
}
