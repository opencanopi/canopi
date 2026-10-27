export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '')
