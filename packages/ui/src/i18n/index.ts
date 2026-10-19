import en, { type TranslationKey } from './en';
import zh from './zh';

export type { TranslationKey };

export type Locale = 'en' | 'zh';

export const SUPPORTED_LOCALES: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  zh,
};

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[locale] ?? en;
  let text = dict[key] ?? en[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Both placeholder conventions exist in the dictionaries (`{{count}}`
      // and `{count}`); the double-brace form must win the alternation or it
      // degrades to `{5}`-style leftovers.
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}|\\{${k}\\}`, 'g'), String(v));
    }
  }

  return text;
}

export function getLocaleFromAcceptLanguage(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return 'en';

  const languages = acceptLanguage
    .split(',')
    .map((lang) => {
      const [code, qValue] = lang.trim().split(';q=');
      return {
        code: code.toLowerCase().split('-')[0],
        q: qValue ? parseFloat(qValue) : 1.0,
      };
    })
    .sort((a, b) => b.q - a.q);

  for (const { code } of languages) {
    if (code === 'zh') return 'zh';
    if (code === 'en') return 'en';
  }

  return 'en';
}

// ---------------------------------------------------------------------------
// Non-React translation (Plan 582)
// ---------------------------------------------------------------------------

/**
 * The locale the UI is currently rendering in, mirrored outside React.
 *
 * `useTranslation` is a hook, so anything that needs a string OUTSIDE the
 * component tree — Zustand stores, IPC adapters, the toast queue raised from
 * an async action — had no way to localize and ended up hard-coding Chinese,
 * which is simply wrong for the `en` locale. `I18nProvider` pushes its
 * current locale here on every change, and `t` reads it synchronously.
 *
 * Defaults to 'en' so a call made before the provider mounts produces an
 * English string rather than a key name.
 */
let activeLocale: Locale = 'en';

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

/** Translate outside React. See `setActiveLocale`. */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(activeLocale, key, params);
}
