export const read = () => localStorage.getItem('planted')
export const open = () => indexedDB.open('planted')
