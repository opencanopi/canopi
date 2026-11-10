import i18n, { type TOptions } from "i18next";
import { effect } from "@preact/signals";
import { locale } from "../app/settings/state";
import type { LocaleKey } from "../generated/locale-keys";

import en from "./en.json";
import fr from "./fr.json";
import es from "./es.json";
import pt from "./pt.json";
import it from "./it.json";
import zh from "./zh.json";
import de from "./de.json";
import ja from "./ja.json";
import ko from "./ko.json";
import nl from "./nl.json";
import ru from "./ru.json";

/** Every interface language; the plant catalog carries names in each of them. */
export const SUPPORTED_LOCALES = ["en", "fr", "es", "pt", "it", "zh", "de", "ja", "ko", "nl", "ru"] as const;

i18n.init({
  lng: locale.value,
  fallbackLng: "en",
  supportedLngs: [...SUPPORTED_LOCALES],
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: en },
    fr: { translation: fr },
    es: { translation: es },
    pt: { translation: pt },
    it: { translation: it },
    zh: { translation: zh },
    de: { translation: de },
    ja: { translation: ja },
    ko: { translation: ko },
    nl: { translation: nl },
    ru: { translation: ru },
  },
});

// Sync locale signal → i18next
const disposeLocaleSync = effect(() => {
  i18n.changeLanguage(locale.value);
});

// Clean up on Vite HMR to prevent duplicate effects
if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeLocaleSync());
}

const fixedTranslations = new Map<string, typeof i18n.t>();

/**
 * The interface string for `key` in the observed locale (reading `locale` subscribes the caller). `key` is a
 * generated LocaleKey (bindings-gen, from en.json), so a key English lacks fails typecheck. A key computed at run
 * time is a typed table lookup (`Record<Id, LocaleKey>` declared `satisfies`, in the module that owns the ids) or a
 * template over a closed union; a value from an open set goes through `openSetText`. No code casts to LocaleKey (rule
 * locale-key-typing).
 */
export function t(key: LocaleKey, options?: TOptions): string {
  const currentLocale = locale.value;
  let fixedTranslation = fixedTranslations.get(currentLocale);
  if (!fixedTranslation) {
    fixedTranslation = i18n.getFixedT(currentLocale);
    fixedTranslations.set(currentLocale, fixedTranslation);
  }
  return options === undefined ? fixedTranslation(key) : fixedTranslation(key, options);
}

/**
 * Whether English holds `key` as a string, in every build: an open-set key is a family and a value, never the base of
 * plural forms, so only a string key narrows.
 */
function isLocaleKey(key: string): key is LocaleKey {
  return typeof i18n.getResource("en", "translation", key) === "string";
}

/** A LocaleKey's family, up to and including its first `_`: `filters.habit_` for `filters.habit_Tree`. */
export type LocaleKeyFamily = LocaleKey extends infer Key ? (Key extends `${infer Family}_${string}` ? `${Family}_` : never) : never;

/**
 * The text of `value`, a member of an open set such as a catalog value, in its key `family`, or `fallback` when English
 * has no key for it yet. The family is typed, so a family English lacks fails typecheck; the value must be typed
 * `string`, so a literal or a closed union fails typecheck: its fallback would hide a misspelled key, and a known text
 * is `t(key)` or a typed table lookup. No call is a counted site (rule locale-key-typing).
 */
export function openSetText<Value extends string>(
  family: LocaleKeyFamily,
  value: string extends Value ? Value : never,
  fallback: string = value,
): string {
  const key = `${family}${value}`;
  return isLocaleKey(key) ? t(key) : fallback;
}
