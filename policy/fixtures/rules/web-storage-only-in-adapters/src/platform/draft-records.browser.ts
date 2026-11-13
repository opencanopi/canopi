// The IndexedDB owner is exempt from indexeddb-only-in-adapters only: its Web storage use is still a site.
export const read = () => localStorage.getItem('planted')
