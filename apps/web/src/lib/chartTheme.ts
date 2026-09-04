import { useMemo } from 'react';
import { useSettings } from '@/providers/SettingsProvider';

/**
 * Recharts writes its colours as SVG presentation attributes, which cannot
 * carry a `var()` reference reliably. So the palette is read out of the live
 * design tokens once per theme and handed to the charts as plain rgb strings —
 * one source of truth, still correct after a theme flip.
 */
function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--c-${name}`).trim();
  return raw ? `rgb(${raw})` : fallback;
}

export interface ChartTheme {
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  brand: string;
  accent: string;
  danger: string;
  neutral: string;
  /** Scenario series, keyed by the scenario codes the API returns. */
  scenario: Record<string, string>;
}

export function useChartTheme(): ChartTheme {
  const { resolvedTheme } = useSettings();

  return useMemo<ChartTheme>(() => {
    const brand = readToken('navy-500', '#2a76b6');
    const accent = readToken('teal-600', '#0d9488');
    const danger = readToken('red-500', '#ef4444');
    const neutral = readToken('slate-400', '#94a3b8');

    return {
      grid: readToken('line', '#e4e9f0'),
      axis: readToken('slate-500', '#64748b'),
      tooltipBg: readToken('surface', '#ffffff'),
      tooltipBorder: readToken('line', '#e4e9f0'),
      tooltipText: readToken('slate-700', '#334155'),
      brand,
      accent,
      danger,
      neutral,
      scenario: { BASE: brand, UPSIDE: accent, DOWNSIDE: danger },
    };
    // `resolvedTheme` is not read inside the callback, but it *is* the input:
    // the token values `readToken` pulls off <html> change when it changes, so
    // it is exactly the right cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme]);
}

/** Shared Recharts `contentStyle` so every tooltip matches the surface tokens. */
export function tooltipStyle(theme: ChartTheme) {
  return {
    fontSize: 12,
    borderRadius: 10,
    border: `1px solid ${theme.tooltipBorder}`,
    backgroundColor: theme.tooltipBg,
    color: theme.tooltipText,
    boxShadow: '0 8px 24px -10px rgb(15 30 55 / 0.28)',
  };
}
