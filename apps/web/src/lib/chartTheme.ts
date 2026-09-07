import { useMemo } from 'react';

/**
 * Recharts writes its colours as SVG presentation attributes, which cannot
 * carry a `var()` reference reliably. So the palette is read out of the live
 * design tokens and handed to the charts as plain rgb strings — the tokens stay
 * the single source of truth for chart colour as well as for the UI.
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
  return useMemo<ChartTheme>(() => {
    const brand = readToken('navy-600', '#1f5f9b');
    const accent = readToken('teal-600', '#0d9488');
    const danger = readToken('red-500', '#ef4444');
    const neutral = readToken('slate-300', '#cbd3e0');

    return {
      grid: readToken('line', '#e3e8f0'),
      axis: readToken('slate-500', '#6b7789'),
      tooltipBg: readToken('surface', '#ffffff'),
      tooltipBorder: readToken('line', '#e3e8f0'),
      tooltipText: readToken('slate-700', '#38455a'),
      brand,
      accent,
      danger,
      neutral,
      scenario: { BASE: brand, UPSIDE: accent, DOWNSIDE: danger },
    };
  }, []);
}

/** Shared Recharts `contentStyle` so every tooltip matches the surface tokens. */
export function tooltipStyle(theme: ChartTheme) {
  return {
    fontSize: 12,
    borderRadius: 12,
    border: `1px solid ${theme.tooltipBorder}`,
    backgroundColor: theme.tooltipBg,
    color: theme.tooltipText,
    padding: '8px 10px',
    boxShadow: '0 8px 24px -10px rgb(14 32 56 / 0.28)',
  };
}
