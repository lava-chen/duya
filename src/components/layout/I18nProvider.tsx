'use client';

import { createContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { type Locale, type TranslationKey, translate } from '@/i18n';
import { useSettings } from '@/hooks/useSettings';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  isLoading: boolean;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key) => key,
  isLoading: true,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings, loading: isLoading, save: saveSettings } = useSettings();
  const [locale, setLocaleState] = useState<Locale>('en');

  // Sync locale when settings load
  useEffect(() => {
    if (settings.locale) {
      const savedLocale = settings.locale as Locale;
      if (savedLocale === 'en' || savedLocale === 'zh') {
        setLocaleState(savedLocale);
      }
    }
  }, [settings.locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    saveSettings({ locale: newLocale }).catch(() => {});
  }, [saveSettings]);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, isLoading }}>
      {children}
    </I18nContext.Provider>
  );
}
