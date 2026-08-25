import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { Locale } from '@uxe/contracts';
import { en } from './locales/en.js';
import { ja, type Catalogue } from './locales/ja.js';

export type Messages = typeof en;
export type MessageKey = keyof Messages;

const CATALOGUES: Record<Locale, Catalogue> = { en, ja };

interface I18nContextValue {
  locale: Locale;
  /** Translate. Falls back to English, then to the key itself, so nothing renders blank. */
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  formatNumber: (value: number) => string;
  formatPercent: (value: number, fractionDigits?: number) => string;
  formatDate: (value: string | Date | null | undefined) => string;
  formatDateTime: (value: string | Date | null | undefined) => string;
  /** Text direction, so a future RTL locale is not architecturally blocked. */
  dir: 'ltr' | 'rtl';
}

const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) => {
      const template = CATALOGUES[locale]?.[key] ?? en[key] ?? String(key);
      if (!values) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      );
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t,
      formatNumber: (v) => new Intl.NumberFormat(locale).format(v),
      formatPercent: (v, fractionDigits = 0) =>
        new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: fractionDigits }).format(v),
      formatDate: (v) =>
        v ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(v)) : '—',
      formatDateTime: (v) =>
        v
          ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v))
          : '—',
      dir: RTL_LOCALES.has(locale) ? 'rtl' : 'ltr',
    }),
    [locale, t],
  );

  return (
    <I18nContext.Provider value={value}>
      <div dir={value.dir} className="contents">
        {children}
      </div>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside an I18nProvider');
  return context;
}
