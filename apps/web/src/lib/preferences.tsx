import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Locale } from '@uxe/contracts';

/**
 * Presentation preferences for people who are not signed in yet.
 *
 * Everything here is a rendering choice — language, text size, contrast, motion — and
 * none of it identifies anybody, which is why it is safe to keep in local storage on a
 * sign-in screen. Nothing about a session, an entity or an address is stored.
 */

export type TextSize = 'default' | 'large' | 'xlarge';
export type Contrast = 'default' | 'high';
export type Motion = 'system' | 'reduced';

export interface Preferences {
  locale: Locale;
  textSize: TextSize;
  contrast: Contrast;
  motion: Motion;
}

const DEFAULTS: Preferences = {
  locale: 'en',
  textSize: 'default',
  contrast: 'default',
  motion: 'system',
};

const STORAGE_KEY = 'uxe-preferences';

interface PreferencesContextValue extends Preferences {
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  reset: () => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function read(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      locale: parsed.locale === 'ar' || parsed.locale === 'ja' ? parsed.locale : 'en',
      textSize:
        parsed.textSize === 'large' || parsed.textSize === 'xlarge' ? parsed.textSize : 'default',
      contrast: parsed.contrast === 'high' ? 'high' : 'default',
      motion: parsed.motion === 'reduced' ? 'reduced' : 'system',
    };
  } catch {
    // Private browsing can throw on access. Defaults are a working screen, not an error.
    return DEFAULTS;
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(read);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('lang', preferences.locale);
    root.setAttribute('dir', preferences.locale === 'ar' ? 'rtl' : 'ltr');
    // Absent rather than set to a default: an attribute selector for "default" would be
    // one more thing every rule had to say, and the base tokens already are the default.
    if (preferences.textSize === 'default') root.removeAttribute('data-text-size');
    else root.setAttribute('data-text-size', preferences.textSize);
    if (preferences.contrast === 'high') root.setAttribute('data-contrast', 'high');
    else root.removeAttribute('data-contrast');
    if (preferences.motion === 'reduced') root.setAttribute('data-motion', 'reduced');
    else root.removeAttribute('data-motion');

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Nothing here is worth failing a sign-in over.
    }
  }, [preferences]);

  const set = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
      setPreferences((current) => ({ ...current, [key]: value })),
    [],
  );

  const reset = useCallback(() => setPreferences(DEFAULTS), []);

  const value = useMemo<PreferencesContextValue>(
    () => ({ ...preferences, set, reset }),
    [preferences, set, reset],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside a PreferencesProvider');
  return context;
}

/** True when either the OS or the accessibility panel asks for less movement. */
export function usePrefersReducedMotion(): boolean {
  const { motion } = usePreferences();
  const [system, setSystem] = useState(
    () =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (event: MediaQueryListEvent) => setSystem(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  return motion === 'reduced' || system;
}
