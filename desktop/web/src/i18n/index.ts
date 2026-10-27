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
 * time is a typed table lookup (`Record<Id, LocaleKey>` declared `satisfies`, in the module that owns the ids), or
 * the one counted escape, `dynamicLocaleKey` (rule locale-key-typing).
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
 * A key computed at run time as a LocaleKey: the one counted escape from typed keys (rule locale-key-typing, one
 * ratchet entry per file that calls it). Under test and in development a key absent from English throws, naming it;
 * production returns it unchanged, and i18next shows a missing key as itself.
 */
export function dynamicLocaleKey(key: string): LocaleKey {
  if (!import.meta.env.PROD && !isLocaleKey(key)) {
    throw new Error(`"${key}" is no key of the English interface strings (desktop/web/src/i18n/en.json)`);
  }
  return key as LocaleKey;
}

/**
 * Whether English holds `key`, as a string or as the base of plural forms (`_other` is in every English plural). For
 * a key built from an open set, such as a catalog value, whose absence the caller shows another way:
 * `isLocaleKey(key) ? t(key) : value`. Not an escape: it narrows only a key English holds, in every build.
 */
export function isLocaleKey(key: string): key is LocaleKey {
  return i18n.exists(key, { lng: "en", fallbackLng: false }) || i18n.exists(key, { lng: "en", fallbackLng: false, count: 2 });
}
