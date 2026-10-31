// Planted violation of locale-key-typing (2.1-Q211): one unlisted cast to LocaleKey.
type LocaleKey = 'about.title'
declare function t(key: LocaleKey): string

export const plantedLabel = (name: string): string => t(`planted.${name}` as LocaleKey)
