export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return prefersDark() ? 'dark' : 'light';
  return preference;
}

/**
 * Writes the resolved theme onto <html>. The same attribute is set by the
 * bootstrap script in index.html before first paint, so this only ever
 * *changes* the value — it never introduces the first one.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  // Colour transitions stay off until after the first paint, otherwise the
  // initial mount animates from the browser default.
  requestAnimationFrame(() => root.setAttribute('data-theme-ready', ''));
  return resolved;
}

/** Re-applies the theme when the OS preference changes, while on `system`. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
