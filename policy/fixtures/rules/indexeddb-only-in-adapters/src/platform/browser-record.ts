// The Web storage owner gets no IndexedDB exemption: its indexedDB use is a site.
export const open = () => indexedDB.open('planted')
