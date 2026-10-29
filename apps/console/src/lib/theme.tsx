import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** `system` follows the OS (`prefers-color-scheme`); the others force a theme. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** localStorage key. It only ever holds the theme preference, never anything sensitive. */
export const THEME_STORAGE_KEY = 'spine.theme';

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Reads the stored preference, tolerating blocked storage (private mode, sandboxed frames). */
export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the preference as `data-theme` on `<html>`; tokens.css does the rest. */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

/** Provides the theme preference and persists changes to localStorage. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);

  useEffect(() => applyTheme(preference), [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice still applies for this page view.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>
  );
}

/** Returns the theme preference and its setter. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
